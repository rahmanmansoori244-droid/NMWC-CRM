/**
 * F1: a header value with every control character (CR and LF among them) turned
 * into a space, so nothing a value holds can start a header of its own. Used by
 * the digest for the subject and by the transport for every header it sends.
 */
export function headerSafe(value: string, max = 200): string {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out.replace(/ {2,}/g, ' ').trim().slice(0, max);
}
