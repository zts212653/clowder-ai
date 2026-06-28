/**
 * F167 R2 P1#2 — Shared inbox thread resolver.
 *
 * Both inbox delivery paths (webhook handler + reconciliation scanner) must
 * stamp/self-heal the `threadKind='gate-keeping'` marker on the inbox thread,
 * otherwise the trigger-time guard (gate-keeping-guard.ts) silently treats
 * pre-rollout / reconciliation-only inbox threads as normal threads and the
 * dual-owner / hold-leak event reproduces.
 *
 * Single root cause for the R1 #2 finding (RepoScanTaskSpec.ts bypassed
 * markGateKeepingKind / selfHealGateKeepingKind by delivering straight from
 * `bindingStore.getByExternal(...)` → `binding.threadId`). This helper extracts
 * the bind+stamp+self-heal logic into one entry point so any new inbox delivery
 * path inherits it for free.
 */

import type { ThreadKind } from '@cat-cafe/shared';
import type { IConnectorThreadBindingStore } from '../ConnectorThreadBindingStore.js';

/**
 * Minimal shape we read from threadStore.get for marker self-heal.
 * Tightened from `any` after @codex R3 P2 cloud finding (AGENTS.md 禁 any
 * redline). We only consume `.threadKind`; the wider Thread / inbox-record
 * types returned by callers are accepted via structural subtyping (extra
 * fields ignored). `unknown` for the return value keeps the lifecycle marker
 * guard tight — callers can't pass arbitrary `kind` to updateThreadKind.
 */

/** Shape of the binding row we depend on (subset of ConnectorThreadBinding). */
interface InboxBinding {
  threadId: string;
}

/**
 * Minimal threadStore surface required for marker stamping + self-heal.
 *
 * All three methods are optional so legacy / minimal mock deps still work
 * (the helper degrades gracefully when stamp/self-heal can't run, but the
 * fundamental getByExternal/create + bind calls remain).
 */
export interface InboxThreadStore {
  create(userId: string, title?: string): Promise<{ id: string }> | { id: string };
  /** F167: read for self-heal check; returns the thread record (may carry extra
   *  fields, only `.threadKind` is consumed) or null/undefined when missing.
   *  `unknown` keeps the typed marker guard intact while letting wider Thread
   *  records flow through unchanged. */
  get?(threadId: string): unknown | Promise<unknown>;
  /** F167: stamp/clear the marker. Only the typed union or null is accepted —
   *  callers cannot smuggle arbitrary values past the lifecycle marker guard. */
  updateThreadKind?(threadId: string, kind: ThreadKind | null): Promise<void> | void;
}

export interface ResolveInboxThreadDeps {
  bindingStore: Pick<IConnectorThreadBindingStore, 'getByExternal' | 'bind'>;
  threadStore: InboxThreadStore;
  /** Connector ID for binding lookups (e.g. 'github-repo-event'). */
  connectorId: string;
  defaultUserId: string;
  /**
   * Optional Redis NX lock for concurrent ensureThread protection.
   * Webhook handler uses this (KD-20); reconciliation doesn't need it because
   * scheduler concurrency for the same repo is 1 (overlap: 'skip').
   */
  redis?: {
    set(key: string, value: string, mode: string, seconds: number, nx: string): Promise<unknown>;
    del(key: string): Promise<unknown>;
  };
  /**
   * Lock key prefix when `redis` is provided. Combined with repoFullName.
   * Webhook handler uses 'f141:inbox-lock:'.
   */
  lockKeyPrefix?: string;
  /**
   * Optional title builder for new inbox threads.
   * Defaults to `Repo Inbox · ${repoFullName}`.
   */
  buildTitle?: (repoFullName: string) => string;
}

export type ResolveInboxThreadOutcome =
  /** Brand new thread created + stamped with 'gate-keeping'. */
  | 'created'
  /** Existing binding's thread already had 'gate-keeping' marker — no change. */
  | 'reused'
  /** Existing binding's thread was missing marker — self-healed (stamped now). */
  | 'self_healed';

export interface ResolveInboxThreadResult {
  threadId: string;
  outcome: ResolveInboxThreadOutcome;
}

const DEFAULT_LOCK_KEY_PREFIX = 'f141:inbox-lock:';

function defaultTitle(repoFullName: string): string {
  return `Repo Inbox · ${repoFullName}`;
}

