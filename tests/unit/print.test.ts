// @vitest-environment node
/**
 * Owner decisions 2026-10-11, part C — the printouts' rules (lib/print.ts): who
 * may print, when the credit application is offered, the customer's declaration
 * word for word, which approvers sign the customer form, and that a PRINT row
 * carries ids only.
 */
import { describe, it, expect } from 'vitest';
import { EditProcess, PaymentTerms, Role } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import {
  APPROVER_BOX_LINES,
  COMPANY_NAME,
  CREDIT_DECLARATION,
  CUSTOMER_SIGNATURE_BOXES,
  PRINT_ALLOWED,
  PRINT_AUDIT_REASON,
  PRINT_REQUEST_TITLE,
  PRINTOUTS,
  canPrint,
  creditApplicationAvailable,
  printAuditAfter,
  signatureRolesFor,
} from '@/lib/print';
import { LEGACY_CREDIT_CHAIN } from '../support/legacy-chain';

describe('who may print', () => {
  it('every role but the salesman, and every role is decided', () => {
    expect(Object.keys(PRINT_ALLOWED).sort()).toEqual(Object.values(Role).sort());
    for (const role of Object.values(Role)) {
      expect(canPrint(role), role).toBe(role !== Role.SALESMAN);
    }
  });

  it('the Sales Director prints, as the GM does', () => {
    expect(canPrint(Role.SALES_DIRECTOR)).toBe(true);
    expect(PRINT_ALLOWED.SALES_DIRECTOR).toBe(PRINT_ALLOWED.GM);
  });
});

describe('the credit application is offered only at the signed-application step', () => {
  const chain = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
  const formStep = chain.findIndex((s) => s.scope === 'SUBMITTER');

  it('from the Sales Director’s approval until the signed form is uploaded', () => {
    expect(formStep).toBe(2);
    chain.forEach((_s, i) => {
      expect(creditApplicationAvailable({ state: 'SUBMITTED', approvalChain: chain, currentStepIndex: i }), `step ${i}`).toBe(
        i === formStep
      );
    });
  });

  it('never for a request that is not waiting — approved, returned, a draft, closed', () => {
    for (const state of ['APPROVED', 'NEEDS_CORRECTION', 'DRAFT', 'REJECTED']) {
      expect(creditApplicationAvailable({ state, approvalChain: chain, currentStepIndex: formStep }), state).toBe(false);
    }
  });

  it('never for a request frozen with the 4-step chain, nor for cash', () => {
    LEGACY_CREDIT_CHAIN.forEach((_s, i) => {
      expect(creditApplicationAvailable({ state: 'SUBMITTED', approvalChain: LEGACY_CREDIT_CHAIN, currentStepIndex: i })).toBe(false);
    });
    const cash = resolveChain(EditProcess.CREATE, PaymentTerms.CASH);
    cash.forEach((_s, i) => {
      expect(creditApplicationAvailable({ state: 'SUBMITTED', approvalChain: cash, currentStepIndex: i })).toBe(false);
    });
  });
});

describe('what the printouts say', () => {
  it('the declaration is the owner’s paper form, character for character', () => {
    expect(CREDIT_DECLARATION).toBe(
      "We/I hereby undertake to indemnify M/S: National Mineral Water Company SAOG for any loss suffered or caused to them on non-payment or default in payment for the supplies made to our company/establishment on the basis of LPO's / receipts signed by the above mentioned authorized signatories or any employees of our company/establishment. Any delay in payment shall be liable to 1% per month from the date of payment due."
    );
  });

  it('the company is named in text (no logo has been sent)', () => {
    expect(COMPANY_NAME).toBe('National Mineral Water Company SAOG');
  });

  it('the customer’s boxes: Name, Designation, Signature, Company stamp', () => {
    expect([...CUSTOMER_SIGNATURE_BOXES]).toEqual(['Name', 'Designation', 'Signature', 'Company stamp']);
    expect([...APPROVER_BOX_LINES]).toEqual(['Name', 'Signature', 'Date']);
  });

  it('cash is signed by the Supervisor and the Accountant; credit by all five approvers, never the salesman', () => {
    expect(signatureRolesFor(PaymentTerms.CASH)).toEqual([Role.SUPERVISOR, Role.ACCOUNTANT]);
    expect(signatureRolesFor(PaymentTerms.CREDIT)).toEqual([
      Role.SUPERVISOR,
      Role.SALES_DIRECTOR,
      Role.FINANCE_MANAGER,
      Role.GM,
      Role.ACCOUNTANT,
    ]);
    // The approving roles of the chain a credit customer is created by, in its order.
    const approving = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT)
      .filter((s) => s.scope !== 'SUBMITTER')
      .map((s) => s.role);
    expect(signatureRolesFor(PaymentTerms.CREDIT)).toEqual(approving);
    expect(signatureRolesFor(PaymentTerms.CASH)).toEqual(resolveChain(EditProcess.CREATE, PaymentTerms.CASH).map((s) => s.role));
  });

  it('the alert that asks for a print is the one services/edits.ts writes', async () => {
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('../support/strip-comments');
    const src = stripComments(readFileSync('services/edits.ts', 'utf8'), 'services/edits.ts');
    expect(src).toMatch(/title: PRINT_REQUEST_TITLE,/);
    expect(src).not.toMatch(/'Credit application to print'/);
    expect(PRINT_REQUEST_TITLE).toBe('Credit application to print');
  });
});

describe('the PRINT row records ids only', () => {
  it('the credit application: which printout, the round and the step', () => {
    expect(printAuditAfter({ printout: 'CREDIT_APPLICATION', cycle: 2, stepIndex: 2 })).toEqual({
      printout: 'CREDIT_APPLICATION',
      cycle: 2,
      stepIndex: 2,
    });
  });

  it('the customer form: which printout, the onboarding request and the branches printed', () => {
    expect(printAuditAfter({ printout: 'CUSTOMER_FORM', requestId: 'e1', branchIds: ['b1', 'b2'] })).toEqual({
      printout: 'CUSTOMER_FORM',
      requestId: 'e1',
      branchIds: ['b1', 'b2'],
    });
    expect(printAuditAfter({ printout: 'CUSTOMER_FORM', requestId: null, branchIds: [] })).toEqual({
      printout: 'CUSTOMER_FORM',
      requestId: null,
      branchIds: [],
    });
  });

  it('nothing a caller adds rides along', () => {
    const sneaky = { printout: 'CREDIT_APPLICATION', cycle: 1, stepIndex: 2, legalName: 'Al Noor', phone: '+96891234567' } as const;
    expect(Object.keys(printAuditAfter(sneaky)).sort()).toEqual(['cycle', 'printout', 'stepIndex']);
  });

  it('each printout has its reason words', () => {
    expect(PRINTOUTS.map((p) => PRINT_AUDIT_REASON[p])).toEqual(['credit application printed', 'customer form printed']);
  });
});
