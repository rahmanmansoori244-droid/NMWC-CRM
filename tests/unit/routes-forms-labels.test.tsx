/**
 * Launch browser suite follow-up (8 Oct): the /routes forms name their fields
 * and read out a refusal.
 *
 * Create region and Create route rendered every label as a bare <label> beside a
 * bare control (the Input helper's Code and Name, and the Region select): a
 * screen reader read unnamed fields, a tap on a label focused nothing, and
 * getByLabel found none of them. A refusal under a field was plain red text,
 * neither read out nor tied to its field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({ createRegion: vi.fn(), createRoute: vi.fn() }));

vi.mock('@/services/routes', () => ({
  createRegionAction: h.createRegion,
  createRouteAction: h.createRoute,
  toggleRegionActiveAction: vi.fn(),
  toggleRouteActiveAction: vi.fn(),
}));

import { CreateRegionForm, CreateRouteForm } from '@/app/(app)/routes/forms';

const regions = [{ id: 'g1', code: 'MCT', name: 'Muscat' }];

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/** The field's error is its description, it is marked invalid, and the error is an alert. */
function expectTiedError(field: HTMLElement, words: string) {
  expect(field.getAttribute('aria-invalid')).toBe('true');
  const error = document.getElementById(field.getAttribute('aria-describedby') ?? '');
  expect(error?.textContent).toBe(words);
  expect(error?.getAttribute('role')).toBe('alert');
}

describe('Create region', () => {
  it('every field is found by its label', () => {
    render(<CreateRegionForm />);
    expect(screen.getByLabelText('Code *').getAttribute('name')).toBe('code');
    expect(screen.getByLabelText('Name *').getAttribute('name')).toBe('name');
    expect(screen.getByLabelText('Code *').getAttribute('aria-invalid')).toBeNull();
  });

  it('a refusal under a field is read out and tied to the field', async () => {
    h.createRegion.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { code: 'That code is taken.' },
    });
    const { container } = render(<CreateRegionForm />);
    fireEvent.submit(container.querySelector('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe('That code is taken.');
    expectTiedError(screen.getByLabelText('Code *'), 'That code is taken.');
    expect(screen.getByLabelText('Name *').getAttribute('aria-invalid')).toBeNull();
  });

  it('a refusal of the whole form is read out', async () => {
    h.createRegion.mockResolvedValue({ ok: false, code: 'FORBIDDEN', message: 'Only the Steward creates regions.' });
    const { container } = render(<CreateRegionForm />);
    fireEvent.submit(container.querySelector('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe('Only the Steward creates regions.');
  });
});

describe('Create route', () => {
  it('every field is found by its label, the Region select included', () => {
    render(<CreateRouteForm regions={regions} />);
    expect(screen.getByLabelText('Code *').getAttribute('name')).toBe('code');
    expect(screen.getByLabelText('Name *').getAttribute('name')).toBe('name');
    const region = screen.getByRole('combobox', { name: 'Region *' });
    expect(region.getAttribute('name')).toBe('regionId');
    expect(region).toBe(screen.getByLabelText('Region *'));
  });

  it('two forms on the page give their fields different ids', () => {
    render(
      <>
        <CreateRegionForm />
        <CreateRouteForm regions={regions} />
      </>
    );
    const codes = screen.getAllByLabelText('Code *');
    expect(codes).toHaveLength(2);
    expect(codes[0]!.id).not.toBe(codes[1]!.id);
  });

  it('each refusal under a field is read out and tied to its field', async () => {
    h.createRoute.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { name: 'A name is required.', regionId: 'Pick a region.' },
    });
    const { container } = render(<CreateRouteForm regions={regions} />);
    fireEvent.submit(container.querySelector('form')!);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent)).toEqual(['A name is required.', 'Pick a region.']);
    expectTiedError(screen.getByLabelText('Name *'), 'A name is required.');
    expectTiedError(screen.getByLabelText('Region *'), 'Pick a region.');
    expect(screen.getByLabelText('Code *').getAttribute('aria-invalid')).toBeNull();
  });
});