/**
 * Resolve (or create) the inbox thread for `repoFullName`, guaranteeing that
 * the thread is stamped with `threadKind='gate-keeping'` before returning.
 *
 * Behavior:
 *   - existing binding + thread already 'gate-keeping' → return ('reused')
 *   - existing binding + thread missing marker → self-heal stamp → return ('self_healed')
 *   - no binding + redis lock available → acquire NX lock, create thread, bind, stamp ('created')
 *   - no binding + no redis → fallback: create thread, bind, stamp ('created')
 *
 * Stamping (markGateKeepingKind + selfHealGateKeepingKind) is best-effort — the
 * underlying updateThreadKind call is wrapped in try/catch so a flaky thread
 * store cannot block inbox delivery (mirrors guard fail-open INV-G7).
 *
 * If `redis` is configured but the NX lock is held by a concurrent caller,
 * the helper polls bindingStore.getByExternal for up to 1s (10×100ms) and
 * throws if the binding still hasn't appeared (KD-20 behavior preserved
 * from the original webhook handler).
 */
export async function resolveInboxThread(
  deps: ResolveInboxThreadDeps,
  repoFullName: string,
): Promise<ResolveInboxThreadResult> {
  const existing = await deps.bindingStore.getByExternal(deps.connectorId, repoFullName);
  if (existing) {
    const outcome = await stampOrSelfHeal(deps, existing.threadId);
    return { threadId: existing.threadId, outcome };
  }

  if (deps.redis) {
    const prefix = deps.lockKeyPrefix ?? DEFAULT_LOCK_KEY_PREFIX;
    const lockKey = `${prefix}${repoFullName}`;
    const locked = await deps.redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!locked) {
      // Another request holds the lock — poll for the binding.
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const retry = await deps.bindingStore.getByExternal(deps.connectorId, repoFullName);
        if (retry) {
          const outcome = await stampOrSelfHeal(deps, retry.threadId);
          return { threadId: retry.threadId, outcome };
        }
      }
      throw new Error(`Timeout waiting for inbox thread creation: ${repoFullName}`);
    }

    try {
      const recheck = await deps.bindingStore.getByExternal(deps.connectorId, repoFullName);
      if (recheck) {
        const outcome = await stampOrSelfHeal(deps, recheck.threadId);
        return { threadId: recheck.threadId, outcome };
      }
      const created = await createBindStamp(deps, repoFullName);
      return created;
    } finally {
      await deps.redis.del(lockKey);
    }
  }

  // Fallback without Redis lock (shouldn't hit in prod — dedup requires Redis).
  return createBindStamp(deps, repoFullName);
}

async function createBindStamp(deps: ResolveInboxThreadDeps, repoFullName: string): Promise<ResolveInboxThreadResult> {
  const title = (deps.buildTitle ?? defaultTitle)(repoFullName);
  const thread = await deps.threadStore.create(deps.defaultUserId, title);
  await deps.bindingStore.bind(deps.connectorId, repoFullName, thread.id, deps.defaultUserId);
  await stampGateKeeping(deps, thread.id);
  return { threadId: thread.id, outcome: 'created' };
}

async function stampOrSelfHeal(deps: ResolveInboxThreadDeps, threadId: string): Promise<'reused' | 'self_healed'> {
  if (!deps.threadStore.get || !deps.threadStore.updateThreadKind) return 'reused';
  try {
    const thread = await deps.threadStore.get(threadId);
    if (thread && (thread as { threadKind?: ThreadKind }).threadKind === 'gate-keeping') {
      return 'reused';
    }
    await deps.threadStore.updateThreadKind(threadId, 'gate-keeping');
    return 'self_healed';
  } catch {
    // Best-effort: failure here means the guard will be skipped for this
    // thread until a later inbox touch hits self-heal again.
    return 'reused';
  }
}

async function stampGateKeeping(deps: ResolveInboxThreadDeps, threadId: string): Promise<void> {
  if (!deps.threadStore.updateThreadKind) return;
  try {
    await deps.threadStore.updateThreadKind(threadId, 'gate-keeping');
  } catch {
    // Best-effort.
  }
}

/**
 * InboxBinding return shape — kept exported so other modules importing this
 * file can introspect the binding type without re-importing the connector
 * binding interface.
 */
export type { InboxBinding };

/**
 * Self-heal only — for delivery paths that don't create threads (e.g.
 * RepoScanTaskSpec reconciliation, which short-circuits on missing binding
 * rather than creating one). Stamps `gate-keeping` if the thread is missing
 * the marker; otherwise no-op.
 *
 * Best-effort: silently swallows threadStore errors so reconciliation delivery
 * stays unblocked (same fail-open discipline as the trigger-time guard).
 */
export async function selfHealInboxThreadKind(
  threadStore: Pick<InboxThreadStore, 'get' | 'updateThreadKind'>,
  threadId: string,
): Promise<'reused' | 'self_healed' | 'noop'> {
  if (!threadStore.get || !threadStore.updateThreadKind) return 'noop';
  try {
    const thread = await threadStore.get(threadId);
    if (thread && (thread as { threadKind?: ThreadKind }).threadKind === 'gate-keeping') {
      return 'reused';
    }
    await threadStore.updateThreadKind(threadId, 'gate-keeping');
    return 'self_healed';
  } catch {
    return 'noop';
  }
}
