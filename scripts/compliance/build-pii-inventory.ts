/**
 * B6: regenerate `docs/compliance/PII-INVENTORY.md` from the Prisma schema and
 * the classification map, or verify that the committed file is still current.
 *
 *   npx tsx scripts/compliance/build-pii-inventory.ts          # write
 *   npx tsx scripts/compliance/build-pii-inventory.ts --check  # CI: fail if stale
 *
 * The classification itself lives in `lib/compliance/pii-classification.ts` and
 * is enforced for completeness by `tests/unit/pii-classification.test.ts`, so a
 * new column cannot reach production without someone deciding whether it is
 * personal data.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { parsePrismaSchema, storedFields, fieldKey } from '../../lib/compliance/prisma-schema';
import {
  PII_CLASSIFICATION,
  SUBJECT_LABEL,
  type Subject,
} from '../../lib/compliance/pii-classification';

const SCHEMA = 'prisma/schema.prisma';
const OUT = 'docs/compliance/PII-INVENTORY.md';

const SUBJECT_ORDER: Subject[] = ['customer', 'employee', 'business-or-person', 'none'];

function build(): string {
  const schema = parsePrismaSchema(readFileSync(SCHEMA, 'utf8'));
  const fields = storedFields(schema);

  const rows = fields.map((f) => {
    const c = PII_CLASSIFICATION[fieldKey(f)];
    if (!c) throw new Error(`unclassified field ${fieldKey(f)} — add it to lib/compliance/pii-classification.ts`);
    return { ...f, ...c };
  });

  const personal = rows.filter((r) => r.subject !== 'none');
  const byModel = new Map<string, typeof rows>();
  for (const r of personal) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const counts = SUBJECT_ORDER.map((s) => `${SUBJECT_LABEL[s]}: ${rows.filter((r) => r.subject === s).length}`);

  const lines: string[] = [];
  lines.push('# Personal-data inventory (technical annex)');
  lines.push('');
  lines.push('<!-- GENERATED FILE — do not edit by hand.');
  lines.push('     Source: prisma/schema.prisma + lib/compliance/pii-classification.ts');
  lines.push('     Regenerate: npx tsx scripts/compliance/build-pii-inventory.ts');
  lines.push('     CI fails if this file is stale or if any column is unclassified. -->');
  lines.push('');
  lines.push(
    'Every column the database stores, classified by whose personal data it is. This file is generated: the classification lives beside the code in `lib/compliance/pii-classification.ts`, and `tests/unit/pii-classification.test.ts` fails if a column is added without a decision. It is the factual annex to `docs/compliance/DATA-RESIDENCY-REGISTER.md`.'
  );
  lines.push('');
  lines.push(`**${fields.length} stored columns across ${schema.models.length} tables** — ${counts.join(' · ')}.`);
  lines.push('');
  lines.push('## Columns holding personal data');
  lines.push('');

  for (const model of schema.models) {
    const list = byModel.get(model);
    if (!list?.length) continue;
    lines.push(`### ${model}`);
    lines.push('');
    lines.push('| Column | Subject | Kind | Note |');
    lines.push('|---|---|---|---|');
    for (const r of list) {
      lines.push(
        `| \`${r.name}\` | ${SUBJECT_LABEL[r.subject]} | ${r.kind ?? '—'} | ${r.note ?? ''} |`
      );
    }
    lines.push('');
  }

  lines.push('## Tables with no personal data');
  lines.push('');
  const clean = schema.models.filter((m) => !byModel.has(m));
  lines.push(clean.length ? clean.map((m) => `\`${m}\``).join(', ') : '_none_');
  lines.push('');
  lines.push('## Columns classified as not personal data');
  lines.push('');
  lines.push('<details><summary>Expand — every remaining column, so the classification is auditable</summary>');
  lines.push('');
  lines.push('| Table | Column | Type | Why not personal data |');
  lines.push('|---|---|---|---|');
  for (const r of rows.filter((x) => x.subject === 'none')) {
    lines.push(`| ${r.model} | \`${r.name}\` | ${r.type}${r.list ? '[]' : ''} | ${r.note ?? 'structural / operational value'} |`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
  return lines.join('\n');
}

const content = build();
if (process.argv.includes('--check')) {
  let existing = '';
  try {
    existing = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`${OUT} is missing — run: npx tsx scripts/compliance/build-pii-inventory.ts`);
    process.exit(1);
  }
  if (existing.trim() !== content.trim()) {
    console.error(
      `${OUT} is out of date with prisma/schema.prisma — run: npx tsx scripts/compliance/build-pii-inventory.ts`
    );
    process.exit(1);
  }
  console.log(`${OUT} is current`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, content);
  console.log(`wrote ${OUT}`);
}
