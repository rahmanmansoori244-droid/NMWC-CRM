/**
 * Code review 2026-11-10, finding 30: read the raw XML parts of an .xlsx file
 * from its bytes, with no library between the test and the file — so a test can
 * say how each cell is TYPED in the file itself (a shared string, an inline
 * string, a number, a formula), not how a reader chose to give it back.
 *
 * A minimal zip reader: the central directory, then each entry stored (0) or
 * deflated (8), which is all exceljs writes.
 */
import { inflateRawSync } from 'node:zlib';

export function xlsxParts(bytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + compressed);
    const raw = method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
    if (!raw) throw new Error(`unsupported zip method ${method} for ${name}`);
    out.set(name, raw.toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** XML text as it would read: the five entities decoded. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export type XlsxCell = {
  ref: string;
  /** The cell's `t` attribute: 's' shared string, 'inlineStr', 'str' (a formula's text result), 'n'/absent number. */
  type: string | null;
  /** Whether the cell carries a formula (`<f>`). */
  formula: boolean;
  /** The text the cell holds: the shared string it points at, or its inline/plain value. */
  text: string;
};

/** Every cell of the first worksheet, with its type as the file states it. */
export function firstSheetCells(bytes: Uint8Array): XlsxCell[] {
  const parts = xlsxParts(bytes);
  const sheetName = [...parts.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw new Error('no worksheet in the file');
  const sheet = parts.get(sheetName)!;
  const shared: string[] = [];
  const sst = parts.get('xl/sharedStrings.xml');
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(unescapeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const cells: XlsxCell[] = [];
  for (const m of sheet.matchAll(/<c ([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1]!;
    const body = m[3] ?? '';
    const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null;
    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
    const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
    const text = type === 's' ? (shared[Number(v)] ?? '') : unescapeXml(inline ?? v);
    cells.push({ ref, type, formula: /<f[\s>]/.test(body), text });
  }
  return cells;
}
