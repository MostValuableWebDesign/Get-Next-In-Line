import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@workspace/api-client-react', () => ({
  syncCoopOfflineRedemptions: vi.fn(),
}));

import { syncCoopOfflineRedemptions } from '@workspace/api-client-react';
import {
  enqueueOfflineRedemption,
  listPendingRedemptions,
  isQueuedLocally,
  listSyncIssues,
  dismissSyncIssue,
  syncPendingRedemptions,
  type QueuedRedemption,
} from '@/lib/offline-redemptions';

const syncMock = vi.mocked(syncCoopOfflineRedemptions);

const entry = (overrides: Partial<QueuedRedemption> = {}): QueuedRedemption => ({
  clientRedemptionId: `cr-${Math.random().toString(36).slice(2)}`,
  code: 'COOP-ABC',
  passCode: `C${Math.floor(Math.random() * 10000)}`,
  scannedAt: new Date().toISOString(),
  tenantId: 1,
  ...overrides,
});

beforeEach(() => {
  // Fresh IndexedDB per test so state never leaks between tests.
  globalThis.indexedDB = new IDBFactory();
  syncMock.mockReset();
});

describe('offline redemption queue', () => {
  it('persists entries and guards against same-device double scans', async () => {
    const a = entry({ passCode: 'C1' });
    await enqueueOfflineRedemption(a);
    expect(await listPendingRedemptions()).toHaveLength(1);
    expect(await isQueuedLocally('COOP-ABC', 'C1')).toBe(true);
    expect(await isQueuedLocally('COOP-ABC', 'C2')).toBe(false);
  });

  it('clears accepted/duplicate items on sync and keeps the queue on transport failure', async () => {
    const a = entry();
    const b = entry();
    await enqueueOfflineRedemption(a);
    await enqueueOfflineRedemption(b);

    syncMock.mockRejectedValueOnce(new Error('offline again'));
    await expect(syncPendingRedemptions(1)).rejects.toThrow();
    expect(await listPendingRedemptions()).toHaveLength(2);

    syncMock.mockResolvedValueOnce({
      results: [
        { clientRedemptionId: a.clientRedemptionId, outcome: 'accepted', reason: null, redeemedAt: a.scannedAt, perkTitle: 'Perk', winningRedeemedAt: null },
        { clientRedemptionId: b.clientRedemptionId, outcome: 'duplicate', reason: null, redeemedAt: null, perkTitle: null, winningRedeemedAt: null },
      ],
    });
    const run = await syncPendingRedemptions(1);
    expect(run).toMatchObject({ attempted: 2, accepted: 1, duplicates: 1 });
    expect(await listPendingRedemptions()).toHaveLength(0);
    expect(await listSyncIssues()).toHaveLength(0);
  });

  it('moves conflicts/rejections to the issues store until dismissed', async () => {
    const loser = entry();
    await enqueueOfflineRedemption(loser);
    const winningRedeemedAt = new Date().toISOString();
    syncMock.mockResolvedValueOnce({
      results: [
        { clientRedemptionId: loser.clientRedemptionId, outcome: 'conflict', reason: 'This pass was already redeemed elsewhere', redeemedAt: null, perkTitle: 'Perk', winningRedeemedAt },
      ],
    });
    const run = await syncPendingRedemptions(1);
    expect(run.issues).toHaveLength(1);
    expect(run.issues[0].winningRedeemedAt).toBe(winningRedeemedAt);
    expect(await listPendingRedemptions()).toHaveLength(0);

    const stored = await listSyncIssues();
    expect(stored).toHaveLength(1);
    expect(stored[0].outcome).toBe('conflict');

    await dismissSyncIssue(loser.clientRedemptionId);
    expect(await listSyncIssues()).toHaveLength(0);
  });

  it('only syncs entries for the requested tenant', async () => {
    await enqueueOfflineRedemption(entry({ tenantId: 1 }));
    await enqueueOfflineRedemption(entry({ tenantId: 2 }));
    syncMock.mockImplementationOnce(async req => ({
      results: req.redemptions.map(r => ({
        clientRedemptionId: r.clientRedemptionId,
        outcome: 'accepted' as const,
        reason: null,
        redeemedAt: r.scannedAt,
        perkTitle: null,
        winningRedeemedAt: null,
      })),
    }));
    const run = await syncPendingRedemptions(1);
    expect(run.attempted).toBe(1);
    expect(syncMock.mock.calls[0][0].redemptions).toHaveLength(1);
    expect(await listPendingRedemptions()).toHaveLength(1); // tenant 2 untouched
  });

  it('is a no-op with an empty queue', async () => {
    const run = await syncPendingRedemptions(1);
    expect(run).toEqual({ attempted: 0, accepted: 0, duplicates: 0, issues: [] });
    expect(syncMock).not.toHaveBeenCalled();
  });
});
