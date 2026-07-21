// @vitest-environment node
/**
 * UAT DATA BUILDER — submit real CASH + CREDIT CREATE requests via the actual
 * submitCreateAction so the approval chains have live work items to walk in the
 * UI (cash SUP→ACC, credit SUP→FM→GM→ACC). Uses a seeded salesman; leaves the
 * requests SUBMITTED at step 0 (no cleanup). Prints who to log in as.
 *
 *   RUN_BUILD_CHAIN=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/build-chain-data.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_BUILD_CHAIN === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('UAT: build cash + credit CREATE chain data', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let creates: typeof import('@/services/creates');
  let salesman: { id: string; username: string };
  let supervisorName = '';
  let channelId = '';
  let subChannelId = '';

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    creates = await import('@/services/creates');
    const sm = await prisma.user.findFirst({
      where: { role: 'SALESMAN', ownedRouteId: { not: null }, isActive: true, ownedRoute: { isActive: true } },
      select: { id: true, username: true, supervisor: { select: { username: true } } },
    });
    if (!sm) throw new Error('No salesman with an active owned route seeded.');
    salesman = { id: sm.id, username: sm.username };
    supervisorName = sm.supervisor?.username ?? '(none)';
    const ch = await prisma.channel.findFirst({ include: { subChannels: { take: 1 } } });
    if (!ch || ch.subChannels.length === 0) throw new Error('No channel/subchannel seeded.');
    channelId = ch.id;
    subChannelId = ch.subChannels[0].id;
    current = { id: salesman.id, role: 'SALESMAN', username: salesman.username };
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  // create an UNBOUND synthetic attachment (DB row only, no R2 object) the create
  // flow can claim. Returns its id.
  async function mkAtt(kind: 'CR' | 'SHOP' | 'SIGNBOARD' | 'GUARANTEE', tag: string) {
    const a = await prisma.attachment.create({
      data: { kind, r2Key: `uat/${kind.toLowerCase()}-${tag}.jpg`, mimeType: kind === 'GUARANTEE' ? 'application/pdf' : 'image/jpeg', bytes: 1000, capturedById: salesman.id, capturedAt: new Date() },
    });
    return a.id;
  }
  async function branch(n: number) {
    return {
      branchName: `UAT Branch ${n}`, address: `UAT Way ${n}, Muscat`, gpsLat: 23.6, gpsLng: 58.4,
      dayOfVisit: 'MON' as const, coolersCount: 2, standsCount: 1, emptyBottlesCount: 10,
      shopPhotoAttachmentId: await mkAtt('SHOP', `${n}-${Date.now()}`),
      signboardPhotoAttachmentId: await mkAtt('SIGNBOARD', `${n}-${Date.now()}`),
    };
  }

  it('submits CASH CREATE requests (chain: Supervisor → Accountant)', async () => {
    for (let i = 1; i <= 2; i++) {
      const res = await creates.submitCreateAction({
        isDraft: false,
        customer: { legalName: `UAT Cash Customer ${i}`, paymentTerms: 'CASH', channelId, subChannelId, primaryPhone: `+9689${5000000 + i}`, contactPerson: `Contact ${i}`, crNumber: `${9500000 + i}`, crPhotoAttachmentId: await mkAtt('CR', `cash-${i}-${Date.now()}`) },
        branches: [await branch(i)],
      });
      if (!res.ok) console.error('CASH create failed:', JSON.stringify(res));
      expect(res.ok).toBe(true);
      console.log(`CASH-${i} editId=${(res as { ok: true; data: { editId: string; state: string } }).data.editId} state=${(res as { ok: true; data: { state: string } }).data.state}`);
    }
  });

  it('submits CREDIT CREATE requests (chain: Supervisor → FM → GM → Accountant)', async () => {
    for (let i = 1; i <= 2; i++) {
      const res = await creates.submitCreateAction({
        isDraft: false,
        customer: { legalName: `UAT Credit Customer ${i}`, paymentTerms: 'CREDIT', channelId, subChannelId, primaryPhone: `+9689${6000000 + i}`, contactPerson: `Credit Contact ${i}`, crNumber: `${9700000 + i}`, crPhotoAttachmentId: await mkAtt('CR', `credit-${i}-${Date.now()}`) },
        credit: { requestedCreditLimit: 5000 * i, requestedPaymentTermDays: 30 },
        guaranteeAttachmentIds: [await mkAtt('GUARANTEE', `${i}-${Date.now()}`)],
        branches: [await branch(100 + i)],
      });
      if (!res.ok) console.error('CREDIT create failed:', JSON.stringify(res));
      expect(res.ok).toBe(true);
      console.log(`CREDIT-${i} editId=${(res as { ok: true; data: { editId: string; state: string } }).data.editId} state=${(res as { ok: true; data: { state: string } }).data.state}`);
    }
  });

  it('reports who to log in as', async () => {
    const pending = await prisma.customerEdit.count({ where: { process: 'CREATE', state: 'SUBMITTED' } });
    console.log(`\n=== CHAIN DATA READY ===`);
    console.log(`Salesman submitter: ${salesman.username} (Demo!2026Demo)`);
    console.log(`Their Supervisor (step 1): ${supervisorName}`);
    console.log(`CREATE requests now SUBMITTED (pending Supervisor): ${pending}`);
    console.log(`Walk: Supervisor approves → CASH goes to Accountant; CREDIT goes to Finance Manager → GM → Accountant.`);
    expect(pending).toBeGreaterThanOrEqual(4);
  });
});
