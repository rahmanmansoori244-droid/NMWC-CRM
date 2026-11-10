/**
 * lib/leave-guard.ts (code review 2026-11-10, finding 4): leaving the
 * new-customer form or the signed-application upload with unsent work on it.
 * A reload or closing the tab asks first; a tap on a link to another page of
 * the app asks first, and "stay" stops the link before next/link can navigate;
 * pulling down at the top of the page does not reload it. A submit that
 * arrived, a withdraw and Sign out leave without a question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import postcss from 'postcss';
import {
  LEAVE_FORM_LOST_QUESTION,
  LEAVE_FORM_QUESTION,
  NO_PULL_REFRESH_CLASS,
  allowLeave,
  useLeaveGuard,
  useNoPullToRefresh,
} from '@/lib/leave-guard';
import { announceSignOut } from '@/lib/device-drafts';

const clicked = vi.fn();

function Guarded({ active, question }: { active: boolean; question?: string }) {
  useLeaveGuard(active, question);
  // The React handler stands for next/link's own: it navigates from onClick.
  // It prevents the default itself, as next/link does (and jsdom cannot navigate).
  const go = (e: ReactMouseEvent) => {
    e.preventDefault();
    clicked();
  };
  return (
    <nav>
      <a href="/today" onClick={go}>
        Today
      </a>
      <a href="/customers/new?edit=e1" onClick={go}>
        <span>Another request</span>
      </a>
      <a href="#branch-2" onClick={go}>
        Branch 2
      </a>
      <a href="https://maps.example.test/?q=23.5,58.3" onClick={go}>
        Directions
      </a>
      <a href="/customers" target="_blank" rel="noreferrer" onClick={go}>
        Customers in a new tab
      </a>
      <a href="/api/export" download onClick={go}>
        Download
      </a>
      <button type="button" onClick={clicked}>
        Save draft
      </button>
    </nav>
  );
}

/** A real, cancelable beforeunload; true when the page asked the browser to hold it. */
function unloadIsHeld(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

const spyOnConfirm = () => vi.spyOn(window, 'confirm');
let confirm: ReturnType<typeof spyOnConfirm>;

beforeEach(() => {
  clicked.mockReset();
  confirm = spyOnConfirm().mockReturnValue(false);
  window.history.replaceState(null, '', '/customers/new');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.className = '';
});

describe('a reload or closing the tab', () => {
  it('asks only while there is unsent work', () => {
    const view = render(<Guarded active={false} />);
    expect(unloadIsHeld()).toBe(false);
    view.rerender(<Guarded active />);
    expect(unloadIsHeld()).toBe(true);
    view.rerender(<Guarded active={false} />);
    expect(unloadIsHeld()).toBe(false);
  });

  it('stops asking when the form is gone', () => {
    const view = render(<Guarded active />);
    expect(unloadIsHeld()).toBe(true);
    view.unmount();
    expect(unloadIsHeld()).toBe(false);
  });
});

describe('a tap on a link to another page of the app', () => {
  it('asks in the app\'s words; "stay" stops the link before its own handler runs', () => {
    render(<Guarded active />);
    const tap = fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(LEAVE_FORM_QUESTION);
    expect(tap, 'the browser\'s own navigation was prevented').toBe(false);
    expect(clicked, 'next/link never saw the tap').not.toHaveBeenCalled();
    // Still guarded: the next tap asks again.
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(unloadIsHeld()).toBe(true);
  });

  it('"leave" lets the link through, and a document load that follows is not asked about again', () => {
    confirm.mockReturnValue(true);
    render(<Guarded active />);
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(unloadIsHeld()).toBe(false);
  });

  it('a tap inside the link counts, and so does a link to the same page with another query', () => {
    render(<Guarded active />);
    fireEvent.click(screen.getByText('Another request'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(clicked).not.toHaveBeenCalled();
  });

  it('says it differently when the phone could not keep the copy', () => {
    render(<Guarded active question={LEAVE_FORM_LOST_QUESTION} />);
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).toHaveBeenCalledWith(LEAVE_FORM_LOST_QUESTION);
    expect(LEAVE_FORM_QUESTION).toContain('kept on this phone');
    expect(LEAVE_FORM_LOST_QUESTION).toContain('will be lost');
  });

  it('with nothing unsent, no link asks', () => {
    render(<Guarded active={false} />);
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});

describe('what does not leave the form is not asked about', () => {
  it.each([
    ['a place on the same page', 'Branch 2'],
    ['another site (it opens over the app; the browser asks itself)', 'Directions'],
    ['a link that opens a new tab', 'Customers in a new tab'],
    ['a download', 'Download'],
  ])('%s', (_what, name) => {
    render(<Guarded active />);
    fireEvent.click(screen.getByRole('link', { name }));
    expect(confirm).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('a button', () => {
    render(<Guarded active />);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    'a tap that opens elsewhere (%o)',
    (init) => {
      render(<Guarded active />);
      fireEvent.click(screen.getByRole('link', { name: 'Today' }), init);
      expect(confirm).not.toHaveBeenCalled();
    }
  );

  it('a tap something else has already taken (its default prevented before the guard saw it)', () => {
    // A listener on the window in the same phase, there before the form mounted, runs first.
    const first = (e: Event) => e.preventDefault();
    window.addEventListener('click', first, true);
    try {
      render(<Guarded active />);
      fireEvent.click(screen.getByRole('link', { name: 'Today' }));
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('click', first, true);
    }
  });
});

describe('leaving on purpose asks nothing', () => {
  it('allowLeave() — a submit that arrived, a withdraw (lib/navigate.ts hardReplace calls it)', () => {
    render(<Guarded active />);
    allowLeave();
    expect(unloadIsHeld()).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('hardReplace says so before the document load starts', () => {
    const src = readFileSync('lib/navigate.ts', 'utf8');
    const body = src.slice(src.indexOf('export function hardReplace'));
    expect(body.indexOf('allowLeave();')).toBeGreaterThan(-1);
    expect(body.indexOf('allowLeave();')).toBeLessThan(body.indexOf('window.location.replace(url)'));
  });

  it('Sign out — it has asked its own question', () => {
    render(<Guarded active />);
    announceSignOut();
    expect(unloadIsHeld()).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a form that is still there afterwards asks again from its next unsent change', () => {
    const view = render(<Guarded active />);
    allowLeave();
    expect(unloadIsHeld()).toBe(false);
    // Saved (nothing unsent), then he adds a photo.
    view.rerender(<Guarded active={false} />);
    view.rerender(<Guarded active />);
    expect(unloadIsHeld()).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Today' }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('pull-to-refresh is switched off while a guarded form is open', () => {
  function Form({ on }: { on: boolean }) {
    useNoPullToRefresh(on);
    return null;
  }
  const has = () => document.documentElement.classList.contains(NO_PULL_REFRESH_CLASS);

  it('the class is on <html> while the form is open, and off when it closes', () => {
    const view = render(<Form on />);
    expect(has()).toBe(true);
    view.rerender(<Form on={false} />);
    expect(has()).toBe(false);
    view.rerender(<Form on />);
    expect(has()).toBe(true);
    view.unmount();
    expect(has()).toBe(false);
  });

  it('two forms share the page: the class stays until the last one closes', () => {
    const upload = render(<Form on />);
    const form = render(<Form on />);
    upload.unmount();
    expect(has(), 'the request form is still open').toBe(true);
    form.unmount();
    expect(has()).toBe(false);
  });

  it('app/globals.css stops the page\'s scroll at its top for that class — on <html> and on <body>, outside any @layer', () => {
    const root = postcss.parse(readFileSync('app/globals.css', 'utf8'));
    const rules: postcss.Rule[] = [];
    root.walkRules((r) => {
      if (r.selectors.some((s) => s.includes(`.${NO_PULL_REFRESH_CLASS}`))) rules.push(r);
    });
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.selectors.map((s) => s.trim()).sort()).toEqual(
      [`html.${NO_PULL_REFRESH_CLASS}`, `html.${NO_PULL_REFRESH_CLASS} body`].sort()
    );
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    expect(decls).toEqual({ 'overscroll-behavior-y': 'contain' });
    // Tailwind drops a layered rule whose class it does not find in app/ or
    // components/; this class is only ever set from lib/leave-guard.ts.
    expect(rule.parent?.type, 'not inside @layer').toBe('root');
  });
});
