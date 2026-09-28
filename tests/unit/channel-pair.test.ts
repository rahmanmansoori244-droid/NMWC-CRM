/**
 * Phase 2, F16: a customer's sub-channel must belong to its channel — CREATE's
 * rule, now applied to edits and to the import (lib/channel-pair.ts). Only a
 * change of the pair is checked, so a mismatch already on file never blocks an
 * unrelated edit.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CHANNEL_INACTIVE_MESSAGE,
  SUB_CHANNEL_INACTIVE_MESSAGE,
  SUB_CHANNEL_MISMATCH_MESSAGE,
  resolveChannelPair,
  subChannelClearedByChannelChange,
  type ChannelPairDb,
} from '@/lib/channel-pair';

const RETAIL = 'ckchannelretail000000001';
const HORECA = 'ckchannelhoreca000000001';
const OLD = 'ckchannelold000000000001';
const GROCERY = 'cksubgrocery000000000001'; // Retail
const KIOSK = 'cksubkiosk00000000000001'; // Retail, no longer offered
const CAFE = 'cksubcafe000000000000001'; // HoReCa

function fakeDb() {
  const channels: Record<string, { isActive: boolean }> = {
    [RETAIL]: { isActive: true },
    [HORECA]: { isActive: true },
    [OLD]: { isActive: false },
  };
  const subs: Record<string, { channelId: string; isActive: boolean }> = {
    [GROCERY]: { channelId: RETAIL, isActive: true },
    [KIOSK]: { channelId: RETAIL, isActive: false },
    [CAFE]: { channelId: HORECA, isActive: true },
  };
  const db = {
    channel: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => channels[where.id] ?? null),
    },
    subChannel: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => subs[where.id] ?? null),
    },
  };
  return { db, typed: db as unknown as ChannelPairDb };
}

const SUBMIT = { requireActiveChannel: true, clearMisfitSubChannel: true };
const APPROVAL = { requireActiveChannel: false, clearMisfitSubChannel: false };

describe('resolveChannelPair', () => {
  it('nothing about the pair changes: nothing is checked, not even a mismatch on file', async () => {
    const { db, typed } = fakeDb();
    const onFile = { channelId: RETAIL, subChannelId: CAFE }; // a legacy mismatch
    for (const proposed of [
      {},
      { channelId: RETAIL },
      { subChannelId: CAFE },
      { channelId: RETAIL, subChannelId: CAFE },
    ]) {
      expect(await resolveChannelPair(typed, onFile, proposed, SUBMIT)).toEqual({
        ok: true,
        changed: false,
      });
    }
    expect(db.channel.findUnique).not.toHaveBeenCalled();
    expect(db.subChannel.findUnique).not.toHaveBeenCalled();
  });

  it('a sub-channel of the customer’s channel is accepted', async () => {
    const { typed } = fakeDb();
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: null },
        { subChannelId: GROCERY },
        SUBMIT
      )
    ).toEqual({
      ok: true,
      changed: true,
      channelId: RETAIL,
      subChannelId: GROCERY,
      clearsSubChannel: false,
    });
  });

  it('a sub-channel of another channel, or one that does not exist, is refused on customer.subChannelId', async () => {
    const { typed } = fakeDb();
    for (const subChannelId of [CAFE, 'cksubmissing0000000000001']) {
      expect(
        await resolveChannelPair(
          typed,
          { channelId: RETAIL, subChannelId: null },
          { subChannelId },
          SUBMIT
        )
      ).toEqual({
        ok: false,
        field: 'customer.subChannelId',
        message: SUB_CHANNEL_MISMATCH_MESSAGE,
      });
    }
    // no channel on file: nothing for a sub-channel to belong to
    expect(
      await resolveChannelPair(
        typed,
        { channelId: null, subChannelId: null },
        { subChannelId: GROCERY },
        SUBMIT
      )
    ).toMatchObject({
      ok: false,
      field: 'customer.subChannelId',
    });
  });

  it('a sub-channel no longer offered is refused with its own words', async () => {
    const { typed } = fakeDb();
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: null },
        { subChannelId: KIOSK },
        SUBMIT
      )
    ).toEqual({
      ok: false,
      field: 'customer.subChannelId',
      message: SUB_CHANNEL_INACTIVE_MESSAGE,
    });
  });

  it('a channel change with a sub-channel of the new channel is accepted', async () => {
    const { typed } = fakeDb();
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: GROCERY },
        { channelId: HORECA, subChannelId: CAFE },
        SUBMIT
      )
    ).toMatchObject({
      ok: true,
      changed: true,
      channelId: HORECA,
      subChannelId: CAFE,
      clearsSubChannel: false,
    });
  });

  it('a channel change that sends the old sub-channel along is refused, not silently cleared', async () => {
    const { typed } = fakeDb();
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: GROCERY },
        { channelId: HORECA, subChannelId: GROCERY },
        SUBMIT
      )
    ).toEqual({ ok: false, field: 'customer.subChannelId', message: SUB_CHANNEL_MISMATCH_MESSAGE });
  });

  it('a channel change with the sub-channel cleared explicitly is accepted', async () => {
    const { typed } = fakeDb();
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: GROCERY },
        { channelId: HORECA, subChannelId: null },
        SUBMIT
      )
    ).toEqual({
      ok: true,
      changed: true,
      channelId: HORECA,
      subChannelId: null,
      clearsSubChannel: false,
    });
  });

  describe('a channel change with no sub-channel sent', () => {
    it('at submit, a live sub-channel of the old channel is cleared, and says so', async () => {
      const { typed } = fakeDb();
      expect(
        await resolveChannelPair(
          typed,
          { channelId: RETAIL, subChannelId: GROCERY },
          { channelId: HORECA },
          SUBMIT
        )
      ).toEqual({
        ok: true,
        changed: true,
        channelId: HORECA,
        subChannelId: null,
        clearsSubChannel: true,
      });
    });

    it('at submit, a live sub-channel that fits the new channel is kept', async () => {
      const { typed } = fakeDb();
      // On file, a legacy pair: a retired channel beside a HoReCa sub-channel.
      // Moving the customer to HoReCa makes the pair right, so the sub-channel stays.
      expect(
        await resolveChannelPair(
          typed,
          { channelId: OLD, subChannelId: CAFE },
          { channelId: HORECA },
          SUBMIT
        )
      ).toMatchObject({
        ok: true,
        subChannelId: CAFE,
        clearsSubChannel: false,
      });
    });

    it('with no live sub-channel there is nothing to clear', async () => {
      const { typed } = fakeDb();
      expect(
        await resolveChannelPair(
          typed,
          { channelId: RETAIL, subChannelId: null },
          { channelId: HORECA },
          SUBMIT
        )
      ).toEqual({
        ok: true,
        changed: true,
        channelId: HORECA,
        subChannelId: null,
        clearsSubChannel: false,
      });
    });

    it('at approval the submit already recorded any clear, so a misfit is refused', async () => {
      const { typed } = fakeDb();
      expect(
        await resolveChannelPair(
          typed,
          { channelId: RETAIL, subChannelId: GROCERY },
          { channelId: HORECA },
          APPROVAL
        )
      ).toEqual({
        ok: false,
        field: 'customer.subChannelId',
        message: SUB_CHANNEL_MISMATCH_MESSAGE,
      });
    });
  });

  it('a new channel must exist, and at submit be offered; approval does not re-check that it is active', async () => {
    const { typed } = fakeDb();
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: null },
        { channelId: OLD },
        SUBMIT
      )
    ).toEqual({
      ok: false,
      field: 'customer.channelId',
      message: CHANNEL_INACTIVE_MESSAGE,
    });
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: null },
        { channelId: 'ckchannelmissing00000001' },
        APPROVAL
      )
    ).toMatchObject({ ok: false, field: 'customer.channelId' });
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: null },
        { channelId: OLD },
        APPROVAL
      )
    ).toMatchObject({
      ok: true,
      channelId: OLD,
    });
  });

  it("'' reads as empty, like everywhere else in an edit", async () => {
    const { typed } = fakeDb();
    expect(
      await resolveChannelPair(
        typed,
        { channelId: RETAIL, subChannelId: null },
        { subChannelId: '' },
        SUBMIT
      )
    ).toEqual({
      ok: true,
      changed: false,
    });
  });
});

describe('subChannelClearedByChannelChange — the import’s full lane (owner decision 1, 2026-09-29)', () => {
  const stored = { channelId: RETAIL, subChannelId: GROCERY, subChannelChannelId: RETAIL };

  it('a new channel clears a sub-channel of the channel it replaces', () => {
    expect(subChannelClearedByChannelChange(stored, HORECA)).toBe(true);
  });
  it('a sub-channel that belongs to the new channel is kept', () => {
    expect(
      subChannelClearedByChannelChange(
        { channelId: OLD, subChannelId: CAFE, subChannelChannelId: HORECA },
        HORECA
      )
    ).toBe(false);
  });
  it('the same channel, a blank channel cell, or no sub-channel on file: nothing to clear', () => {
    expect(subChannelClearedByChannelChange(stored, RETAIL)).toBe(false);
    expect(subChannelClearedByChannelChange(stored, null)).toBe(false);
    expect(subChannelClearedByChannelChange(stored, undefined)).toBe(false);
    expect(
      subChannelClearedByChannelChange(
        { channelId: RETAIL, subChannelId: null, subChannelChannelId: null },
        HORECA
      )
    ).toBe(false);
  });
  it('a customer with no channel yet gets one: a stray sub-channel of another channel goes', () => {
    expect(
      subChannelClearedByChannelChange(
        { channelId: null, subChannelId: CAFE, subChannelChannelId: HORECA },
        RETAIL
      )
    ).toBe(true);
    expect(
      subChannelClearedByChannelChange(
        { channelId: null, subChannelId: GROCERY, subChannelChannelId: RETAIL },
        RETAIL
      )
    ).toBe(false);
  });
});
