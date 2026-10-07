/**
 * The launch run's last word: after the HTML report is written (reporters end
 * in order, and this one is listed after 'html'), scan every launch report,
 * test-results folder and server log for secrets (secret-scan.ts). A file that
 * holds one is DELETED and the run fails, naming the file and the kind of
 * secret — never the value.
 *
 * What keeps them out in the first place: passwords are typed with fillSecret()
 * (no recorded `Fill "<value>"` step), traces are off (a trace records call
 * parameters, DOM snapshots and the network log: cookies, passwords, the
 * presigned R2 URL), the R2 PUT goes through Node's fetch, not page.request.
 */
import fs from 'node:fs';
import type { FullResult, Reporter } from '@playwright/test/reporter';
import { describeHit, launchArtifactRoots, scanForSecrets } from './secret-scan';

export default class SecretScanReporter implements Reporter {
  printsToStdio(): boolean {
    return false;
  }

  async onEnd(_result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const res = scanForSecrets(launchArtifactRoots());
    if (res.hits.length === 0) {
      console.log(`[launch secret-scan] clean: ${res.files} file(s), ${res.entries} part(s) scanned`);
      return undefined;
    }
    const files = new Set(res.hits.map((h) => h.file));
    for (const h of res.hits) console.error(`[launch secret-scan] SECRET IN ${describeHit(h)}`);
    for (const f of files) fs.rmSync(f, { force: true });
    console.error(
      `[launch secret-scan] deleted ${files.size} file(s) that held a secret — the run fails. ` +
        'Type passwords with fillSecret(), keep traces off, keep presigned URLs out of page.request (tests/e2e/launch/README.md).'
    );
    return { status: 'failed' };
  }
}
