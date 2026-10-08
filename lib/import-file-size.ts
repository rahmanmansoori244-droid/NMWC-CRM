/**
 * The largest workbook an import takes, and what a bigger one is told. The
 * upload form checks it in the browser before calling the action, and the
 * importer (services/imports.ts) checks it again — one number, one message.
 *
 * The upload travels as a server action, and on Vercel a function's request
 * body is capped at 4.5 MB by the platform: a bigger body is refused before the
 * app runs, and the Steward saw Next's generic "An error occurred in the Server
 * Components render…" instead of a reason (the 8mb bodySizeLimit in
 * next.config.ts never gets to apply there). So the cap sits just under it:
 * 4,300 KB (4.2 MB), leaving about 95 KB for the multipart wrapping, which is a
 * few hundred bytes. It is also the zip-bomb cap (QA-012), which used to be
 * 5 MB — above what Vercel lets through, so its message never showed. The real
 * customer master is about 1.7 MB.
 */
export const MAX_IMPORT_BYTES = 4300 * 1024; // 4.2 MB

export function importFileTooLarge(size: number): string {
  return `File is too large (${Math.round(size / 1024)} KB). Maximum is 4.2 MB.`;
}
