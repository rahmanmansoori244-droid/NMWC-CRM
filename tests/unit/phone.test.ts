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
  it('uppercases + strips separators', () => {
    expect(normalizeCR('1234567')).toBe('1234567');
    expect(normalizeCR('1234567-OM')).toBe('1234567OM');
    expect(normalizeCR(' 12 345 67 ')).toBe('1234567');
    expect(normalizeCR('cr_1234-567')).toBe('CR1234567');
  });
});
