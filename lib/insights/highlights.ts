/**
 * F2 — "What stands out": a few plain sentences drawn from the dashboard's own
 * aggregates, so the first thing on the page is a reading, not a chart.
 *
 * Pure. Every sentence is built only from figures already on the page, in the
 * viewer's own scope: no company figure, no comparison with another region or
 * Manager, no person and no route named (MANAGER_SEES_COMPANY_FIGURES,
 * ROUTE_LEVEL_ONLY). A sentence whose data failed to load is left out, and
 * highlightsCoverage tells the card whether that happened, so an outage never
 * reads as "nothing to report".
 */
import type { Insights } from './load';
import { changePct, pct, type HeatData } from './shape';

export type Highlight = { key: string; text: string };

/** The sections the sentences are read from. */
const SOURCES = ['state', 'created', 'updated', 'statusChanges', 'heat'] as const;

/** Whether every section the sentences read loaded ('all'), some did ('some'), or none did ('none'). */
export function highlightsCoverage(data: Insights): 'all' | 'some' | 'none' {
  const loaded = SOURCES.filter((k) => data[k].ok).length;
  return loaded === SOURCES.length ? 'all' : loaded === 0 ? 'none' : 'some';
}

const fmt = (v: number) => v.toLocaleString('en-GB');

/** The share of occupied map squares that hold half of the located branches, or null when it cannot be read. */
export function concentration(heat: HeatData): { squares: number; sharePct: number } | null {
  if (heat.totalCells < 10 || heat.located === 0) return null;
  const sorted = [...heat.cells].sort((a, b) => b.n - a.n);
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i]!.n;
    if (sum * 2 >= heat.located) {
      return { squares: i + 1, sharePct: Math.max(1, Math.round(((i + 1) / heat.totalCells) * 100)) };
    }
  }
  return null; // half the branches sit beyond the drawn cells: not readable from them
}

export function highlights(data: Insights, periodPhrase: string): Highlight[] {
  const out: Highlight[] = [];

  if (data.created.ok) {
    const c = data.created.data;
    const change = changePct(c.total, c.prevTotal);
    const trend =
      change === null
        ? c.prevTotal === 0 && c.total > 0
          ? ', against none in the period before'
          : ''
        : change === 0
          ? ', the same as the period before'
          : `, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on the period before`;
    out.push({
      key: 'created',
      text: `${fmt(c.total)} new customer${c.total === 1 ? '' : 's'} created in the field ${periodPhrase}${trend}.${
        c.credit > 0 ? ` ${fmt(c.credit)} of them on credit.` : ''
      }`,
    });
  }

  if (data.updated.ok && data.state.ok && data.state.data.total.customers > 0) {
    const u = data.updated.data;
    const share = pct(u.customers, data.state.data.total.customers);
    out.push({
      key: 'reach',
      text: `Approved updates reached ${share ?? 0}% of the customers in view (${fmt(u.customers)} of ${fmt(
        data.state.data.total.customers
      )})${u.directOnly > 0 ? `; ${fmt(u.directOnly)} of them only through a Manager's or Steward's direct write` : ''}.`,
    });
  }

  if (data.state.ok && data.created.ok && data.updated.ok) {
    // A route's own work only: a request on a chain customer counts on the route
    // of the branch it changed, not on every route the customer has a branch on.
    const touched = new Set([
      ...data.created.data.routes.map((r) => r.route.id),
      ...data.updated.data.routes.filter((r) => r.byRequestOnRoute > 0).map((r) => r.route.id),
    ]);
    const idle = data.state.data.routes.filter((r) => r.customers > 0 && !touched.has(r.route.id));
    if (idle.length > 0) {
      const unowned = idle.filter((r) => !r.route.hasOwner).length;
      out.push({
        key: 'idle',
        text: `${fmt(idle.length)} route${idle.length === 1 ? '' : 's'} with customers had no approved field request ${periodPhrase}${
          unowned > 0 ? `; ${fmt(unowned)} of them ha${unowned === 1 ? 's' : 've'} no salesman assigned` : ''
        }.`,
      });
    }
  }

  if (data.state.ok && data.state.data.total.open > 0) {
    const s = data.state.data;
    const missing = s.total.open - s.total.openWithGps;
    const rows = s.regions.length > 1 ? s.regions.map((r) => ({ name: r.region.name, gap: r.open - r.openWithGps, open: r.open })) : [];
    const worst = rows.sort((a, b) => b.gap - a.gap)[0];
    out.push({
      key: 'gps',
      text: `${pct(s.total.openWithGps, s.total.open) ?? 0}% of open branches in view have GPS; ${fmt(missing)} do not${
        worst && worst.gap > 0 ? `, the most in ${worst.name} (${fmt(worst.gap)}, ${pct(worst.gap, worst.open)}% of its open branches)` : ''
      }.`,
    });
    if (s.total.openNoDay > 0) {
      out.push({
        key: 'visit-day',
        text: `${fmt(s.total.openNoDay)} open branch${s.total.openNoDay === 1 ? ' has' : 'es have'} no visit day (${pct(
          s.total.openNoDay,
          s.total.open
        )}%), so no day of a salesman's Today list includes them.`,
      });
    }
  }

  if (data.heat.ok) {
    const conc = concentration(data.heat.data);
    if (conc) {
      out.push({
        key: 'concentration',
        text: `Half of the branches located on the map sit in ${fmt(conc.squares)} square${
          conc.squares === 1 ? '' : 's'
        } — ${conc.sharePct}% of the squares that hold any.`,
      });
    }
  }

  if (data.statusChanges.ok) {
    const s = data.statusChanges.data;
    if (s.closed > 0 || s.reactivated > 0) {
      out.push({
        key: 'closures',
        text: `${fmt(s.closed)} branch${s.closed === 1 ? '' : 'es'} closed and ${fmt(s.reactivated)} reactivated on approved field requests ${periodPhrase}.`,
      });
    }
  }

  return out;
}
