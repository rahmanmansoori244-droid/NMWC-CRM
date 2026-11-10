/**
 * Code review 2026-11-10, finding 18 — components/nmwc/SendBackTrail.tsx: the
 * lines a salesman's page adds beside its reason.
 *
 *   "Sent back by {name} at the {Step} step, {when}."   who, where, when
 *   "Earlier in this round:" + one line per send-back    the reasons before it
 *
 * Older rows have no decision row to read a step from, and some no reviewer:
 * the sentence says what is on record and nothing it does not know.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import {
  EarlierSendBacks,
  SendBackWho,
  atStepText,
  earlierSendBackText,
  sendBackWhoText,
} from '@/components/nmwc/SendBackTrail';
import type { SendBack } from '@/lib/request-reasons';
import { omanDateTime } from '@/lib/tz';

afterEach(cleanup);

const AT = new Date('2026-11-10T06:05:09Z'); // 10:05:09 in Oman
const WHEN = '10/11/2026, 10:05:09';
const full: SendBack = { step: 'Supervisor', stepIndex: 0, by: 'Manager Muna', at: AT, reason: 'Phone number format is incorrect' };
const when = (d: Date) => omanDateTime(d);

describe('sendBackWhoText', () => {
  it('who, at which step, when — on the Oman clock the page uses', () => {
    expect(sendBackWhoText(full, when)).toBe(`Sent back by Manager Muna at the Supervisor step, ${WHEN}.`);
  });

  it('an older row with no step on record', () => {
    expect(sendBackWhoText({ ...full, step: null, stepIndex: null }, when)).toBe(`Sent back by Manager Muna, ${WHEN}.`);
  });

  it('no reviewer on record', () => {
    expect(sendBackWhoText({ ...full, step: null, stepIndex: null, by: null }, when)).toBe(`Sent back ${WHEN}.`);
    expect(sendBackWhoText({ ...full, by: null }, when)).toBe(`Sent back at the Supervisor step, ${WHEN}.`);
  });

  it('no time on record, and nothing at all', () => {
    expect(sendBackWhoText({ ...full, at: null }, when)).toBe('Sent back by Manager Muna at the Supervisor step.');
    expect(sendBackWhoText({ step: null, stepIndex: null, by: null, at: null, reason: 'x' }, when)).toBeNull();
  });

  it('never prints the reason: the page’s own sentence does', () => {
    expect(sendBackWhoText(full, when)).not.toContain('Phone number');
  });
});

describe('earlierSendBackText and atStepText', () => {
  it('step — who, when: reason', () => {
    expect(earlierSendBackText({ ...full, step: 'Accountant', by: 'Acc One', reason: 'CR number does not match the photo' }, when)).toBe(
      `Accountant step — Acc One, ${WHEN}: CR number does not match the photo`
    );
  });

  it('says only what is on record', () => {
    expect(earlierSendBackText({ ...full, by: null }, when)).toBe(`Supervisor step — ${WHEN}: Phone number format is incorrect`);
    expect(earlierSendBackText({ ...full, by: null, at: null }, when)).toBe('Supervisor step: Phone number format is incorrect');
    expect(earlierSendBackText({ ...full, reason: null }, when)).toBe(`Supervisor step — Manager Muna, ${WHEN}: no reason on record`);
  });

  it('"At the {Step} step", or nothing on an older row', () => {
    expect(atStepText(full)).toBe('At the Supervisor step');
    expect(atStepText({ ...full, step: null })).toBeNull();
  });
});

describe('the components', () => {
  it('SendBackWho renders the sentence in one paragraph, or nothing', () => {
    const { container, rerender } = render(<SendBackWho entry={full} when={when} className="mt-1" />);
    const p = screen.getByText(`Sent back by Manager Muna at the Supervisor step, ${WHEN}.`);
    expect(p.tagName).toBe('P');
    expect(p.className).toBe('mt-1');
    rerender(<SendBackWho entry={{ step: null, stepIndex: null, by: null, at: null, reason: null }} when={when} />);
    expect(container.innerHTML).toBe('');
  });

  it('EarlierSendBacks lists them oldest first under its heading, and renders nothing when there are none', () => {
    const earlier: SendBack[] = [
      { step: 'Accountant', stepIndex: 1, by: 'Acc One', at: AT, reason: 'CR number does not match the photo' },
      { step: 'GM', stepIndex: 4, by: 'GM One', at: AT, reason: 'Limit too high' },
    ];
    const { container, rerender } = render(<EarlierSendBacks earlier={earlier} when={when} />);
    expect(screen.getByText('Earlier in this round:')).toBeTruthy();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      `Accountant step — Acc One, ${WHEN}: CR number does not match the photo`,
      `GM step — GM One, ${WHEN}: Limit too high`,
    ]);
    rerender(<EarlierSendBacks earlier={earlier.slice(1)} when={when} heading="Before that, in this round:" />);
    expect(screen.getByText('Before that, in this round:')).toBeTruthy();
    expect(screen.queryByText('Earlier in this round:')).toBeNull();
    rerender(<EarlierSendBacks earlier={[]} when={when} />);
    expect(container.innerHTML).toBe('');
  });
});
