/**
 * The master side of the customer-upload check: which live customers already
 * hold a phone or CR a sheet row carries. Shared by the upload and by the
 * Steward's in-app fix of a held-back row (benchmark item 20), so a fixed row
 * is checked against the master exactly as an uploaded one is.
 *
 * Keyed by the OWNING nmwcCode so a row that updates its own customer (a
 * re-import or a Temix refresh of the existing master) does not self-collide —
 * this once used bare Sets and every refresh row of a known customer was
 * quarantined against itself.
 */
import { prisma } from '@/lib/db';

export async function masterCollisionMaps(
  phones: string[],
  crs: string[]
): Promise<{ masterPhones: Map<string, string[]>; masterCrs: Map<string, string[]> }> {
  const masterPhones = new Map<string, string[]>();
  if (phones.length) {
    for (const c of await prisma.customer.findMany({
      where: { primaryPhoneNorm: { in: phones }, deletedAt: null },
      select: { primaryPhoneNorm: true, nmwcCode: true },
    })) {
      if (!c.primaryPhoneNorm) continue;
      const a = masterPhones.get(c.primaryPhoneNorm) ?? [];
      a.push(c.nmwcCode);
      masterPhones.set(c.primaryPhoneNorm, a);
    }
  }
  const masterCrs = new Map<string, string[]>();
  if (crs.length) {
    for (const c of await prisma.customer.findMany({
      where: { crNumberNorm: { in: crs }, deletedAt: null },
      select: { crNumberNorm: true, nmwcCode: true },
    })) {
      if (!c.crNumberNorm) continue;
      const a = masterCrs.get(c.crNumberNorm) ?? [];
      a.push(c.nmwcCode);
      masterCrs.set(c.crNumberNorm, a);
    }
  }
  return { masterPhones, masterCrs };
}
