'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Role, type CustomerStatus, type DayOfWeek, type PaymentTerms } from '@prisma/client';
import { FormSection } from '@/components/nmwc/FormSection';
import { GpsCaptureButton, type Gps } from '@/components/nmwc/GpsCaptureButton';
import { StepperInput } from '@/components/nmwc/StepperInput';
import { PhotoCaptureSlot } from '@/components/nmwc/PhotoCaptureSlot';
import { submitEditAction } from '@/services/edits';
import { ValidationError, ConflictError } from '@/lib/errors';

type CustomerWithBranches = {
  id: string;
  nmwcCode: string;
  legalName: string;
  paymentTerms: PaymentTerms;
  crNumber: string | null;
  channelId: string | null;
  subChannelId: string | null;
  primaryPhone: string | null;
  altPhone: string | null;
  contactPerson: string | null;
  contactRole: string | null;
  status: CustomerStatus;
  notes: string | null;
  crPhotoId: string | null;
  branches: Array<{
    id: string;
    branchName: string;
    address: string;
    areaDescription: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    gpsAccuracy: number | null;
    gpsCapturedAt: Date | null;
    dayOfVisit: DayOfWeek | null;
    openingHours: string | null;
    deliveryWindow: string | null;
    coolersCount: number;
    standsCount: number;
    emptyBottlesCount: number;
    status: CustomerStatus;
    shopPhotoId: string | null;
    signboardPhotoId: string | null;
    region: { name: string };
    route: { code: string };
  }>;
};

type ChannelWithSubs = {
  id: string;
  key: string;
  label: string;
  subChannels: { id: string; key: string; label: string }[];
};

const DAYS: DayOfWeek[] = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'];

