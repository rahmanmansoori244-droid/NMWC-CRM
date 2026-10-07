/**
 * Launch review, Arabic input end to end: numbers typed on an Arabic keyboard.
 *
 * Phones and CR numbers have folded Arabic-Indic digits for a long time
 * (lib/phone.ts, lib/cr.ts), but a credit limit, a payment term and a typed-in
 * latitude/longitude went through Number() / parseFloat() as typed, and both
 * read '٥٠٠' as NaN: the new-customer form listed the credit figures as
 * missing (and a draft sent them as null), and the GPS fallback said "Enter
 * valid latitude and longitude numbers." lib/digits.ts folds them; the CREATE
 * schema folds any that arrive as text. Each part is driven here: the helper,
 * the schema, the real form and the real GPS button (jsdom).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);

import { asciiDigits, foldNumberInput, numberText, typedDecimal, typedNumber } from '@/lib/digits';
import { submitCreateSchema } from '@/lib/validation/create';
import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';
import { GpsCaptureButton, type Gps } from '@/components/nmwc/GpsCaptureButton';
import { StepperInput } from '@/components/nmwc/StepperInput';

// Written as escapes, as lib/digits.ts is: U+0660.. Arabic-Indic, U+06F0..
// Persian, U+066B the Arabic decimal mark, U+066C the thousands mark, U+200F a
// right-to-left mark of the kind copied Arabic text carries.
const AR = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const FA = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
const DEC = '\u066B';
const THOU = '\u066C';
const RLM = '\u200F';
// U+060C, the comma key on an Arabic layout.
const AR_COMMA = '\u060C';

describe('lib/digits', () => {
  it('folds Arabic-Indic and Persian digits, the Arabic decimal and thousands marks, and bidi marks', () => {
    expect(asciiDigits(AR('0123456789'))).toBe('0123456789');
    expect(asciiDigits(FA('0123456789'))).toBe('0123456789');
    expect(numberText(`${RLM} ${AR('1')}${THOU}${AR('500')}${DEC}${AR('25')} `)).toBe('1500.25');
    expect(numberText(`${AR('23')}${DEC}${AR('5880')}`)).toBe('23.5880');
    // The Latin comma is left alone: each caller keeps its own rule for it.
    expect(numberText('12,5')).toBe('12,5');
  });

  it('typedNumber: the number typed, NaN when blank or not a number', () => {
    expect(typedNumber(AR('500'))).toBe(500);
    expect(typedNumber(`${FA('30')}`)).toBe(30);
    expect(typedNumber(' 750.5 ')).toBe(750.5);
    expect(typedNumber('')).toBeNaN();
    expect(typedNumber('   ')).toBeNaN();
    expect(typedNumber('12,5')).toBeNaN();
    expect(typedNumber('abc')).toBeNaN();
  });

  it('typedDecimal: a comma of either script is the decimal point, and the whole text must be the number', () => {
    expect(typedDecimal(`${AR('23')}${AR_COMMA}${AR('587')}`)).toBe(23.587);
    expect(typedDecimal(`23${AR_COMMA}587`)).toBe(23.587);
    expect(typedDecimal('23,587')).toBe(23.587);
    expect(typedDecimal(`${AR('23')}${DEC}${AR('587')}`)).toBe(23.587);
    expect(typedDecimal(' -23.5 ')).toBe(-23.5);
    expect(typedDecimal('.5')).toBe(0.5);
    // parseFloat read each of these as 23, a point inside Oman.
    expect(typedDecimal(`${AR('23')} ${AR('587')}`)).toBeNaN();
    expect(typedDecimal('23 587')).toBeNaN();
    expect(typedDecimal('23.5.8')).toBeNaN();
    expect(typedDecimal('23,5,8')).toBeNaN();
    expect(typedDecimal('23.5°')).toBeNaN();
    expect(typedDecimal('23.588, 58.382')).toBeNaN();
    // Number() alone would take these.
    expect(typedDecimal('0x17')).toBeNaN();
    expect(typedDecimal('2.3e1')).toBeNaN();
    expect(typedDecimal('')).toBeNaN();
    expect(typedDecimal('-')).toBeNaN();
  });

  it('foldNumberInput folds text and passes anything else through', () => {
    expect(foldNumberInput(AR('42'))).toBe('42');
    expect(foldNumberInput(42)).toBe(42);
    expect(foldNumberInput(null)).toBeNull();
    expect(foldNumberInput(undefined)).toBeUndefined();
  });
});

const CUID = 'ckzzzzzzzz0000zzzzzzzzzzzz';
const CUID2 = 'ckzzzzzzzz0001zzzzzzzzzzzz';
const CUID3 = 'ckzzzzzzzz0002zzzzzzzzzzzz';
const creditInput = (credit: Record<string, unknown>) => ({
  isDraft: false,
  customer: {
    legalName: 'مؤسسة النور',
    paymentTerms: 'CREDIT',
    crNumber: AR('1234567'),
    channelId: CUID,
    subChannelId: CUID2,
    primaryPhone: AR('91234567'),
    contactPerson: 'سعيد',
    crPhotoAttachmentId: CUID3,
  },
  credit,
  guaranteeAttachmentIds: [CUID],
  branches: [
    {
      branchName: 'الفرع الرئيسي',
      address: 'طريق ١٢٣، الخوير',
      gpsLat: 23.6,
      gpsLng: 58.5,
      dayOfVisit: 'MON',
      shopPhotoAttachmentId: CUID,
      signboardPhotoAttachmentId: CUID2,
    },
  ],
});

describe('the CREATE schema reads credit figures sent as Arabic text', () => {
  it('folds them before it coerces', () => {
    const r = submitCreateSchema.safeParse(
      creditInput({ requestedCreditLimit: `${AR('1')}${THOU}${AR('500')}${DEC}${AR('125')}`, requestedPaymentTermDays: AR('30') })
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.credit).toEqual({ requestedCreditLimit: 1500.125, requestedPaymentTermDays: 30 });
      // Arabic text fields pass untouched.
      expect(r.data.customer.legalName).toBe('مؤسسة النور');
    }
  });

  it('numbers, and the old refusals, are as they were', () => {
    const ok = submitCreateSchema.safeParse(creditInput({ requestedCreditLimit: 500, requestedPaymentTermDays: 30 }));
    expect(ok.success && ok.data.credit).toEqual({ requestedCreditLimit: 500, requestedPaymentTermDays: 30 });
    const zero = submitCreateSchema.safeParse(creditInput({ requestedCreditLimit: AR('0') }));
    expect(zero.success).toBe(false);
    if (!zero.success) expect(zero.error.issues[0]!.message).toBe('Credit limit must be greater than zero.');
    const days = submitCreateSchema.safeParse(creditInput({ requestedPaymentTermDays: `${AR('1')}${DEC}${AR('5')}` }));
    expect(days.success).toBe(false);
    const absent = submitCreateSchema.safeParse(creditInput({}));
    expect(absent.success && absent.data.credit).toEqual({});
  });
});

describe('the new-customer form takes credit figures typed in Arabic digits', () => {
  let bodies: Array<{ isDraft?: boolean; credit?: unknown }> = [];
  beforeEach(() => {
    bodies = [];
    nav.hardReplace.mockReset();
    window.localStorage.clear();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (!url.startsWith('/api/forms/')) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return new Response(
        JSON.stringify({ ok: true, data: { editId: 'd7', state: body.isDraft ? 'DRAFT' : 'SUBMITTED', submittedAt: null, replayed: false } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const initial: CreateFormInitial = {
    editId: 'd7',
    state: 'DRAFT',
    decisionReason: null,
    pendingRole: null,
    customer: {
      legalName: 'مؤسسة النور',
      paymentTerms: 'CREDIT',
      crNumber: '7654321',
      channelId: 'ch1',
      subChannelId: 'sc1',
      primaryPhone: '+96891234567',
      altPhone: '',
      contactPerson: 'سعيد',
      contactRole: '',
      notes: '',
      crPhotoAttachmentId: 'att-cr',
    },
    credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
    guaranteeAttachmentIds: ['g1'],
    branches: [
      {
        branchName: 'Main',
        address: 'Way 1, Ruwi',
        areaDescription: '',
        gpsLat: 23.5,
        gpsLng: 58.3,
        gpsAccuracy: 5,
        gpsCapturedAt: '2026-09-24T08:00:00.000Z',
        gpsManualReason: null,
        dayOfVisit: 'SUN',
        openingHours: '',
        deliveryWindow: '',
        coolersCount: 0,
        standsCount: 0,
        emptyBottlesCount: 0,
        shopPhotoAttachmentId: 'att-shop',
        signboardPhotoAttachmentId: 'att-sign',
        extraPhotoAttachmentIds: [],
      },
    ],
  };
  const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];
  const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });

  it('Arabic digits are not "missing", and the request carries them as numbers', async () => {
    render(<CreateCustomerForm channels={channels} initial={initial} sessionUserId="u1" />);
    await waitFor(() => expect(submitBtn().getAttribute('title')).toBe('Missing: Credit limit, Payment term days'));
    fireEvent.change(screen.getByLabelText('Requested credit limit (OMR) *'), {
      target: { value: `${AR('1')}${THOU}${AR('500')}${DEC}${AR('5')}` },
    });
    fireEvent.change(screen.getByLabelText('Requested payment term (days) *'), { target: { value: AR('30') } });
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    expect(submitBtn().getAttribute('title')).toBe('');
    expect(screen.queryByText(/Cannot submit yet/)).toBeNull();
    fireEvent.click(submitBtn());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.credit).toEqual({ requestedCreditLimit: 1500.5, requestedPaymentTermDays: 30 });
  });

  it('a comma or a word is still missing, as before', async () => {
    render(<CreateCustomerForm channels={channels} initial={initial} sessionUserId="u1" />);
    fireEvent.change(screen.getByLabelText('Requested credit limit (OMR) *'), { target: { value: '12,5' } });
    fireEvent.change(screen.getByLabelText('Requested payment term (days) *'), { target: { value: 'thirty' } });
    await waitFor(() => expect(submitBtn().getAttribute('title')).toBe('Missing: Credit limit, Payment term days'));
    expect(submitBtn()).toBeDisabled();
  });
});

describe('the GPS fallback takes a point typed in Arabic digits', () => {
  afterEach(() => cleanup());

  function typePoint(lat: string, lng: string) {
    const onCapture = vi.fn<(g: Gps) => void>();
    render(<GpsCaptureButton onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: /Enter coordinates manually/ }));
    const boxes = screen.getAllByRole('textbox');
    fireEvent.change(boxes[0]!, { target: { value: lat } });
    fireEvent.change(boxes[1]!, { target: { value: lng } });
    fireEvent.change(boxes[2]!, { target: { value: 'نظام تحديد المواقع لا يعمل' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual location' }));
    return onCapture;
  }

  it('with the Arabic decimal mark', () => {
    const onCapture = typePoint(`${AR('23')}${DEC}${AR('5880')}`, `${RLM}${AR('58')}${DEC}${AR('3829')}`);
    expect(screen.queryByText('Enter valid latitude and longitude numbers.')).toBeNull();
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture.mock.calls[0]![0]).toMatchObject({ lat: 23.588, lng: 58.3829, isManual: true });
  });

  it('with Persian digits and a comma decimal', () => {
    const onCapture = typePoint(`${FA('23')},${FA('6')}`, `${FA('58')},${FA('5')}`);
    expect(onCapture.mock.calls[0]![0]).toMatchObject({ lat: 23.6, lng: 58.5 });
  });

  it('a point that is not a number is still refused', () => {
    const onCapture = typePoint('north', AR('58'));
    expect(screen.getByText('Enter valid latitude and longitude numbers.')).toBeTruthy();
    expect(onCapture).not.toHaveBeenCalled();
  });

  it('with the Arabic comma, the comma key on an Arabic layout', () => {
    const onCapture = typePoint(`${AR('23')}${AR_COMMA}${AR('587')}`, `58${AR_COMMA}382`);
    expect(screen.queryByText('Enter valid latitude and longitude numbers.')).toBeNull();
    expect(onCapture.mock.calls[0]![0]).toMatchObject({ lat: 23.587, lng: 58.382, isManual: true });
  });

  // parseFloat kept the digits before the first character it did not read:
  // each of these was saved as latitude 23, inside Oman, with no warning.
  it.each([
    ['a space for the decimal point', `${AR('23')} ${AR('587')}`],
    ['two decimal points', '23.5.87'],
    ['both numbers in one box', '23.587, 58.382'],
  ])('%s is refused, not cut short', (_name, lat) => {
    const onCapture = typePoint(lat, '58.382');
    expect(screen.getByText('Enter valid latitude and longitude numbers.')).toBeTruthy();
    expect(onCapture).not.toHaveBeenCalled();
  });
});

// The cooler, stand and empty-bottle counts on both forms. The box kept only
// ASCII 0-9, so '٣' was read as blank and the count went to 0; and as a
// type=number box the browser itself blanked text it could not read as a
// number before the handler saw it (jsdom does the same, which this drives).
describe('the count steppers take a count typed in Arabic digits', () => {
  afterEach(() => cleanup());

  function typeCount(typed: string, value = 0) {
    const onChange = vi.fn<(n: number) => void>();
    render(<StepperInput name="coolers" label="Coolers" value={value} onChange={onChange} max={1000} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Coolers' }), { target: { value: typed } });
    return onChange;
  }

  it.each([
    ['Arabic-Indic digits', AR('3'), 3],
    ['Persian digits', FA('12'), 12],
    ['Arabic digits with a copied bidi mark', `${RLM}${AR('250')}`, 250],
    ['ASCII digits, as before', '7', 7],
  ])('%s', (_name, typed, n) => {
    expect(typeCount(typed)).toHaveBeenLastCalledWith(n);
  });

  it('the count is still held to its maximum', () => {
    expect(typeCount(AR('5000'))).toHaveBeenLastCalledWith(1000);
  });

  it('a blank box is still the minimum', () => {
    expect(typeCount('', 4)).toHaveBeenLastCalledWith(0);
  });

  it('keeps the spin-button semantics, the arrow keys included', () => {
    const onChange = vi.fn<(n: number) => void>();
    render(<StepperInput name="coolers" label="Coolers" value={2} onChange={onChange} />);
    const box = screen.getByRole('spinbutton', { name: 'Coolers' });
    expect(box.getAttribute('aria-valuenow')).toBe('2');
    expect(box.getAttribute('aria-valuemin')).toBe('0');
    expect(box.getAttribute('aria-valuemax')).toBe('100');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
