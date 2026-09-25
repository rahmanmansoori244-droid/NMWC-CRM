/**
 * components/nmwc/SubmitNoticeBox (benchmark item 22): a failure is an alert
 * with Try again when retrying can help; "Already received" is a status, in
 * green, with nothing to press. The Try again button is a real 44 px target.
 * Both live regions stay mounted, empty, so a notice is read out when it
 * appears (one inserted already filled in often is not).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SubmitNoticeBox } from '@/components/nmwc/SubmitNoticeBox';

afterEach(cleanup);

describe('SubmitNoticeBox', () => {
  it('without a notice, both live regions are mounted and empty', () => {
    render(<SubmitNoticeBox notice={null} onRetry={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('');
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a notice arriving fills the region that was already there', () => {
    const { rerender } = render(<SubmitNoticeBox notice={null} onRetry={() => {}} />);
    const region = screen.getByRole('status');
    rerender(<SubmitNoticeBox notice={{ tone: 'received', text: '✓ Saved.' }} onRetry={() => {}} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('✓ Saved.');
  });

  it('a failure is announced, and Try again repeats the submit', () => {
    const onRetry = vi.fn();
    render(
      <SubmitNoticeBox notice={{ tone: 'failed', text: 'No answer.', retry: true }} onRetry={onRetry} />
    );
    expect(screen.getByRole('alert').textContent).toContain('No answer.');
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('Try again is disabled and says so while the retry is in flight', () => {
    render(
      <SubmitNoticeBox notice={{ tone: 'failed', text: 'x', retry: true }} onRetry={() => {}} busy />
    );
    const button = screen.getByRole('button', { name: 'Trying…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('an answered error that retrying cannot fix has no Try again', () => {
    render(<SubmitNoticeBox notice={{ tone: 'failed', text: 'Locked.', retry: false }} onRetry={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('Locked.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('"Already received" is a status, not an alert, with nothing to press', () => {
    render(<SubmitNoticeBox notice={{ tone: 'received', text: '✓ Already received.' }} onRetry={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('✓ Already received.');
    expect(screen.getByRole('alert').textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
