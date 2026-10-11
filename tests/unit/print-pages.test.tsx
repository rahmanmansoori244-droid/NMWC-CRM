/**
 * Owner decisions 2026-10-11, part C — the two printout pages and their loaders
 * (app/(print)/print/*, lib/print-load.ts), rendered with the database and the
 * session mocked and the REAL scope rules of lib/access.ts:
 *   - a salesman, a signed-out visitor and anyone out of scope get no printout
 *     (a 404, never "you may not");
 *   - the credit application is printed only at the signed-application step, and
 *     says where the request is otherwise;
 *   - the customer form carries both codes and only the branches the printer can
 *     see; a cash customer has 2 approver boxes, a credit one 5;
 *   - the (print) layout renders no app chrome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EditProcess, PaymentTerms } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { CREDIT_DECLARATION, PRINT_DIALOG_HINT, TEMIX_CODE_MIGRATED, TEMIX_CODE_NONE } from '@/lib/print';
import { stripComments } from '../support/strip-comments';
import { LEGACY_CREDIT_CHAIN } from '../support/legacy-chain';

type Att = {
  id: string;
  kind: string;
  editId: string | null;
  customerId: string | null;
  branchExtraId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
};
type Scope = { ownedRouteId: string | null; teamRouteIds: string[]; managedRegionIds: string[] };

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; username: string; name: string },
  scope: { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] } as Scope,
  edit: null as Record<string, unknown> | null,
  request: null as Record<string, unknown> | null,
  customer: null as Record<string, unknown> | null,
  attachments: [] as Att[],
  batch: null as { uploadedAt: Date } | null,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  // The profile's client controls (Archive, a branch's status) read the router.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => (h.user ? { user: h.user } : null) }));
vi.mock('@/services/prints', () => ({ recordPrintAction: vi.fn() }));
vi.mock('@/lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/access')>()),
  loadScope: async () => h.scope,
}));

function attachmentsFor(where: Record<string, unknown>): Att[] {
  const inList = (v: unknown, x: string | null) =>
    v === undefined || (typeof v === 'object' && v !== null && 'in' in v ? (v as { in: string[] }).in.includes(x as string) : v === x);
  return h.attachments.filter(
    (a) =>
      inList(where.id, a.id) &&
      inList(where.kind, a.kind) &&
      inList(where.editId, a.editId) &&
      inList(where.customerId, a.customerId) &&
      inList(where.branchExtraId, a.branchExtraId) &&
      (where.deletedAt !== null || a.deletedAt === null)
  );
}
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: {
      findUnique: async ({ where }: { where: { id: string } }) => (h.edit && h.edit.id === where.id ? h.edit : null),
      findFirst: async () => h.request,
    },
    customer: {
      findFirst: async ({ where }: { where: { id: string } }) => (h.customer && h.customer.id === where.id ? h.customer : null),
    },
    attachment: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        attachmentsFor(where).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    },
    importBatch: { findUnique: async () => h.batch },
    // The profile reads a salesman's sent-back requests (lib/returned-work.ts): none here.
    $queryRaw: async () => [],
  },
}));

const EDIT = 'ckedit00000000000000000001';
const CUST = 'ckcust00000000000000000001';
const CREDIT_CHAIN = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
const CASH_CHAIN = resolveChain(EditProcess.CREATE, PaymentTerms.CASH);
let seq = 0;
const att = (id: string, kind: string, o: Partial<Att> = {}): Att => ({
  id,
  kind,
  editId: null,
  customerId: null,
  branchExtraId: null,
  deletedAt: null,
  createdAt: new Date(Date.UTC(2026, 9, 10, 6, 0, seq++)),
  ...o,
});

const as = (role: string, scope: Partial<Scope> = {}) => {
  h.user = { id: `u-${role.toLowerCase()}`, role, username: `${role.toLowerCase()}.x`, name: `${role} Person` };
  h.scope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [], ...scope };
};

function creditEdit(stepIndex: number, o: Record<string, unknown> = {}) {
  return {
    id: EDIT,
    process: 'CREATE',
    state: 'SUBMITTED',
    approvalChain: CREDIT_CHAIN,
    currentStepIndex: stepIndex,
    cycle: 1,
    customerId: null,
    submittedAt: new Date('2026-10-10T10:00:00Z'),
    slaDueAt: new Date('2026-10-14T10:00:00Z'),
    requestedCreditLimit: { toFixed: (dp: number) => (1234.5).toFixed(dp) },
    requestedPaymentTermDays: 45,
    submittedBy: { fullName: 'Salesman One' },
    customerDraft: {
      legalName: 'Al Noor Trading',
      paymentTerms: 'CREDIT',
      crNumber: '1234567',
      primaryPhone: '+96891234567',
      altPhone: null,
      contactPerson: 'Salim',
      contactRole: 'Owner',
      email: 'accounts@example.com',
      notes: null,
      crPhotoAttachmentId: 'p-cr',
      channel: { label: 'Traditional Trade' },
      subChannel: { label: 'Grocery' },
    },
    branchDrafts: [
      {
        branchName: 'Main shop',
        routeId: 'rA',
        address: 'Way 3012, Al Ghubra North',
        areaDescription: null,
        gpsLat: 23.5881,
        gpsLng: 58.3829,
        gpsAccuracy: 9,
        gpsCapturedAt: new Date('2026-10-10T09:00:00Z'),
        dayOfVisit: 'SAT',
        openingHours: '08:00-22:00',
        deliveryWindow: null,
        coolersCount: 1,
        standsCount: 0,
        emptyBottlesCount: 4,
        shopPhotoAttachmentId: 'p-shop',
        signboardPhotoAttachmentId: 'p-sign',
        extraPhotoAttachmentIds: ['p-extra', 'p-gone'],
        route: { code: 'MCT-01', regionId: 'g1', region: { name: 'Muscat' } },
      },
    ],
    ...o,
  };
}

function seedRequestPhotos() {
  h.attachments = [
    att('p-cr', 'CR', { editId: EDIT }),
    att('p-id1', 'ID_CARD', { editId: EDIT }),
    att('p-id2', 'ID_CARD', { editId: EDIT }),
    att('p-mem', 'MEMBERSHIP_CERT', { editId: EDIT }),
    att('p-vat', 'VAT_CERT', { editId: EDIT }),
    att('p-tax', 'TAX_CARD', { editId: EDIT }),
    att('p-old-form', 'CREDIT_FORM', { editId: EDIT }),
    att('p-shop', 'SHOP', { editId: EDIT }),
    att('p-sign', 'SIGNBOARD', { editId: EDIT }),
    att('p-extra', 'FREE', { editId: EDIT }),
    att('p-gone', 'FREE', { editId: EDIT, deletedAt: new Date() }),
    att('p-removed-id', 'ID_CARD', { editId: EDIT, deletedAt: new Date() }),
  ];
}

async function creditPage(id = EDIT) {
  const { default: Page } = await import('@/app/(print)/print/credit-application/[editId]/page');
  return render(await Page({ params: Promise.resolve({ editId: id }) }));
}
async function customerPage(id = CUST) {
  const { default: Page } = await import('@/app/(print)/print/customer/[customerId]/page');
  return render(await Page({ params: Promise.resolve({ customerId: id }) }));
}
const images = (container: HTMLElement) =>
  [...container.querySelectorAll('img')].map((i) => [i.getAttribute('src'), i.getAttribute('alt')]);

beforeEach(() => {
  h.user = null;
  h.edit = null;
  h.request = null;
  h.customer = null;
  h.attachments = [];
  h.batch = null;
});
afterEach(cleanup);

describe('the credit application', () => {
  beforeEach(() => {
    h.edit = creditEdit(2);
    seedRequestPhotos();
  });

  it('a Manager of the region prints it at the signed-application step: every detail, the declaration and the customer’s boxes', async () => {
    as('MANAGER', { managedRegionIds: ['g1'] });
    const { container } = await creditPage();
    const sheet = screen.getByRole('article', { name: 'Credit Application: Al Noor Trading' });
    const text = sheet.textContent!;
    for (const want of [
      'National Mineral Water Company SAOG',
      'Request ref.',
      EDIT,
      'Assigned on approval',
      'Awaiting customer signature',
      'Submitted by Salesman One · 10/10/2026, 14:00:00',
      'signed copy due back 14/10/2026, 14:00:00',
      'Printed by MANAGER Person',
      'accounts@example.com',
      'OMR 1234.500',
      '45 days',
      'Traditional Trade',
      'Saturday',
      '23.588100, 58.382900',
      'Accuracy: ±9 m',
      'Captured: 10/10/2026, 13:00:00',
      CREDIT_DECLARATION,
    ]) {
      expect(text, want).toContain(want);
    }
    expect(
      screen.getAllByRole('region', { name: /^Customer: / }).map((r) => r.getAttribute('aria-label'))
    ).toEqual(['Customer: Name', 'Customer: Designation', 'Customer: Signature', 'Customer: Company stamp']);
    // The documents and photos as the request carries them now: live, claimed by it,
    // never the signed form itself, nothing removed.
    expect(images(container)).toEqual([
      ['/api/photos/p-cr', 'CR copy'],
      ['/api/photos/p-id1', "Owner's ID card — page 1 of 2"],
      ['/api/photos/p-id2', "Owner's ID card — page 2 of 2"],
      ['/api/photos/p-mem', 'Membership certificate'],
      ['/api/photos/p-vat', 'VAT registration certificate'],
      ['/api/photos/p-tax', 'Tax card'],
      ['/api/photos/p-shop', 'Shop front'],
      ['/api/photos/p-sign', 'Signboard'],
      ['/api/photos/p-extra', 'Other photo'],
    ]);
    for (const img of container.querySelectorAll('img')) expect(img.getAttribute('loading')).toBe('eager');
    // The print button and the notice a Ctrl+P prints instead.
    expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeTruthy();
    expect(container.querySelector('.print-blocked')!.textContent).toBe(
      'This printout was not recorded. Use the Print button on the page so the print is recorded.'
    );
    expect(container.querySelector('.print-toolbar')!.className).toContain('no-print');
  });

  it.each([
    ['SUPERVISOR of the salesman', 'SUPERVISOR', { teamRouteIds: ['rA'] }],
    ['Accountant of the region', 'ACCOUNTANT', { managedRegionIds: ['g1'] }],
    ['Sales Director', 'SALES_DIRECTOR', {}],
    ['Finance Manager', 'FINANCE_MANAGER', {}],
    ['GM', 'GM', {}],
    ['Data Steward', 'STEWARD', {}],
    ['Viewer', 'VIEWER', {}],
  ])('the %s may print it', async (_who, role, scope) => {
    as(role, scope as Partial<Scope>);
    await creditPage();
    expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeTruthy();
  });

  it('the salesman gets a 404 — even his own request (his supervisor prints it)', async () => {
    as('SALESMAN', { ownedRouteId: 'rA' });
    await expect(creditPage()).rejects.toThrow('notFound');
  });

  it('out of scope is a 404: another region’s Manager, another team’s Supervisor, an unknown id', async () => {
    as('MANAGER', { managedRegionIds: ['g2'] });
    await expect(creditPage()).rejects.toThrow('notFound');
    as('MANAGER', { managedRegionIds: [] });
    await expect(creditPage()).rejects.toThrow('notFound');
    as('SUPERVISOR', { teamRouteIds: ['rB'] });
    await expect(creditPage()).rejects.toThrow('notFound');
    as('GM');
    await expect(creditPage('ckedit00000000000000000999')).rejects.toThrow('notFound');
  });

  it('a cash request, or an update, has no credit application: 404', async () => {
    as('GM');
    h.edit = creditEdit(1, {
      approvalChain: CASH_CHAIN,
      customerDraft: { ...creditEdit(1).customerDraft, paymentTerms: 'CASH' },
    });
    await expect(creditPage()).rejects.toThrow('notFound');
    h.edit = creditEdit(0, { process: 'UPDATE', customerDraft: null });
    await expect(creditPage()).rejects.toThrow('notFound');
  });

  it('signed out: to the sign-in page', async () => {
    await expect(creditPage()).rejects.toThrow('redirect /login');
  });

  it('outside its window it says where the request is, with no Print button', async () => {
    as('GM');
    const cases: Array<[Record<string, unknown>, string]> = [
      [creditEdit(1), 'It can be printed once the Sales Director has approved the request. It is now at the Sales Director step.'],
      [creditEdit(3), 'The signed application has been uploaded. The request is now at the Finance Manager step.'],
      [
        creditEdit(1, { approvalChain: LEGACY_CREDIT_CHAIN }),
        'This request was sent before the signed credit application was part of the process, so it has none to print.',
      ],
      [creditEdit(0, { state: 'NEEDS_CORRECTION' }), 'The request is back with the salesman for correction.'],
    ];
    for (const [edit, words] of cases) {
      h.edit = edit;
      const { container } = await creditPage();
      expect(screen.getByRole('status').textContent).toContain(`Not available now — ${words}`);
      expect(screen.queryByRole('button', { name: 'Print / Save as PDF' })).toBeNull();
      expect(container.querySelector('.print-sheet')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      cleanup();
    }
  });

  // Review (2026-10-11): a saved PDF is named after the tab title.
  it('the tab title carries the request reference printed in its header — only while it can be printed', async () => {
    const { generateMetadata } = await import('@/app/(print)/print/credit-application/[editId]/page');
    const title = async () => (await generateMetadata({ params: Promise.resolve({ editId: EDIT }) })).title;
    as('GM');
    expect(await title()).toBe(`Credit application ${EDIT} · NMWC`);
    h.edit = creditEdit(3);
    expect(await title()).toBe('Credit application · NMWC');
    h.edit = creditEdit(2);
    as('SALESMAN', { ownedRouteId: 'rA' });
    expect(await title()).toBe('Credit application · NMWC');
  });

  it('once the customer exists, it points to the customer form', async () => {
    as('GM');
    h.edit = creditEdit(5, { state: 'APPROVED', customerId: CUST });
    await creditPage();
    expect(screen.getByRole('link', { name: 'Open the customer form to print' }).getAttribute('href')).toBe(
      `/print/customer/${CUST}`
    );
  });
});

describe('the final customer form', () => {
  const branch = (id: string, region: string, o: Record<string, unknown> = {}) => ({
    id,
    branchCode: `NMWC-2026-000123-0${id.slice(-1)}`,
    branchName: `Shop ${id}`,
    routeId: `r-${region}`,
    regionId: region,
    deletedAt: null,
    status: 'ACTIVE',
    address: `Address of ${id}`,
    areaDescription: null,
    gpsLat: 23.6,
    gpsLng: 58.2,
    gpsAccuracy: null,
    gpsCapturedAt: null,
    dayOfVisit: null,
    openingHours: null,
    deliveryWindow: null,
    coolersCount: 0,
    standsCount: 0,
    emptyBottlesCount: 0,
    shopPhotoId: `shop-${id}`,
    signboardPhotoId: null,
    region: { name: region === 'g1' ? 'Muscat' : 'Dhofar' },
    route: { code: `R-${region}` },
    ...o,
  });
  function customer(terms: 'CASH' | 'CREDIT', o: Record<string, unknown> = {}) {
    return {
      id: CUST,
      nmwcCode: 'NMWC-2026-000123',
      temixCode: 'CAA0367',
      legalName: 'Al Noor Trading',
      paymentTerms: terms,
      status: 'ACTIVE',
      crNumber: '1234567',
      primaryPhone: '+96891234567',
      altPhone: null,
      contactPerson: 'Salim',
      contactRole: null,
      email: terms === 'CREDIT' ? 'accounts@example.com' : null,
      notes: null,
      creditLimit: terms === 'CREDIT' ? { toFixed: (dp: number) => (500).toFixed(dp) } : null,
      paymentTermDays: terms === 'CREDIT' ? 30 : null,
      importBatchId: null,
      crPhotoId: 'c-cr',
      channel: { label: 'Traditional Trade' },
      subChannel: null,
      branches: [branch('b1', 'g1'), branch('b2', 'g2')],
      ...o,
    };
  }
  const steps = (chain: Array<{ role: string }>, cycle = 1) =>
    chain.map((s, i) => ({
      cycle,
      stepIndex: i,
      decision: s.role === 'SALESMAN' ? 'FORM_UPLOADED' : 'APPROVED',
      at: new Date(Date.UTC(2026, 9, 10, 6 + i, 0, 0)),
      actor: { fullName: `${s.role} Person` },
    }));

  beforeEach(() => {
    h.attachments = [
      att('c-cr', 'CR', { customerId: CUST }),
      att('c-id', 'ID_CARD', { customerId: CUST }),
      att('c-form', 'CREDIT_FORM', { customerId: CUST }),
      att('c-old-id', 'ID_CARD', { customerId: CUST, deletedAt: new Date() }),
      att('shop-b1', 'SHOP'),
      att('shop-b2', 'SHOP'),
      att('x-b1', 'FREE', { branchExtraId: 'b1' }),
      att('x-b2', 'FREE', { branchExtraId: 'b2' }),
    ];
  });

  it('a credit customer: both codes, the details, the documents incl. the signed application, the trail and five approver boxes', async () => {
    as('GM');
    h.customer = customer('CREDIT');
    h.request = {
      id: EDIT,
      cycle: 1,
      approvalChain: CREDIT_CHAIN,
      submittedAt: new Date('2026-10-10T05:00:00Z'),
      submittedBy: { fullName: 'Salesman One' },
      steps: steps(CREDIT_CHAIN),
    };
    const { container } = await customerPage();
    const sheet = screen.getByRole('article', { name: 'Customer Form: Al Noor Trading' });
    for (const want of ['NMWC code', 'NMWC-2026-000123', 'Temix code', 'CAA0367', 'Active · Credit', 'OMR 500.000', '30 days', 'accounts@example.com']) {
      expect(sheet.textContent, want).toContain(want);
    }
    const trail = within(screen.getByRole('table', { name: 'Approval trail' }));
    expect(trail.getAllByRole('row').slice(1).map((r) => [...r.querySelectorAll('[role=cell]')].map((c) => c.textContent))).toEqual([
      ['Supervisor', 'Approved', 'SUPERVISOR Person', '10/10/2026, 10:00:00'],
      ['Sales Director', 'Approved', 'SALES_DIRECTOR Person', '10/10/2026, 11:00:00'],
      ['Signed application', 'Signed application uploaded', 'SALESMAN Person', '10/10/2026, 12:00:00'],
      ['Finance Manager', 'Approved', 'FINANCE_MANAGER Person', '10/10/2026, 13:00:00'],
      ['GM', 'Approved', 'GM Person', '10/10/2026, 14:00:00'],
      ['Accountant', 'Approved', 'ACCOUNTANT Person', '10/10/2026, 15:00:00'],
    ]);
    expect(sheet.textContent).toContain('Submitted by Salesman One · 10/10/2026, 09:00:00');
    expect(screen.getAllByRole('region', { name: /^Signature: / }).map((r) => r.getAttribute('aria-label'))).toEqual([
      'Signature: Supervisor',
      'Signature: Sales Director',
      'Signature: Finance Manager',
      'Signature: GM',
      'Signature: Accountant',
    ]);
    expect(images(container).map(([src]) => src)).toEqual([
      '/api/photos/c-cr',
      '/api/photos/c-id',
      '/api/photos/c-form',
      '/api/photos/shop-b1',
      '/api/photos/x-b1',
      '/api/photos/shop-b2',
      '/api/photos/x-b2',
    ]);
    expect(images(container)[2]![1]).toBe('Signed credit application');
  });

  it('a cash customer: Supervisor and Accountant boxes only, and no credit terms', async () => {
    as('GM');
    h.customer = customer('CASH');
    await customerPage();
    expect(screen.getAllByRole('region', { name: /^Signature: / }).map((r) => r.getAttribute('aria-label'))).toEqual([
      'Signature: Supervisor',
      'Signature: Accountant',
    ]);
    expect(screen.queryByText('Credit Terms')).toBeNull();
  });

  it('a regional Manager prints only the branches of his regions (RBAC-05-001)', async () => {
    as('MANAGER', { managedRegionIds: ['g1'] });
    h.customer = customer('CASH');
    const { container } = await customerPage();
    const sheet = screen.getByRole('article').textContent!;
    expect(sheet).toContain('Shop b1');
    expect(sheet).not.toContain('Shop b2');
    expect(sheet).not.toContain('Dhofar');
    // The customer's own documents are the customer's, like the CR copy (the photo
    // route opens them to whoever can see the customer); the shops' photos are the
    // printed shops' only.
    expect(images(container).map(([src]) => src)).toEqual([
      '/api/photos/c-cr',
      '/api/photos/c-id',
      '/api/photos/c-form',
      '/api/photos/shop-b1',
      '/api/photos/x-b1',
    ]);
  });

  it('the salesman, another region’s Manager, an archived or unknown customer: 404', async () => {
    h.customer = customer('CASH');
    as('SALESMAN', { ownedRouteId: 'r-g1' });
    await expect(customerPage()).rejects.toThrow('notFound');
    as('MANAGER', { managedRegionIds: ['g9'] });
    await expect(customerPage()).rejects.toThrow('notFound');
    as('GM');
    await expect(customerPage('ckcust00000000000000000999')).rejects.toThrow('notFound');
  });

  it('a customer loaded by import says so; one with no request and no import says it has no trail', async () => {
    as('GM');
    h.customer = customer('CASH', { importBatchId: 'ib1', temixCode: null });
    h.batch = { uploadedAt: new Date('2026-09-20T05:00:00Z') };
    await customerPage();
    expect(screen.getByText('Loaded by import on 20/09/2026; no approval trail in the CRM.')).toBeTruthy();
    // Review (2026-10-11): migrated, it is in Temix under its NMWC code — never a
    // bare "None recorded", which reads as "not in Temix".
    expect(screen.getByRole('article').textContent).toContain(TEMIX_CODE_MIGRATED);
    expect(screen.getByRole('article').textContent).not.toContain(TEMIX_CODE_NONE);
    cleanup();
    h.customer = customer('CASH', { temixCode: null });
    await customerPage();
    expect(screen.getByText('Not created through a new-customer request in the CRM; no approval trail.')).toBeTruthy();
    expect(screen.getByRole('article').textContent).toContain(TEMIX_CODE_MIGRATED);
    cleanup();
    // Made through a CRM request with no Temix code typed: none recorded, said plainly.
    h.customer = customer('CASH', { temixCode: null });
    h.request = {
      id: EDIT,
      cycle: 1,
      approvalChain: CASH_CHAIN,
      submittedAt: new Date('2026-10-10T05:00:00Z'),
      submittedBy: { fullName: 'Salesman One' },
      steps: steps(CASH_CHAIN),
    };
    await customerPage();
    expect(screen.getByRole('article').textContent).toContain(`Temix code${TEMIX_CODE_NONE}`);
    expect(screen.getByRole('article').textContent).not.toContain(TEMIX_CODE_MIGRATED);
  });

  // Review (2026-10-11): "works for a migrated customer with no photos" — every
  // other fixture had a CR photo, shop photos and GPS.
  it('a migrated customer with no photo, no document and no location: the empty states, the import trail, its boxes, and it prints', async () => {
    as('GM');
    h.attachments = [];
    h.batch = { uploadedAt: new Date('2026-09-20T05:00:00Z') };
    h.customer = customer('CREDIT', {
      importBatchId: 'ib1',
      temixCode: null,
      email: null,
      crPhotoId: null,
      creditLimit: null,
      paymentTermDays: null,
      branches: [branch('b1', 'g1', { shopPhotoId: null, signboardPhotoId: null, gpsLat: null, gpsLng: null })],
    });
    const { container } = await customerPage();
    const sheet = screen.getByRole('article', { name: 'Customer Form: Al Noor Trading' });
    expect(within(sheet).getByText('No photos or documents on file.')).toBeTruthy();
    expect(within(sheet).getByText('No location recorded.')).toBeTruthy();
    expect(within(sheet).getByText('Loaded by import on 20/09/2026; no approval trail in the CRM.')).toBeTruthy();
    expect(sheet.textContent).toContain(TEMIX_CODE_MIGRATED);
    expect(images(container)).toEqual([]);
    // Its terms' boxes: a credit customer's five, though it went through no chain here.
    expect(screen.getAllByRole('region', { name: /^Signature: / })).toHaveLength(5);
    // Review (2026-10-11): the toolbar, which does not print, says to switch off
    // the browser's own header and footer.
    expect(screen.getByText(PRINT_DIALOG_HINT).closest('.no-print')).toBeTruthy();
    expect(PRINT_DIALOG_HINT).toMatch(/untick “Headers and footers”/);

    const { recordPrintAction } = await import('@/services/prints');
    vi.mocked(recordPrintAction).mockReset().mockResolvedValue({ ok: true, data: { printout: 'CUSTOMER_FORM', id: CUST } } as never);
    const printed: boolean[] = [];
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      printed.push(document.documentElement.hasAttribute('data-print-ok'));
    });
    const { fireEvent, waitFor } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
    await waitFor(() => expect(printed).toEqual([true]), { timeout: 3000 });
    expect(recordPrintAction).toHaveBeenCalledWith({ printout: 'CUSTOMER_FORM', id: CUST });
    print.mockRestore();
    window.dispatchEvent(new Event('afterprint'));
    expect(document.documentElement.hasAttribute('data-print-ok')).toBe(false);
  });

  // Review (2026-10-11): one constant title gave every saved PDF the same name.
  it('the tab title, which a saved PDF is named after, carries the customer’s NMWC code — only for whoever may print it', async () => {
    const { generateMetadata } = await import('@/app/(print)/print/customer/[customerId]/page');
    const title = async () => (await generateMetadata({ params: Promise.resolve({ customerId: CUST }) })).title;
    h.customer = customer('CASH');
    as('GM');
    expect(await title()).toBe('Customer form NMWC-2026-000123 · NMWC');
    as('SALESMAN', { ownedRouteId: 'r-g1' });
    expect(await title()).toBe('Customer form · NMWC');
    h.user = null;
    expect(await title()).toBe('Customer form · NMWC');
  });

  it('a step sent back and taken again shows its final taker, and the send-back is counted', async () => {
    as('GM');
    h.customer = customer('CASH');
    const base = steps(CASH_CHAIN, 2);
    h.request = {
      id: EDIT,
      cycle: 2,
      approvalChain: CASH_CHAIN,
      submittedAt: null,
      submittedBy: { fullName: 'Salesman One' },
      steps: [
        { cycle: 1, stepIndex: 0, decision: 'REJECTED', at: new Date('2026-10-01T05:00:00Z'), actor: { fullName: 'Old Manager' } },
        base[0]!,
        { cycle: 2, stepIndex: 1, decision: 'REJECTED', at: new Date('2026-10-10T06:30:00Z'), actor: { fullName: 'ACCOUNTANT Person' } },
        { ...base[0]!, at: new Date('2026-10-10T06:45:00Z'), actor: { fullName: 'Second Manager' } },
        base[1]!,
      ],
    };
    await customerPage();
    const rows = within(screen.getByRole('table', { name: 'Approval trail' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'SupervisorApprovedSecond Manager10/10/2026, 10:45:00',
      'AccountantApprovedACCOUNTANT Person10/10/2026, 11:00:00',
    ]);
    expect(screen.getByText(/Sent back between steps once in this round\. Returned to the salesman for correction once before\./)).toBeTruthy();
  });
});

describe('the printouts carry no app chrome, and every page checks the session itself', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name).replace(/\\/g, '/');
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
    });
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
  const PRINT_FILES = [...files('app/(print)'), ...files('components/print')];

  it('found the files', () => {
    expect(PRINT_FILES).toEqual(
      expect.arrayContaining([
        'app/(print)/layout.tsx',
        'app/(print)/print/credit-application/[editId]/page.tsx',
        'app/(print)/print/customer/[customerId]/page.tsx',
        'components/print/PrintButton.tsx',
      ])
    );
  });

  it('the (print) layout imports its stylesheet and no top bar, menu or tab bar', () => {
    const layout = src('app/(print)/layout.tsx');
    expect(layout).toMatch(/import '\.\/print\.css';/);
    for (const f of PRINT_FILES) {
      expect(src(f), f).not.toMatch(/TopBar|Sidebar|MobileTabBar|RouteSlot/);
    }
  });

  it('each page is dynamic, reads the session, sends a signed-out visitor to /login and 404s the rest', async () => {
    for (const f of PRINT_FILES.filter((x) => x.endsWith('/page.tsx'))) {
      const s = src(f);
      expect(s, f).toMatch(/export const dynamic = 'force-dynamic';/);
      // One load per request, shared with the page's title (generateMetadata).
      expect(s, f).toMatch(/const loadForViewer = cache\(async \(\w+: string\) => \{\s*const session = await auth\(\);\s*if \(!session\?\.user\) return null;/);
      expect(s, f).toMatch(/if \(!(loaded|viewer)\) redirect\('\/login'\);/);
      expect(s, f).toMatch(/notFound\(\)/);
    }
  });
});

describe('the Print button: recorded first, printed only on ok', () => {
  /** Each image as PrintImage marks it: loaded, failed for good, or still loading for a while. */
  async function setup(answer: unknown, images: Array<'loaded' | 'failed' | 'slow'> = []) {
    const { recordPrintAction } = await import('@/services/prints');
    const record = vi.mocked(recordPrintAction);
    record.mockReset();
    if (answer instanceof Error) record.mockRejectedValue(answer);
    else record.mockResolvedValue(answer as never);
    const printed: boolean[] = [];
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      printed.push(document.documentElement.hasAttribute('data-print-ok'));
    });
    const { PrintButton } = await import('@/components/print/PrintButton');
    render(
      <>
        <PrintButton printout="CUSTOMER_FORM" id={CUST} />
        <article className="print-sheet">
          {images.map((state, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              alt={`p${i}`}
              src={`/api/photos/p${i}`}
              data-print-image={state === 'slow' ? 'loading' : state}
              ref={(el) => {
                if (!el) return;
                el.decode = () => Promise.resolve();
                // A photo the burst limit turned away, let through on a retry.
                if (state === 'slow') setTimeout(() => el.setAttribute('data-print-image', 'loaded'), 600);
              }}
            />
          ))}
        </article>
      </>
    );
    return { record, print, printed };
  }
  const click = async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeTruthy(), { timeout: 3000 });
  };
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-print-ok');
  });

  it('ok: the dialog opens with data-print-ok set, and afterprint clears it', async () => {
    const { record, printed } = await setup({ ok: true, data: { printout: 'CUSTOMER_FORM', id: CUST } }, ['loaded', 'loaded']);
    await click();
    expect(record).toHaveBeenCalledWith({ printout: 'CUSTOMER_FORM', id: CUST });
    expect(printed).toEqual([true]);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.documentElement.hasAttribute('data-print-ok')).toBe(false);
  });

  it('refused: no dialog, and the reason is shown', async () => {
    const { print } = await setup({ ok: false, code: 'NOT_FOUND', message: 'Customer not found.' });
    await click();
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      'This print could not be recorded, so it was not started. Customer not found.'
    );
    expect(document.documentElement.hasAttribute('data-print-ok')).toBe(false);
  });

  it('the record failed outright: no dialog', async () => {
    const { print } = await setup(new Error('network'));
    await click();
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('This print could not be recorded, so it was not started.');
  });

  it('a photo still loading is waited for ("Loading photos…"), then the print goes ahead', async () => {
    const { record, printed } = await setup({ ok: true, data: { printout: 'CUSTOMER_FORM', id: CUST } }, ['loaded', 'slow']);
    const { fireEvent, waitFor } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
    expect(screen.getByRole('button', { name: 'Loading photos…' })).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
    await waitFor(() => expect(printed).toEqual([true]), { timeout: 3000 });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('a photo that did not load: nothing recorded, nothing printed, and the count said', async () => {
    const { record, print } = await setup({ ok: true, data: {} }, ['loaded', 'failed']);
    await click();
    expect(record).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      '1 photo or document did not load, so the print was not started. Reload the page and try again.'
    );
  });
});

