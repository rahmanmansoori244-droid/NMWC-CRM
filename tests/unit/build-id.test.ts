/**
 * scripts/dev/build-id.cjs: how a deploy is told from the one before (2026-11-22).
 *
 * The first Next 16 production deploy (main d959840) showed that a Next 16 page no
 * longer carries the Next build ID the script read (the "b" field of the RSC payload),
 * so deploy-watch.sh would have waited 15 minutes and reported a good deploy as failed.
 * The script now reads Vercel's deployment ID: Next 16 writes it on <html data-dpl-id>,
 * a Next 15 page carries it on its asset URLs (?dpl=), so a rollback to a Next 15
 * deployment still reads. The page shapes below are trimmed from the live /login pages
 * of 2026-11-22 (Next 16: dpl_13pz…, Next 15: dpl_3SCw… / build PWX4…).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const req = createRequire(import.meta.url);
const { deploymentIdentity, scriptSources, commitFromScript } = req('../../scripts/dev/build-id.cjs') as {
  deploymentIdentity: (html: string) => { value?: string; reason?: string };
  scriptSources: (html: string) => string[];
  commitFromScript: (js: string) => string | null;
};

const NEXT16 =
  '<!DOCTYPE html><html data-dpl-id="dpl_13pzCnKcj6etf7jJbkVpTgVHSe5D" lang="en" class="h-full"><head>' +
  '<script src="/_next/static/immutable/chunks/12d7o48guhyuc.js" async=""></script>' +
  '<script src="/_next/static/immutable/chunks/391tlx1wng6aw.js" async=""></script></head>' +
  '<body><script>self.__next_f.push([1,"0:{\\"P\\":null,\\"c\\":[\\"\\",\\"login\\"],\\"q\\":\\"\\"}"])</script></body></html>';

const NEXT15 =
  '<!DOCTYPE html><html lang="en" class="h-full"><head>' +
  '<link rel="stylesheet" href="/_next/static/css/a1.css?dpl=dpl_3SCw8m5eELq8pXKqViqp2GpD11Zp"/>' +
  '<script src="/_next/static/chunks/webpack-1.js?dpl=dpl_3SCw8m5eELq8pXKqViqp2GpD11Zp" async=""></script></head>' +
  '<body><script>self.__next_f.push([1,"0:{\\"P\\":null,\\"b\\":\\"PWX4KizH6DAGD1NCNrIEf\\",\\"p\\":\\"\\"}"])</script></body></html>';

describe('deploymentIdentity', () => {
  it('a Next 16 page: the deployment ID on <html data-dpl-id>', () => {
    expect(deploymentIdentity(NEXT16)).toEqual({ value: 'dpl_13pzCnKcj6etf7jJbkVpTgVHSe5D' });
  });

  it('a Next 15 page: the same kind of ID, from its asset URLs (so a rollback to it is seen)', () => {
    expect(deploymentIdentity(NEXT15)).toEqual({ value: 'dpl_3SCw8m5eELq8pXKqViqp2GpD11Zp' });
  });

  it('a Next 15 page with no deployment ID (not on Vercel): its Next build ID, as before', () => {
    const noDpl = NEXT15.replace(/\?dpl=dpl_[A-Za-z0-9]+/g, '');
    expect(deploymentIdentity(noDpl)).toEqual({ value: 'PWX4KizH6DAGD1NCNrIEf' });
  });

  it('two different deployment IDs on one page: refused, never guessed', () => {
    const mixed = NEXT16.replace('</head>', '<link href="/x.css?dpl=dpl_3SCw8m5eELq8pXKqViqp2GpD11Zp"/></head>');
    expect(deploymentIdentity(mixed).value).toBeUndefined();
    expect(deploymentIdentity(mixed).reason).toMatch(/2 different deployment IDs/);
  });

  it('a page with neither (an error page, Vercel’s own placeholder): nothing, with the reason', () => {
    const r = deploymentIdentity('<!DOCTYPE html><html lang="en"><body>Not found</body></html>');
    expect(r.value).toBeUndefined();
    expect(r.reason).toMatch(/no deployment ID or build ID/);
  });
});

describe('the commit from the page code', () => {
  const SHA = 'd959840d0e495a66476636c04b8081a2fc8c3b71';

  it('scriptSources: the page’s own scripts, each once, in order', () => {
    expect(scriptSources(NEXT16 + NEXT16)).toEqual([
      '/_next/static/immutable/chunks/12d7o48guhyuc.js',
      '/_next/static/immutable/chunks/391tlx1wng6aw.js',
    ]);
  });

  it('commitFromScript: the inlined Sentry release', () => {
    const js = `,enabled:!0,tracesSampleRate:.1,environment:"production",release:"${SHA}",integrations:[]`;
    expect(commitFromScript(js)).toBe(SHA);
  });

  it('commitFromScript: no release, an empty one (a build with no VERCEL_GIT_COMMIT_SHA), or two different ones: null', () => {
    expect(commitFromScript('environment:"production",integrations:[]')).toBeNull();
    expect(commitFromScript('environment:"production",release:"",integrations:[]')).toBeNull();
    expect(commitFromScript(`release:"${SHA}",x,release:"${'a'.repeat(40)}"`)).toBeNull();
  });
});

describe('deploy-watch.sh uses it', () => {
  // Comments stripped: a comment naming the call must not satisfy the check.
  const src = readFileSync(join(process.cwd(), 'scripts/dev/deploy-watch.sh'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('waits for the deployment ID from build-id.cjs to change, and then reads the commit', () => {
    expect(src).toMatch(/NEW=\$\(node "\$HERE\/build-id\.cjs" 2>\/dev\/null\)/);
    expect(src).toMatch(/LIVE=\$\(node "\$HERE\/build-id\.cjs" --commit 2>\/dev\/null\)/);
    expect(src.indexOf('--commit')).toBeGreaterThan(src.indexOf('CHANGED=1'));
  });

  it('a different commit live fails the watch; an unreadable one only warns', () => {
    expect(src).toMatch(/production serves \$LIVE, not \$SHA"\n\s*FAIL=1/);
    expect(src).toMatch(/WARN {2}the commit could not be read/);
  });
});
