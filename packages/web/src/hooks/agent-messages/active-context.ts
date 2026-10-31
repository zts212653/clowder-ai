import type { NamedMessageStore } from '@/hooks/named-message-writer';
import { type ChatState, useChatStore } from '@/stores/chatStore';
import { reconcileInvocationOwnership } from './invocation-slots';
import type { SystemInfoPort } from './system-info-port';
import type { SystemRowSink } from './system-projections';
import { randomIdSuffix } from './tool-events';

/** Open-thread status and slot actions the hook selects once per render. */
export type ActiveStoreActions = Pick<
  ChatState,
  | 'setLoading'
  | 'setHasActiveInvocation'
  | 'addActiveInvocation'
  | 'removeActiveInvocation'
  | 'setIntentMode'
  | 'setCatStatus'
  | 'clearCatStatuses'
  | 'setCatInvocation'
  | 'replaceThreadTargetCats'
>;

/**
 * The open thread's system rows (own ids, never a response). The hook shell binds them to the
 * flat writers: every caller runs synchronously behind its open-thread dispatch gate.
 */
export interface OpenThreadRows extends SystemRowSink {
  removeRow(id: string): void;
}

/** F118 AC-C3: timeout diagnostics wait, per (thread, cat), for the error row they explain. */
export interface TimeoutDiagnosticsStash {
  set(threadId: string, catId: string, diagnostics: Record<string, unknown>): void;
  /** Read and forget: diagnostics explain at most one error. */
  take(threadId: string, catId: string): Record<string, unknown> | null;
}

export interface ActiveContext {
  actions: ActiveStoreActions;
  rows: OpenThreadRows;
  resolveCatName: (catId: string) => string;
  timeoutDiagnostics: TimeoutDiagnosticsStash;
}

/** The named-message writer's store for the open thread (thread-scoped writers route to it by id). */
export const openThreadStore = (): NamedMessageStore => useChatStore.getState();

export function activeSystemInfoPort(threadId: string, ctx: ActiveContext): SystemInfoPort {
  const { actions, rows } = ctx;
  return {
    rows: rows.rows,
    addRow: rows.addRow,
    patchRow: rows.patchRow,
    removeRow: rows.removeRow,
    path: 'active',
    threadId,
    store: openThreadStore,
    resolveCatName: ctx.resolveCatName,
    createdAt: Date.now(),
    newId: (kind) => `${kind === 'web-search' ? 'toolws' : kind}-${Date.now()}-${randomIdSuffix()}`,
    catInvocation: (catId) => useChatStore.getState().catInvocations?.[catId],
    setCatStatus: (catId, status, detail) => {
      // A status detail (F210 progress line) lives in the thread-scoped status map.
      if (detail) useChatStore.getState().updateThreadCatStatus(threadId, catId, status, detail);
      else actions.setCatStatus(catId, status);
    },
    setCatInvocation: actions.setCatInvocation,
    reconcileInvocationOwnership: (catId, invocationId) => reconcileInvocationOwnership(catId, invocationId, actions),
    stashTimeoutDiagnostics: (catId, diagnostics) => ctx.timeoutDiagnostics.set(threadId, catId, diagnostics),
  };
}