// Review (2026-10-11): the permission used to be cleared by afterprint alone. A
// browser that ignored the late window.print() (the click's activation spent on
// the waits), or one that never fires afterprint (iOS Safari), left it set, and
// every later Ctrl+P printed the form with no PRINT row until a reload.
describe('allowOnePrint: the permission covers the one print the button started', () => {
  const allowed = () => document.documentElement.hasAttribute('data-print-ok');
  const fire = (type: 'beforeprint' | 'afterprint') => window.dispatchEvent(new Event(type));
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-print-ok');
  });
  /** window.print as a browser behaves: `opens` fires beforeprint (a dialog opened). */
  const stubPrint = (opens: boolean) => {
    const seen: boolean[] = [];
    vi.spyOn(window, 'print').mockImplementation(() => {
      if (opens) fire('beforeprint');
      seen.push(allowed());
    });
    return seen;
  };

  it('a call the browser ignores (no dialog): the permission ends after PRINT_DIALOG_OPEN_MS', async () => {
    const { allowOnePrint, PRINT_DIALOG_OPEN_MS } = await import('@/components/print/PrintButton');
    const seen = stubPrint(false);
    allowOnePrint();
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(PRINT_DIALOG_OPEN_MS - 1);
    expect(allowed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(allowed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a dialog that never says afterprint: the permission ends ONE_PRINT_MS after it opened, not at the open deadline', async () => {
    const { allowOnePrint, PRINT_DIALOG_OPEN_MS, ONE_PRINT_MS } = await import('@/components/print/PrintButton');
    const seen = stubPrint(true);
    allowOnePrint();
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(PRINT_DIALOG_OPEN_MS);
    expect(allowed()).toBe(true);
    vi.advanceTimersByTime(ONE_PRINT_MS - PRINT_DIALOG_OPEN_MS);
    expect(allowed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('afterprint ends it at once, and leaves nothing behind: a later Ctrl+P is not let through', async () => {
    const { allowOnePrint } = await import('@/components/print/PrintButton');
    stubPrint(true);
    allowOnePrint();
    fire('afterprint');
    expect(allowed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // The next print, without the button: its beforeprint finds no listener.
    fire('beforeprint');
    expect(allowed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a print() that throws leaves nothing let through', async () => {
    const { allowOnePrint } = await import('@/components/print/PrintButton');
    vi.spyOn(window, 'print').mockImplementation(() => {
      throw new Error('blocked');
    });
    allowOnePrint();
    expect(allowed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('where the printouts are offered', () => {
  const profileCustomer = (email: string | null) => ({
    id: CUST,
    legalName: 'Al Noor Trading',
    nmwcCode: 'NMWC-2026-000123',
    temixCode: null,
    paymentTerms: email ? 'CREDIT' : 'CASH',
    status: 'ACTIVE',
    completenessScore: 70,
    crNumber: null,
    notes: null,
    crPhoto: null,
    channel: null,
    subChannel: null,
    primaryPhone: null,
    altPhone: null,
    contactPerson: null,
    contactRole: null,
    email,
    branches: [
      {
        id: 'b1', branchName: 'Main', branchCode: 'B-01', address: 'Way 1', routeId: 'rA', regionId: 'g1', deletedAt: null,
        gpsLat: null, gpsLng: null, dayOfVisit: null, openingHours: null, deliveryWindow: null, coolersCount: 0,
        standsCount: 0, emptyBottlesCount: 0, completenessScore: 0, status: 'ACTIVE', region: { name: 'Muscat' },
        route: { name: 'A', isActive: true }, shopPhoto: null, signboardPhoto: null,
      },
    ],
    edits: [],
  });
  async function profile() {
    const { default: Page } = await import('@/app/(app)/customers/[id]/page');
    return render(await Page({ params: Promise.resolve({ id: CUST }) }));
  }

  it('the profile offers "Print customer form" in a tab of its own to every role but the salesman, and shows the e-mail', async () => {
    h.customer = profileCustomer('accounts@example.com');
    for (const [role, scope] of [
      ['MANAGER', { managedRegionIds: ['g1'] }],
      ['VIEWER', {}],
      ['SALES_DIRECTOR', {}],
      ['ACCOUNTANT', { managedRegionIds: ['g1'] }],
    ] as Array<[string, Partial<Scope>]>) {
      as(role, scope);
      await profile();
      const link = screen.getByRole('link', { name: 'Print customer form' });
      expect(link.getAttribute('href'), role).toBe(`/print/customer/${CUST}`);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(screen.getByText('E-mail').closest('div')!.textContent).toContain('accounts@example.com');
      cleanup();
    }
    as('SALESMAN', { ownedRouteId: 'rA' });
    await profile();
    expect(screen.queryByRole('link', { name: 'Print customer form' })).toBeNull();
  });

  it('a cash customer’s e-mail reads "—"', async () => {
    h.customer = profileCustomer(null);
    as('GM');
    await profile();
    expect(screen.getByText('E-mail').closest('div')!.textContent).toBe('E-mail—');
  });
});

describe('PrintImage: a photo the burst limit turned away is asked for again', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries at a new address, and gives up as "failed" after six attempts', async () => {
    vi.useFakeTimers();
    const { act, fireEvent } = await import('@testing-library/react');
    const { PrintImage } = await import('@/components/print/PrintImage');
    render(<PrintImage id="ph1" alt="Tax card" />);
    const img = () => screen.getByRole('img', { name: 'Tax card' });
    expect(img().getAttribute('src')).toBe('/api/photos/ph1');
    expect(img().getAttribute('data-print-image')).toBe('loading');
    expect(img().getAttribute('loading')).toBe('eager');
    for (let attempt = 1; attempt <= 5; attempt++) {
      fireEvent.error(img());
      await act(async () => {
        vi.advanceTimersByTime(1500 * 2 ** (attempt - 1) + 3000);
      });
      expect(img().getAttribute('src')).toBe(`/api/photos/ph1?attempt=${attempt}`);
      expect(img().getAttribute('data-print-image')).toBe('loading');
    }
    fireEvent.error(img());
    expect(img().getAttribute('data-print-image')).toBe('failed');
  });

  it('a retry that loads is "loaded"', async () => {
    vi.useFakeTimers();
    const { act, fireEvent } = await import('@testing-library/react');
    const { PrintImage } = await import('@/components/print/PrintImage');
    render(<PrintImage id="ph2" alt="Shop front" />);
    const img = screen.getByRole('img', { name: 'Shop front' });
    fireEvent.error(img);
    await act(async () => {
      vi.advanceTimersByTime(4500);
    });
    fireEvent.load(img);
    expect(img.getAttribute('data-print-image')).toBe('loaded');
    expect(img.getAttribute('src')).toBe('/api/photos/ph2?attempt=1');
  });
});
