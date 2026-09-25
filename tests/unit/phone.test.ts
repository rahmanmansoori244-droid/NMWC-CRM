import { describe, it, expect } from 'vitest';
import { normalizePhone, isValidPhoneFormat } from '@/lib/phone';
import { normalizeCR } from '@/lib/cr';

describe('lib/phone — Oman phone normalization', () => {
  it('8-digit local mobile → +968XXXXXXXX', () => {
    expect(normalizePhone('99758980')).toBe('+96899758980');
  });
  it('with spaces and dashes', () => {
    expect(normalizePhone('99 75 89 80')).toBe('+96899758980');
    expect(normalizePhone('99-75-89-80')).toBe('+96899758980');
  });
  // UXI-006 — Arabic-Indic digits should normalize to ASCII canonical form
  it('Arabic-Indic digits', () => {
    expect(normalizePhone('٩٩٧٥٨٩٨٠')).toBe('+96899758980');
    expect(normalizePhone('٩٩ ٧٥ ٨٩ ٨٠')).toBe('+96899758980');
  });
  // UXI-006 — ambiguous lengths (12 digits, 6 digits) must reject loudly
  it('rejects ambiguous lengths', () => {
    expect(normalizePhone('123456')).toBeNull();
    expect(normalizePhone('123456789012')).toBeNull();
  });
  it('country code 968 prefix', () => {
    expect(normalizePhone('96899758980')).toBe('+96899758980');
    expect(normalizePhone('+96899758980')).toBe('+96899758980');
  });
  it('00968 prefix', () => {
    expect(normalizePhone('0096899758980')).toBe('+96899758980');
  });
  it('returns null for empty / nullish', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
  });
});

describe('lib/phone — format validator', () => {
  it('accepts plausible inputs', () => {
    expect(isValidPhoneFormat('99758980')).toBe(true);
    expect(isValidPhoneFormat('+968 99 75 89 80')).toBe(true);
    expect(isValidPhoneFormat('99 75-89(80)')).toBe(true);
  });
  it('rejects letters and short / long', () => {
    expect(isValidPhoneFormat('not-a-phone')).toBe(false);
    expect(isValidPhoneFormat('123')).toBe(false);
    expect(isValidPhoneFormat('1234567890123456789012345')).toBe(false);
  });
});

describe('lib/cr — CR normalization', () => {
  // UXI-014: PRD §8 says strip whitespace + uppercase only. Hyphens / slashes
  // / underscores were previously also stripped which collapsed `1234567/2024`
  // and `12345672024` to the same value (false-positive dedupe matches).
  it('strips whitespace + uppercases — preserves other punctuation', () => {
    expect(normalizeCR('1234567')).toBe('1234567');
    expect(normalizeCR('1234567-OM')).toBe('1234567-OM');
    expect(normalizeCR(' 12 345 67 ')).toBe('1234567');
    expect(normalizeCR('cr_1234-567')).toBe('CR_1234-567');
    expect(normalizeCR('1234567/2024')).toBe('1234567/2024');
  });

  // Benchmark item 16: the duplicate detector groups on the stored norm, so what
  // this function folds decides which customers are ever paired.
  it('empty, missing and whitespace-only CRs are no CR at all — so they never group', () => {
    expect(normalizeCR(null)).toBeNull();
    expect(normalizeCR(undefined)).toBeNull();
    expect(normalizeCR('')).toBeNull();
    expect(normalizeCR(' \t\n  ')).toBeNull();
  });

  it('strips every kind of whitespace, everywhere in the value', () => {
    expect(normalizeCR('12\t34\n5 6  7')).toBe('1234567');
    expect(normalizeCR('123 4567')).toBe('1234567'); // no-break space, as pasted from Excel
  });

  it('two CRs differing only in punctuation or a leading zero stay different', () => {
    expect(normalizeCR('1234567/2024')).not.toBe(normalizeCR('12345672024'));
    expect(normalizeCR('01234567')).toBe('01234567');
    expect(normalizeCR('01234567')).not.toBe(normalizeCR('1234567'));
  });

  // Owner decision 2026-09-25 (item 16): a CR typed on an Arabic keyboard, or
  // pasted with an invisible character in it, is the same CR as its plain ASCII
  // twin — in the duplicate detector and in the create-time CR block alike, since
  // both compare this function's output. Stored norms written before this are
  // corrected by scripts/ops/recompute-cr-norm.ts.
  it('Arabic-Indic and Persian digits fold to ASCII', () => {
    expect(normalizeCR('\u0661\u0662\u0663\u0664\u0665\u0666\u0667')).toBe('1234567');
    expect(normalizeCR('\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7')).toBe('1234567');
    expect(normalizeCR('\u0660\u0669')).toBe('09'); // both ends of the Arabic-Indic block
    expect(normalizeCR('\u06F0\u06F9')).toBe('09'); // and of the Persian block
    // Mixed with ASCII, punctuation and letters, which stay what they were.
    expect(normalizeCR('cr-\u0661\u0662/\u06F3')).toBe('CR-12/3');
  });

  it('zero-width and other invisible format characters are stripped', () => {
    const invisible = [
      '\u00AD', // soft hyphen
      '\u061C', // Arabic letter mark
      '\u200B', '\u200C', '\u200D', '\u200E', '\u200F', // zero-width space/joiners, LRM, RLM
      '\u202A', '\u202E', // bidi embedding / override
      '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', // word joiner, invisible operators
      '\u2066', '\u2069', // bidi isolates
      '\uFEFF', // byte-order mark / zero-width no-break space
    ];
    for (const ch of invisible) {
      expect(normalizeCR(`123${ch}4567`), `U+${ch.charCodeAt(0).toString(16).toUpperCase()}`).toBe('1234567');
      expect(normalizeCR(`${ch}1234567${ch}`)).toBe('1234567');
    }
    // A value that is nothing but invisible characters is no CR at all.
    expect(normalizeCR('\u200B\u200E\uFEFF')).toBeNull();
  });

  it('an Arabic-Indic CR with a zero-width character is its ASCII twin', () => {
    expect(normalizeCR('\u200F\u0661\u0662\u0663 \u0664\u0665\u0666\u0667')).toBe(normalizeCR('1234567'));
  });

  it('the fold changes nothing else: punctuation, letters and leading zeros are kept', () => {
    expect(normalizeCR('\u0660\u0661\u0662')).toBe('012');
    expect(normalizeCR('\u0660\u0661\u0662')).not.toBe(normalizeCR('12'));
    expect(normalizeCR('\u0661\u0662/\u0662\u0660\u0662\u0664')).toBe('12/2024');
    expect(normalizeCR('\u0661\u0662/\u0662\u0660\u0662\u0664')).not.toBe(normalizeCR('122024'));
  });
});