export function EnrichmentForm({
  customer,
  channels,
  lockNameAndCr,
  userRole,
  canSubmit,
}: {
  customer: CustomerWithBranches;
  channels: ChannelWithSubs[];
  lockNameAndCr: boolean;
  userRole: Role;
  canSubmit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<string | null>(null);

  // Customer-level state
  const [legalName, setLegalName] = useState(customer.legalName);
  const [crNumber, setCrNumber] = useState(customer.crNumber ?? '');
  const [channelId, setChannelId] = useState(customer.channelId ?? '');
  const [subChannelId, setSubChannelId] = useState(customer.subChannelId ?? '');
  const [primaryPhone, setPrimaryPhone] = useState(customer.primaryPhone ?? '');
  const [altPhone, setAltPhone] = useState(customer.altPhone ?? '');
  const [contactPerson, setContactPerson] = useState(customer.contactPerson ?? '');
  const [contactRole, setContactRole] = useState(customer.contactRole ?? '');
  const [status, setStatus] = useState<CustomerStatus>(customer.status);
  const [notes, setNotes] = useState(customer.notes ?? '');

  // Branch-level state — keyed by branch id
  type BState = {
    address: string;
    areaDescription: string;
    gps: Gps | null;
    dayOfVisit: DayOfWeek | '';
    openingHours: string;
    deliveryWindow: string;
    coolers: number;
    stands: number;
    bottles: number;
  };
  const [branchStates, setBranchStates] = useState<Record<string, BState>>(() => {
    const out: Record<string, BState> = {};
    for (const b of customer.branches) {
      out[b.id] = {
        address: b.address,
        areaDescription: b.areaDescription ?? '',
        gps:
          b.gpsLat != null && b.gpsLng != null
            ? {
                lat: b.gpsLat,
                lng: b.gpsLng,
                accuracy: b.gpsAccuracy ?? undefined,
                capturedAt: b.gpsCapturedAt ?? new Date(),
              }
            : null,
        dayOfVisit: b.dayOfVisit ?? '',
        openingHours: b.openingHours ?? '',
        deliveryWindow: b.deliveryWindow ?? '',
        coolers: b.coolersCount,
        stands: b.standsCount,
        bottles: b.emptyBottlesCount,
      };
    }
    return out;
  });

  // Available sub-channels for chosen channel
  const subChannels = channels.find((c) => c.id === channelId)?.subChannels ?? [];

  // ── Local draft auto-save (IndexedDB-lite via localStorage for v1) ───────
  const draftKey = `nmwc:draft:${customer.id}`;
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : null;
    if (!saved) return;
    try {
      const d = JSON.parse(saved);
      if (typeof d.legalName === 'string') setLegalName(d.legalName);
      if (typeof d.crNumber === 'string') setCrNumber(d.crNumber);
      if (typeof d.channelId === 'string') setChannelId(d.channelId);
      if (typeof d.subChannelId === 'string') setSubChannelId(d.subChannelId);
      if (typeof d.primaryPhone === 'string') setPrimaryPhone(d.primaryPhone);
      if (typeof d.altPhone === 'string') setAltPhone(d.altPhone);
      if (typeof d.contactPerson === 'string') setContactPerson(d.contactPerson);
      if (typeof d.contactRole === 'string') setContactRole(d.contactRole);
      if (typeof d.notes === 'string') setNotes(d.notes);
      if (d.branchStates) setBranchStates((prev) => ({ ...prev, ...d.branchStates }));
      setInfo('Restored a local draft from your last visit.');
    } catch {
      /* ignore */
    }
  }, [draftKey]);

  // Auto-save every change (debounced)
  useEffect(() => {
    const handle = setTimeout(() => {
      if (typeof window === 'undefined') return;
      window.localStorage.setItem(
        draftKey,
        JSON.stringify({
          legalName,
          crNumber,
          channelId,
          subChannelId,
          primaryPhone,
          altPhone,
          contactPerson,
          contactRole,
          notes,
          branchStates,
          savedAt: Date.now(),
        })
      );
    }, 500);
    return () => clearTimeout(handle);
  }, [
    draftKey,
    legalName,
    crNumber,
    channelId,
    subChannelId,
    primaryPhone,
    altPhone,
    contactPerson,
    contactRole,
    notes,
    branchStates,
  ]);

  function setBranch(id: string, patch: Partial<BState>) {
    setBranchStates((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  }

  async function submit(isDraft: boolean) {
    setErrors({});
    setInfo(null);

    const customerPayload = {
      legalName: lockNameAndCr ? undefined : legalName.trim() || undefined,
      crNumber: lockNameAndCr ? undefined : crNumber.trim() || undefined,
      channelId: channelId || undefined,
      subChannelId: subChannelId || undefined,
      primaryPhone: primaryPhone.trim() || undefined,
      altPhone: altPhone.trim() || undefined,
      contactPerson: contactPerson.trim() || undefined,
      contactRole: contactRole.trim() || undefined,
      status,
      notes: notes.trim() || undefined,
    };
    const branches = Object.entries(branchStates).map(([branchId, s]) => ({
      branchId,
      address: s.address.trim() || undefined,
      areaDescription: s.areaDescription.trim() || undefined,
      gpsLat: s.gps?.lat,
      gpsLng: s.gps?.lng,
      gpsAccuracy: s.gps?.accuracy,
      gpsCapturedAt: s.gps?.capturedAt,
      dayOfVisit: s.dayOfVisit || undefined,
      openingHours: s.openingHours.trim() || undefined,
      deliveryWindow: s.deliveryWindow.trim() || undefined,
      coolersCount: s.coolers,
      standsCount: s.stands,
      emptyBottlesCount: s.bottles,
    }));

    start(async () => {
      try {
        const res = await submitEditAction({
          customerId: customer.id,
          isDraft,
          customer: customerPayload,
          branches,
        });
        if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey);
        if (isDraft) {
          setInfo('✓ Draft saved.');
        } else if (res.state === 'APPROVED') {
          setInfo('✓ Saved (auto-approved as ' + userRole + ').');
          router.push(`/customers/${customer.id}`);
        } else {
          setInfo('✓ Submitted to your supervisor for approval.');
          router.push(`/customers/${customer.id}`);
        }
      } catch (err) {
        if (err instanceof ValidationError && err.fields) {
          setErrors(err.fields);
        } else if (err instanceof ConflictError) {
          setErrors({ _form: err.message });
        } else {
          setErrors({ _form: err instanceof Error ? err.message : 'Failed to save.' });
        }
      }
    });
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {info && (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 ring-1 ring-emerald-200">
          {info}
        </div>
      )}
      {errors._form && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700 ring-1 ring-red-200">
          {errors._form}
        </div>
      )}

      <FormSection
        title="Identity"
        description={lockNameAndCr ? 'Locked: Credit customer — only the Steward can change name or CR.' : undefined}
        locked={lockNameAndCr}
        defaultOpen={!lockNameAndCr}
      >
        <div className="grid gap-3">
          <Field
            label="Legal name *"
            error={errors['customer.legalName']}
            value={legalName}
            onChange={setLegalName}
            disabled={lockNameAndCr}
          />
          <Field
            label="CR number"
            error={errors['customer.crNumber']}
            value={crNumber}
            onChange={setCrNumber}
            disabled={lockNameAndCr}
          />
          <Field label="NMWC code" value={customer.nmwcCode} onChange={() => {}} disabled mono />
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">CR document photo *</label>
            <div className="w-48">
              <PhotoCaptureSlot
                kind="CR"
                required
                initial={
                  customer.crPhotoId
                    ? { attachmentId: customer.crPhotoId, remoteUrl: `/api/photos/${customer.crPhotoId}` }
                    : null
                }
                attachTo={{ kind: 'customer', customerId: customer.id, slot: 'CR' }}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              maxLength={5000}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
              rows={3}
            />
          </div>
        </div>
      </FormSection>

      <FormSection title="Channel & classification">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Channel *</label>
            <select
              value={channelId}
              onChange={(e) => {
                setChannelId(e.currentTarget.value);
                setSubChannelId('');
              }}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
            >
              <option value="">— Pick a channel —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Sub-channel *</label>
            <select
              value={subChannelId}
              onChange={(e) => setSubChannelId(e.currentTarget.value)}
              disabled={!channelId}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm disabled:bg-slate-100"
            >
              <option value="">— Pick a sub-channel —</option>
              {subChannels.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.currentTarget.value as CustomerStatus)}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
            >
              <option value="ACTIVE">Active</option>
              <option value="CLOSED">Closed</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
        </div>
      </FormSection>

      <FormSection title="Contact">
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Primary phone *"
            placeholder="+968 9XXX XXXX"
            value={primaryPhone}
            onChange={setPrimaryPhone}
            error={errors['customer.primaryPhone']}
          />
          <Field
            label="Alt phone"
            placeholder="+968 …"
            value={altPhone}
            onChange={setAltPhone}
            error={errors['customer.altPhone']}
          />
          <Field
            label="Contact person *"
            value={contactPerson}
            onChange={setContactPerson}
            error={errors['customer.contactPerson']}
          />
          <Field label="Contact role" value={contactRole} onChange={setContactRole} />
        </div>
      </FormSection>

      {customer.branches.map((b, idx) => {
        const s = branchStates[b.id];
        if (!s) return null;
        return (
          <FormSection
            key={b.id}
            title={`Branch ${idx + 1}: ${b.branchName}`}
            description={`${b.region.name} · ${b.route.code}`}
          >
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="Address *"
                  value={s.address}
                  onChange={(v) => setBranch(b.id, { address: v })}
                  textarea
                />
                <Field
                  label="Landmark / area description"
                  value={s.areaDescription}
                  onChange={(v) => setBranch(b.id, { areaDescription: v })}
                  textarea
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  Location * (required to submit)
                </label>
                <GpsCaptureButton
                  initial={s.gps}
                  onCapture={(g) => setBranch(b.id, { gps: g })}
                  required
                />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">Day of visit</label>
                  <select
                    value={s.dayOfVisit}
                    onChange={(e) =>
                      setBranch(b.id, { dayOfVisit: e.currentTarget.value as DayOfWeek | '' })
                    }
                    className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
                  >
                    <option value="">—</option>
                    {DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <Field
                  label="Opening hours"
                  placeholder="08:00 – 22:00"
                  value={s.openingHours}
                  onChange={(v) => setBranch(b.id, { openingHours: v })}
                />
                <Field
                  label="Delivery window"
                  placeholder="10:00 – 14:00"
                  value={s.deliveryWindow}
                  onChange={(v) => setBranch(b.id, { deliveryWindow: v })}
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Equipment at the shop
                </label>
                <div className="grid gap-2 md:grid-cols-3">
                  <StepperInput
                    name={`coolers-${b.id}`}
                    label="Coolers"
                    value={s.coolers}
                    onChange={(n) => setBranch(b.id, { coolers: n })}
                  />
                  <StepperInput
                    name={`stands-${b.id}`}
                    label="Stands"
                    value={s.stands}
                    onChange={(n) => setBranch(b.id, { stands: n })}
                  />
                  <StepperInput
                    name={`bottles-${b.id}`}
                    label="Empty bottles"
                    value={s.bottles}
                    onChange={(n) => setBranch(b.id, { bottles: n })}
                    max={1000}
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Photos
                </label>
                <p className="mb-2 text-[11px] text-slate-500">
                  Tap each slot to capture from your camera. Required: shop front, signboard. CR
                  document (in Identity section above) and 2 free photos optional.
                </p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <PhotoCaptureSlot
                    kind="SHOP"
                    required
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    initial={
                      b.shopPhotoId
                        ? {
                            attachmentId: b.shopPhotoId,
                            remoteUrl: `/api/photos/${b.shopPhotoId}`,
                          }
                        : null
                    }
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'SHOP' }}
                  />
                  <PhotoCaptureSlot
                    kind="SIGNBOARD"
                    required
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    initial={
                      b.signboardPhotoId
                        ? {
                            attachmentId: b.signboardPhotoId,
                            remoteUrl: `/api/photos/${b.signboardPhotoId}`,
                          }
                        : null
                    }
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'SIGNBOARD' }}
                  />
                  <PhotoCaptureSlot
                    kind="FREE"
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'FREE' }}
                  />
                  <PhotoCaptureSlot
                    kind="FREE"
                    capturedLat={s.gps?.lat}
                    capturedLng={s.gps?.lng}
                    attachTo={{ kind: 'branch', branchId: b.id, slot: 'FREE' }}
                  />
                </div>
              </div>
            </div>
          </FormSection>
        );
      })}

      <div className="sticky bottom-0 -mx-4 mt-4 flex items-center justify-between gap-2 border-t border-slate-200 bg-white p-4 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:-mx-6 sm:p-6">
        <button
          type="button"
          disabled={pending}
          onClick={() => submit(true)}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          disabled={pending || !canSubmit}
          onClick={() => submit(false)}
          className="rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          title={!canSubmit ? 'Pending edit already in review' : ''}
        >
          {pending ? 'Submitting…' : 'Submit for approval ▶'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  error,
  disabled,
  mono,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  mono?: boolean;
  textarea?: boolean;
}) {
  const cls = `block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500 ${mono ? 'font-mono text-[13px]' : ''} ${disabled ? 'cursor-not-allowed bg-slate-100' : ''}`;
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700">{label}</label>
      {textarea ? (
        <textarea
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.currentTarget.value)}
          rows={2}
          className={cls}
        />
      ) : (
        <input
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.currentTarget.value)}
          className={cls}
        />
      )}
      {error && <p className="mt-0.5 text-[11px] font-medium text-red-600">{error}</p>}
    </div>
  );
}
