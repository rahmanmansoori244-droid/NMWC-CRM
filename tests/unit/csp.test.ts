// @vitest-environment node
/**
 * SEC-14b — the Content-Security-Policy, which nothing asserted.
 *
 * Two policies existed and were written out by hand: the per-request one with a
 * nonce in middleware.ts, and a stricter static fallback in next.config.ts. The
 * security-remediation record asked for a regression test on exactly that
 * duplication, and none was ever written, so they drifted — neither declared
 * `base-uri`, `form-action` or `object-src`.
 *
 * The one to read twice is the nonce-extractor test at the bottom. Next finds the
 * nonce with `directives.find(d => d.startsWith('script-src'))` over the split
 * header, so a directive named `script-src-elem` placed AHEAD of `script-src`
 * returns the wrong one, the nonce comes back undefined, and Next stops stamping
 * its inline bootstrap: production renders blank. That is the failure the
 * CHANGELOG records being reverted under pressure, and nothing pinned it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCsp } from '@/lib/csp';
import nextConfig from '@/next.config';

/** `name value` pairs, in order, exactly as a browser would split them. */
function parse(csp: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const seg of csp.split(';')) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf(' ');
    out.set(i === -1 ? s : s.slice(0, i), i === -1 ? '' : s.slice(i + 1).trim());
  }
  return out;
}

function names(csp: string): string[] {
  return [...parse(csp).keys()];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the directives SEC-14b added', () => {
  it.each([
    ['the static fallback', () => buildCsp()],
    ['the per-request policy', () => buildCsp('n0nce')],
  ])('%s declares base-uri, object-src, form-action and frame-ancestors', (_label, make) => {
    const d = parse(make());
    // form-action and base-uri do NOT fall back to default-src, so their absence
    // was a real gap. object-src DID fall back to default-src 'self' — this is a
    // tightening to 'none', not a bypass being closed.
    expect(d.get('form-action')).toBe("'self'");
    expect(d.get('base-uri')).toBe("'none'");
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('frame-ancestors')).toBe("'none'");
  });
});

describe('connect-src reaches everywhere the browser actually talks to', () => {
  it('allows all three Sentry ingest hosts, not just one region', () => {
    // A `*.`-prefixed CSP host source matches only hosts ENDING with the rest of
    // the string, so `*.ingest.sentry.io` does NOT cover the US regional host.
    // Only the EU one was listed, and US is the region Sentry assigns by default
    // to organisations created since 2024 — so a US DSN meant every browser error
    // and every sampled transaction was refused, silently, while the user was
    // shown a reference number for a report that never existed.
    const c = parse(buildCsp('n')).get('connect-src') ?? '';
    for (const host of [
      'https://*.ingest.sentry.io',
      'https://*.ingest.us.sentry.io',
      'https://*.ingest.de.sentry.io',
    ]) {
      expect(c).toContain(host);
    }
  });

  it('allows the R2 bucket the photo upload PUTs to, and itself', () => {
    const c = parse(buildCsp('n')).get('connect-src') ?? '';
    expect(c).toContain("'self'");
    expect(c).toContain('.r2.cloudflarestorage.com');
  });
});

describe('the two policies stay in step', () => {
  it('declare exactly the same directive names', () => {
    // The drift guard. They are built by one function now, but the point is that
    // a future edit adding a directive to only one branch fails here.
    expect(names(buildCsp())).toEqual(names(buildCsp('n0nce')));
  });

  it('differ in exactly one directive value, script-src', () => {
    const a = parse(buildCsp());
    const b = parse(buildCsp('n0nce'));
    const differing = [...a.keys()].filter((k) => a.get(k) !== b.get(k));
    expect(differing).toEqual(['script-src']);
  });

  it('are well-formed: no duplicate directive, every segment a name plus a value', () => {
    for (const csp of [buildCsp(), buildCsp('n0nce')]) {
      const raw = csp
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      const keys = raw.map((s) => s.split(' ')[0]);
      expect(new Set(keys).size).toBe(keys.length);
      for (const seg of raw) expect(seg).toMatch(/^[a-z-]+ .+$/);
    }
  });
});

describe('script-src and the nonce plumbing are untouched', () => {
  it('the fallback allows exactly self, in either environment', () => {
    for (const env of ['production', 'development']) {
      vi.stubEnv('NODE_ENV', env);
      expect(parse(buildCsp()).get('script-src')).toBe("'self'");
    }
  });

  it('carries the nonce and strict-dynamic when given one', () => {
    const s = parse(buildCsp('abc123')).get('script-src') ?? '';
    expect(s).toContain("'nonce-abc123'");
    expect(s).toContain("'strict-dynamic'");
  });

  it('allows unsafe-eval in development only, and never without a nonce', () => {
    // `next dev` evaluates source-mapped modules via eval(); without this nothing
    // hydrates locally, which is how the go-live browser walk found it.
    vi.stubEnv('NODE_ENV', 'development');
    expect(buildCsp('n')).toContain("'unsafe-eval'");
    expect(buildCsp()).not.toContain("'unsafe-eval'");
    vi.stubEnv('NODE_ENV', 'production');
    expect(buildCsp('n')).not.toContain("'unsafe-eval'");
    expect(buildCsp()).not.toContain("'unsafe-eval'");
  });

  it("Next's nonce extractor still finds the nonce", () => {
    // Re-implements get-script-nonce-from-header exactly. If a directive whose
    // name merely STARTS WITH script-src is ever ordered ahead of script-src,
    // this returns the wrong directive and production goes blank.
    const csp = buildCsp('n0nce');
    const directive = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src'));
    expect(directive).toBeDefined();
    expect(/'nonce-([^']+)'/.exec(directive ?? '')?.[1]).toBe('n0nce');
  });
});

describe('next.config wiring', () => {
  it('serves the shared builder as its CSP header, not a second hand-written copy', async () => {
    const entries = await nextConfig.headers!();
    const all = entries.flatMap((e) => e.headers);
    const csp = all.filter((h) => h.key.toLowerCase() === 'content-security-policy');
    expect(csp).toHaveLength(1);
    expect(csp[0]!.value).toBe(buildCsp());
    // nosniff is what makes the SEC-14e type pin safe; assert it here too, since
    // this is the file that knows about these headers.
    expect(all.find((h) => h.key === 'X-Content-Type-Options')?.value).toBe('nosniff');
  });

  it('still lints services/, which is what makes the audit guard real', () => {
    // tests/unit/audit-guard.test.ts leaves this to a human. If next.config ever
    // fails to load, eslint.dirs goes with it and the DG-06 guard stops walking
    // services/ while lint stays green.
    expect(nextConfig.eslint?.dirs).toContain('services');
    expect(nextConfig.eslint?.dirs).toContain('app');
    expect(nextConfig.eslint?.dirs).toContain('lib');
  });
});
