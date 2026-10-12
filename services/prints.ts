'use server';

/**
 * Owner decisions 2026-10-11 (part C of the credit flow): every print is recorded
 * in the audit log — a PRINT row naming the request (the credit application) or
 * the customer (the customer form), which printout, and ids only — and the Data
 * Steward reads them on /audit like any other row (a Manager sees his regions'
 * through lib/audit-scope.ts managerAuditScopeSql).
 *
 * The print page's button (components/print/PrintButton.tsx) calls this first and
 * opens the browser's print only when it answers ok: a print that cannot be
 * recorded is not started, as a CR copy that cannot be recorded is not served
 * (app/api/photos/[id]/route.ts). A row therefore means the print dialog was
 * opened on that printout; whether the person then printed, saved a PDF or
 * cancelled is not something a browser tells the page.
 *
 * Authorized by the same loaders the pages render from (lib/print-load.ts), so
 * the page and the record can never disagree: a role that may not print, an id
 * outside the printer's scope and a credit application outside its window are
 * refused here exactly as the page refuses them.
 */
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { src, withChangeContext } from '@/lib/change-context';
import { requireActor } from '@/lib/session';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { checkLimit, PRINT_LIMIT } from '@/lib/rate-limit';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { PRINTOUTS, PRINT_AUDIT_REASON, PRINT_REQUEST_TITLE, canPrint, printAuditAfter, type Printout } from '@/lib/print';
import { loadCreditApplicationPrint, loadCustomerFormPrint } from '@/lib/print-load';

export type PrintReceipt = { printout: Printout; id: string };

const inputSchema = z.object({
  printout: z.enum(PRINTOUTS),
  id: z.string().cuid(),
});

export async function recordPrintAction(input: { printout: Printout; id: string }): SafeAction<PrintReceipt> {
  return runAction(() => recordPrintCore(input));
}

async function recordPrintCore(input: unknown): Promise<PrintReceipt> {
  const session = await requireActor(); // F15: refuses a session that must change its password
  if (!canPrint(session.role)) {
    throw new ForbiddenError('Your role does not print forms. Ask your supervisor.');
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError({ _form: 'This page could not be read. Reload it.' });
  const { printout, id } = parsed.data;
  const lim = await checkLimit(`print:${session.id}`, PRINT_LIMIT);
  if (!lim.ok) throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);

  const user = { id: session.id, role: session.role, username: session.username };
  const env = await getAuditEnvelope(session.id);
  const now = new Date();

  if (printout === 'CREDIT_APPLICATION') {
    const loaded = await loadCreditApplicationPrint(user, id);
    if (!loaded) throw new NotFoundError('Request not found.');
    if (loaded.kind !== 'ok') throw new ConflictError('PRINT_UNAVAILABLE', `Not available now — ${loaded.message}`);
    const { cycle, stepIndex } = loaded.print;
    await withChangeContext(prisma, { actorId: session.id, source: src.print(id) }, async (tx) => {
      await writeAudit(tx, env, {
        action: 'PRINT',
        entityType: 'CustomerEdit',
        entityId: id,
        reason: PRINT_AUDIT_REASON.CREDIT_APPLICATION,
        after: printAuditAfter({ printout, cycle, stepIndex }),
      });
      // His own "Credit application to print" alert is answered once he prints
      // it. A colleague's stays: it settles when the signed form comes back
      // (services/signed-form.ts settleRequestAlerts).
      await tx.notification.updateMany({
        where: { userId: session.id, editId: id, readAt: null, kind: 'EDIT_STAGE_ADVANCED', title: PRINT_REQUEST_TITLE },
        data: { readAt: now },
      });
    });
  } else {
    const loaded = await loadCustomerFormPrint(user, id);
    if (!loaded) throw new NotFoundError('Customer not found.');
    await writeAudit(null, env, {
      action: 'PRINT',
      entityType: 'Customer',
      entityId: id,
      reason: PRINT_AUDIT_REASON.CUSTOMER_FORM,
      after: printAuditAfter({ printout, requestId: loaded.requestId, branchIds: loaded.branchIds }),
    });
  }
  logger.info({ printout, id, by: session.id }, 'print.recorded');
  return { printout, id };
}
