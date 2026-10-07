/**
 * Launch fix (2026-10-07): the Temix page shows the real refusal, and an older
 * batch awaiting confirmation stays reachable.
 *
 * What was wrong:
 *   - every refusal the Temix actions return carried its words in fields._form
 *     and read "Validation failed" as its message, and the buttons showed only
 *     the message (services/temix.ts now sets both; temix-service.test.ts pins
 *     the service, this file the buttons);
 *   - the batch history was the 20 newest batches with no paging, so a batch
 *     still awaiting confirmation that had dropped below them could no longer
 *     be re-downloaded or marked loaded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';

type Batch = { id: string; createdAt: Date; rowCount: number; markedLoadedAt: Date | null; createdBy: { fullName: string } };
const h = vi.hoisted(() => ({
  generate: vi.fn(),
  download: vi.fn(),
  mark: vi.fn(),
  refresh: vi.fn(),
  batches: [] as Batch[],
}));

vi.mock('@/services/temix', () => ({
  generateTemixBatchAction: h.generate,
  downloadTemixBatchAction: h.download,
  markTemixBatchLoadedAction: h.mark,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: h.refresh }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'stw', role: 'STEWARD', username: 'steward.x' } }) }));
vi.mock('@/lib/db', () => {
  type Args = { where?: { markedLoadedAt?: null }; skip?: number; take?: number };
  const sorted = () => [...h.batches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    prisma: {
      customer: { count: async () => 0 },
      temixSyncBatch: {
        count: async () => h.batches.length,
        findMany: async ({ where, skip = 0, take }: Args) => {
          const rows = sorted().filter((b) => (where && 'markedLoadedAt' in where ? b.markedLoadedAt === null : true));
          return rows.slice(skip, take === undefined ? undefined : skip + take);
        },
      },
    },
  };
});

import TemixPage from '@/app/(app)/temix/page';
import { GenerateBatchButton, BatchRowActions } from '@/app/(app)/temix/TemixActions';

const REFUSAL = (text: string) => ({ ok: false, code: 'VALIDATION_FAILED', message: 'Validation failed', fields: { _form: text } });

beforeEach(() => {
  vi.clearAllMocks();
  h.batches = [];
});
afterEach(cleanup);

describe('the Temix buttons show the refusal itself', () => {
  it('Generate: the queue emptied since the page loaded', async () => {
    h.generate.mockResolvedValue(REFUSAL('Nothing is pending for Temix upload.'));
    render(<GenerateBatchButton disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Generate upload file/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Generate & download' }));
    expect(await screen.findByText('Nothing is pending for Temix upload.')).toBeTruthy();
    expect(screen.queryByText('Validation failed')).toBeNull();
  });

  it('Mark loaded: another Steward marked it first', async () => {
    h.mark.mockResolvedValue(REFUSAL('This batch is already marked as loaded.'));
    render(<BatchRowActions batchId="b1" loaded={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark loaded' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, it is loaded' }));
    expect(await screen.findByText('This batch is already marked as loaded.')).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a refusal with only a message still shows it', async () => {
    h.download.mockResolvedValue({ ok: false, code: 'RATE_LIMITED', message: 'Wait 17s before downloading again.' });
    render(<BatchRowActions batchId="b1" loaded />);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText('Wait 17s before downloading again.')).toBeTruthy();
  });
});

describe('the batch history keeps every batch reachable', () => {
  function seed(n: number, awaitingIndex: number) {
    const base = Date.UTC(2026, 8, 1);
    h.batches = Array.from({ length: n }, (_, i) => ({
      id: `batch-${String(i).padStart(3, '0')}`,
      // i = 0 is the oldest.
      createdAt: new Date(base + i * 86_400_000),
      rowCount: 10,
      markedLoadedAt: i === awaitingIndex ? null : new Date(base + i * 86_400_000 + 3_600_000),
      createdBy: { fullName: 'Steward' },
    }));
  }
  const ids = (container: HTMLElement) =>
    [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td span')?.textContent ?? '');

  it('page 1 lists the 20 newest and also an older batch still awaiting confirmation', async () => {
    seed(25, 2);
    const { container } = render(await TemixPage({ searchParams: Promise.resolve({}) }));
    const rows = ids(container);
    expect(rows).toHaveLength(21);
    expect(rows.at(-1)).toBe('…ch-002');
    expect(screen.getAllByText('awaiting confirm')).toHaveLength(1);
    // Its own Mark loaded button is there.
    expect(screen.getAllByRole('button', { name: 'Mark loaded' })).toHaveLength(1);
  });

  it('the history pages: page 2 holds the rest', async () => {
    seed(25, 24);
    const first = render(await TemixPage({ searchParams: Promise.resolve({}) }));
    expect(ids(first.container)).toHaveLength(20);
    expect(screen.getByRole('link', { name: 'Older →' }).getAttribute('href')).toBe('/temix?page=2');
    cleanup();
    const second = render(await TemixPage({ searchParams: Promise.resolve({ page: '2' }) }));
    expect(ids(second.container)).toEqual(['…ch-004', '…ch-003', '…ch-002', '…ch-001', '…ch-000']);
    expect(screen.getByRole('link', { name: '← Newer' }).getAttribute('href')).toBe('/temix');
  });
});
