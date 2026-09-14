/**
 * B6 (enterprise assessment, 2026-09-14): a personal-data inventory that cannot
 * silently go stale.
 *
 * A register is only worth signing if it still describes the system a year
 * later. Rather than hand-maintaining a table of fields, we parse the Prisma
 * schema and require every scalar field to carry a classification
 * (`lib/compliance/pii-classification.ts`). A field added without one fails the
 * unit suite, and therefore CI — so the inventory is a control, not a document.
 *
 * Deliberately a small, strict parser rather than a dependency: it understands
 * exactly the subset of the Prisma grammar this schema uses, and throws on
 * anything it does not recognise instead of quietly skipping it.
 */

export type SchemaField = {
  model: string;
  name: string;
  /** The declared type with `?` and `[]` stripped, e.g. `String`, `DateTime`, `Role`. */
  type: string;
  optional: boolean;
  list: boolean;
  /** True when the type names another model or an enum — i.e. not a stored scalar column. */
  relation: boolean;
  /** Raw attribute text after the type, e.g. `@id @default(cuid())`. */
  attributes: string;
};

export type ParsedSchema = {
  models: string[];
  enums: string[];
  fields: SchemaField[];
};

const SCALAR_TYPES = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

/** Strip `//` comments but keep `///` doc comments out of the way too. */
function stripComment(line: string): string {
  const i = line.indexOf('//');
  return i === -1 ? line : line.slice(0, i);
}

export function parsePrismaSchema(source: string): ParsedSchema {
  const lines = source.split(/\r?\n/);
  const models: string[] = [];
  const enums: string[] = [];
  const raw: Omit<SchemaField, 'relation'>[] = [];

  let current: string | null = null;
  let inEnum = false;

  for (const original of lines) {
    const line = stripComment(original).trim();
    if (!line) continue;

    const modelStart = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
    if (modelStart) {
      current = modelStart[1]!;
      models.push(current);
      inEnum = false;
      continue;
    }
    const enumStart = /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
    if (enumStart) {
      enums.push(enumStart[1]!);
      current = null;
      inEnum = true;
      continue;
    }
    if (/^(datasource|generator)\s+/.test(line)) {
      current = null;
      inEnum = false;
      continue;
    }
    if (line === '}') {
      current = null;
      inEnum = false;
      continue;
    }
    if (!current || inEnum) continue;
    // Block-level attributes (@@index, @@unique, @@map) are not fields.
    if (line.startsWith('@@')) continue;

    const field = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?\s*(.*)$/.exec(
      line
    );
    if (!field) {
      throw new Error(`prisma-schema: unparsed line in model ${current}: ${line}`);
    }
    raw.push({
      model: current,
      name: field[1]!,
      type: field[2]!,
      list: field[3] === '[]',
      optional: field[4] === '?',
      attributes: (field[5] ?? '').trim(),
    });
  }

  const known = new Set([...models, ...enums]);
  const fields: SchemaField[] = raw.map((f) => ({
    ...f,
    // An enum column IS stored data; a model reference is a relation.
    relation: known.has(f.type) && !enums.includes(f.type),
  }));

  for (const f of fields) {
    if (!f.relation && !SCALAR_TYPES.has(f.type) && !enums.includes(f.type)) {
      throw new Error(`prisma-schema: unknown type ${f.type} on ${f.model}.${f.name}`);
    }
  }

  return { models, enums, fields };
}

/** The fields that actually store a value in a column — what the inventory must classify. */
export function storedFields(schema: ParsedSchema): SchemaField[] {
  return schema.fields.filter((f) => !f.relation);
}

export function fieldKey(f: { model: string; name: string }): string {
  return `${f.model}.${f.name}`;
}
