/**
 * A small new-customer world for the lossless-paths suites (edit-revision,
 * finalize-birth): a region, a route, a salesman on it, his supervisor, the
 * region's Accountant; photos he took; and the calls the review pages make.
 * Synthetic ZZ rows only, tagged with the suite's suffix, removed by cleanup()
 * — requests, decisions, audit rows, notifications, the customers a finalize
 * made, their history, the rounds — in the owner's maintenance window where the
 * tables are append-only.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { freshDecisionToken } from './decision-token';
import {
  purgeAuditLog,
  purgeCustomerEdits,
  purgeEditApprovals,
  purgeHistory,
} from './audit';

type Mock = { id: string; role: string; username: string } | null;

export function createFlowFixture(prefix: string, setUser: (u: Mock) => void) {
  const tag = `${prefix}${Date.now().toString(36)}`;
  const TAG = tag.toUpperCase();
  const ids = {
    region: '',
    route: '',
    salesman: `${tag}-sm`,
    supervisor: `${tag}-sup`,
    accountant: `${tag}-acc`,
  };
  const attachments: string[] = [];
  let prisma: PrismaClient;
  let channelId = '';
  let subChannelId = '';

  const as = (id: string, role: string) => setUser({ id, role, username: id });
  // Fresh phone and CR digits per run: an exact CR match with a live customer is refused at submit.
  const seed = Math.floor(Math.random() * 800_000);
  const digits = (salt: number) => String(100000 + ((seed + salt) % 900000));

  async function setup(db: PrismaClient) {
    prisma = db;
    const region = await prisma.region.create({ data: { name: `ZZ ${tag} Region`, code: `${TAG}G` } });
    ids.region = region.id;
    const route = await prisma.route.create({ data: { name: `ZZ ${tag} Route`, code: `${TAG}R`, regionId: region.id } });
    ids.route = route.id;
    await prisma.user.create({ data: { id: ids.supervisor, username: ids.supervisor, passwordHash: 'x', fullName: `ZZ Sup ${tag}`, role: 'SUPERVISOR' } });
    await prisma.user.create({
      data: {
        id: ids.accountant,
        username: ids.accountant,
        passwordHash: 'x',
        fullName: `ZZ Acc ${tag}`,
        role: 'ACCOUNTANT',
        managedRegions: { connect: { id: region.id } },
      },
    });
    await prisma.user.create({
      data: {
        id: ids.salesman,
        username: ids.salesman,
        passwordHash: 'x',
        fullName: `ZZ Sales ${tag}`,
        role: 'SALESMAN',
        ownedRouteId: route.id,
        supervisorId: ids.supervisor,
      },
    });
    const ch = await prisma.channel.findFirst({ where: { isActive: true }, include: { subChannels: { where: { isActive: true }, take: 1 } } });
    if (!ch || ch.subChannels.length === 0) throw new Error('No channel/sub-channel seeded.');
    channelId = ch.id;
    subChannelId = ch.subChannels[0]!.id;
  }

  async function photo(kind: 'CR' | 'SHOP' | 'SIGNBOARD') {
    const a = await prisma.attachment.create({
      data: {
        kind,
        r2Key: `uat/${kind.toLowerCase()}-${tag}-${randomUUID().slice(0, 8)}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 1000,
        capturedById: ids.salesman,
        capturedAt: new Date(),
        hash: randomUUID().replace(/-/g, '').repeat(2),
      },
    });
    attachments.push(a.id);
    return a.id;
  }

  /** A CASH request's body; `branches` shops, each with fresh photos. */
  async function cashBody(name: string, salt: number, opts: { editId?: string; branches?: number; dayOfVisit?: string; crPhoto?: string } = {}) {
    const branches = [];
    for (let i = 0; i < (opts.branches ?? 1); i += 1) {
      branches.push({
        branchName: `ZZ Branch ${i + 1} ${name}`,
        address: `ZZ Way ${salt + i}, ${tag}`,
        gpsLat: 23.6 + i / 100,
        gpsLng: 58.4 + i / 100,
        dayOfVisit: (opts.dayOfVisit ?? 'THU') as 'THU',
        coolersCount: 1 + i,
        standsCount: 1,
        emptyBottlesCount: 5,
        shopPhotoAttachmentId: await photo('SHOP'),
        signboardPhotoAttachmentId: await photo('SIGNBOARD'),
      });
    }
    return {
      isDraft: false,
      ...(opts.editId ? { editId: opts.editId } : {}),
      customer: {
        legalName: name,
        paymentTerms: 'CASH' as const,
        channelId,
        subChannelId,
        primaryPhone: `+96894${digits(salt)}`,
        contactPerson: `ZZ Contact ${name}`,
        crNumber: `94${digits(salt + 1)}`,
        crPhotoAttachmentId: opts.crPhoto ?? (await photo('CR')),
      },
      branches,
    };
  }

  async function decide(kind: 'approve' | 'reject', editId: string, extra: Record<string, string> = {}) {
    const edits = await import('@/services/edits');
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('decisionToken', await freshDecisionToken(prisma, editId));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return kind === 'approve' ? edits.approveEditAction(fd) : edits.rejectEditAction(fd);
  }

  async function cleanup() {
    if (!prisma) return;
    const users = [ids.salesman, ids.supervisor, ids.accountant];
    const eds = await prisma.customerEdit.findMany({ where: { submittedById: { in: users } }, select: { id: true, customerId: true } });
    const editIds = eds.map((e) => e.id);
    const customerIds = eds.map((e) => e.customerId).filter((x): x is string => !!x);
    const branchIds = (await prisma.branch.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } })).map((b) => b.id);
    await prisma.notification.deleteMany({ where: { OR: [{ editId: { in: editIds } }, { userId: { in: users } }] } });
    await purgeEditApprovals(prisma, { where: { editId: { in: editIds } } });
    await purgeAuditLog(prisma, { where: { OR: [{ actorId: { in: users } }, { entityId: { in: [...editIds, ...customerIds, ...branchIds] } }] } });
    await prisma.customer.updateMany({ where: { id: { in: customerIds } }, data: { crPhotoId: null } });
    await prisma.branch.updateMany({ where: { id: { in: branchIds } }, data: { shopPhotoId: null, signboardPhotoId: null } });
    await purgeCustomerEdits(prisma, { where: { id: { in: editIds } } });
    await prisma.attachment.deleteMany({ where: { OR: [{ id: { in: attachments } }, { capturedById: { in: users } }] } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.rateLimit.deleteMany({ where: { key: { in: users.flatMap((u) => [`edit:${u}`, `edit-draft:${u}`]) } } });
    await prisma.user.updateMany({ where: { id: { in: users } }, data: { ownedRouteId: null, supervisorId: null } });
    await prisma.user.update({ where: { id: ids.accountant }, data: { managedRegions: { set: [] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    if (ids.route) await prisma.route.deleteMany({ where: { id: ids.route } });
    if (ids.region) await prisma.region.deleteMany({ where: { id: ids.region } });
    await purgeHistory(prisma, {
      customerIds,
      branchIds,
      userIds: users,
      routeIds: ids.route ? [ids.route] : [],
      regionIds: ids.region ? [ids.region] : [],
      attachmentIds: attachments,
      editIds,
    });
  }

  return { tag, TAG, ids, as, setup, cashBody, decide, cleanup, photo };
}
