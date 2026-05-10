/**
 * Renders docs/guide/NMWC-CRM-USER-GUIDE.html to PDF using Playwright's
 * headless Chromium PDF engine. Uses the file:// protocol so the relative
 * `img/...` paths in the HTML resolve correctly.
 *
 * Output: docs/guide/NMWC-CRM-USER-GUIDE.pdf
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

const HTML_REL = 'docs/guide/NMWC-CRM-USER-GUIDE.html';
const PDF_REL = 'docs/guide/NMWC-CRM-USER-GUIDE.pdf';

async function main() {
  const cwd = process.cwd();
  const htmlAbs = resolve(cwd, HTML_REL);
  const pdfAbs = resolve(cwd, PDF_REL);
  if (!existsSync(htmlAbs)) {
    console.error(`HTML not found: ${htmlAbs}`);
    process.exit(1);
  }
  console.log(`Rendering ${HTML_REL} → ${PDF_REL}`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`file://${htmlAbs.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
  await page.pdf({
    path: pdfAbs,
    format: 'A4',
    printBackground: true,
    margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="font-size:8pt;color:#94a3b8;width:100%;text-align:center;padding:0 12mm;">' +
      'NMWC Customer Master · User Guide · ' +
      '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
  await browser.close();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void fileURLToPath;
void dirname;
