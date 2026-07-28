import { syncCoopOfflineRedemptions } from '@workspace/api-client-react';

// ---------------------------------------------------------------------------
// Offline redemption queue (Co-Op Offline Fallback Mode).
//
// Redemptions accepted while offline are stored durably in IndexedDB so they
// survive page reloads and browser restarts. Each entry carries a
// client-generated id — the server-side idempotency key — plus everything
// needed for reconciliation. When connectivity returns, the queue syncs to
// POST /coop/redemptions/sync; accepted/duplicate items are cleared, while
// conflict/rejected outcomes move to an "issues" store so staff see which
// redemption won and nothing is silently dropped.
// ---------------------------------------------------------------------------

const DB_NAME = 'gnil-coop-offline';
const DB_VERSION = 1;
const PENDING_STORE = 'pending-redemptions';
const ISSUES_STORE = 'sync-issues';

export type QueuedRedemption = {
  clientRedemptionId: string;
  code: string;
  passCode: string;
  /** ISO timestamp of the offline scan. */
  scannedAt: string;
  /** Tenant whose device queued the scan (sync must run under same scope). */
  tenantId: number;
  perkTitle?: string | null;
};

export type SyncIssue = {
  clientRedemptionId: string;
  outcome: 'conflict' | 'rejected';
  reason: string | null;
  code: string;
  passCode: string;
  scannedAt: string;
  perkTitle?: string | null;
  winningRedeemedAt: string | null;
  syncedAt: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: 'clientRedemptionId' });
      }
      if (!db.objectStoreNames.contains(ISSUES_STORE)) {
        db.createObjectStore(ISSUES_STORE, { keyPath: 'clientRedemptionId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        t.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error ?? new Error('IndexedDB transaction failed'));
        };
      }),
  );
}

export async function enqueueOfflineRedemption(entry: QueuedRedemption): Promise<void> {
  await tx(PENDING_STORE, 'readwrite', s => s.put(entry));
}

export function listPendingRedemptions(): Promise<QueuedRedemption[]> {
  return tx(PENDING_STORE, 'readonly', s => s.getAll() as IDBRequest<QueuedRedemption[]>);
}

/** Same-device double-scan guard: is this pass already in the local queue? */
export async function isQueuedLocally(code: string, passCode: string): Promise<boolean> {
  const pending = await listPendingRedemptions();
  return pending.some(p => p.code === code && p.passCode === passCode);
}

export function listSyncIssues(): Promise<SyncIssue[]> {
  return tx(ISSUES_STORE, 'readonly', s => s.getAll() as IDBRequest<SyncIssue[]>);
}

export async function dismissSyncIssue(clientRedemptionId: string): Promise<void> {
  await tx(ISSUES_STORE, 'readwrite', s => s.delete(clientRedemptionId));
}

export type SyncRunResult = {
  attempted: number;
  accepted: number;
  duplicates: number;
  issues: SyncIssue[];
};

/**
 * Push every queued redemption for the given tenant to the server. Applied
 * (accepted/duplicate) items leave the queue; conflict/rejected items move
 * to the issues store for the merchant to review. Throws only on transport
 * failure — the queue is left intact for the next attempt.
 */
export async function syncPendingRedemptions(tenantId: number): Promise<SyncRunResult> {
  const pending = (await listPendingRedemptions()).filter(p => p.tenantId === tenantId);
  if (pending.length === 0) return { attempted: 0, accepted: 0, duplicates: 0, issues: [] };

  const byId = new Map(pending.map(p => [p.clientRedemptionId, p]));
  const res = await syncCoopOfflineRedemptions({
    redemptions: pending.map(p => ({
      clientRedemptionId: p.clientRedemptionId,
      code: p.code,
      passCode: p.passCode,
      scannedAt: p.scannedAt,
    })),
  });

  let accepted = 0;
  let duplicates = 0;
  const issues: SyncIssue[] = [];
  const syncedAt = new Date().toISOString();
  for (const result of res.results) {
    const source = byId.get(result.clientRedemptionId);
    if (!source) continue;
    if (result.outcome === 'accepted') accepted += 1;
    else if (result.outcome === 'duplicate') duplicates += 1;
    else {
      issues.push({
        clientRedemptionId: result.clientRedemptionId,
        outcome: result.outcome === 'conflict' ? 'conflict' : 'rejected',
        reason: result.reason ?? null,
        code: source.code,
        passCode: source.passCode,
        scannedAt: source.scannedAt,
        perkTitle: result.perkTitle ?? source.perkTitle ?? null,
        winningRedeemedAt: result.winningRedeemedAt ?? null,
        syncedAt,
      });
    }
    // Every returned item is settled server-side — remove it from the queue.
    await tx(PENDING_STORE, 'readwrite', s => s.delete(result.clientRedemptionId));
  }
  for (const issue of issues) {
    await tx(ISSUES_STORE, 'readwrite', s => s.put(issue));
  }
  return { attempted: pending.length, accepted, duplicates, issues };
}
