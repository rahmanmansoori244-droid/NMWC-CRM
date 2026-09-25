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

  // OPEN — owner decision (item 16): folding these changes the stored crNumberNorm,
  // so existing rows would need a one-off recompute. Today they never match their
  // ASCII twins, in the detector or in the create-time CR block.
  it.todo('Arabic-Indic digits fold to ASCII (١٢٣٤٥٦٧ = 1234567)');
  it.todo('zero-width characters are stripped (123\\u200B4567 = 1234567)');
});
