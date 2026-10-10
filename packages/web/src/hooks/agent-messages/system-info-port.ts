import type { NamedMessageStore } from '@/hooks/named-message-writer';
import type { CatInvocationInfo, CatStatusType } from '@/stores/chat-types';
import type { SystemRowSink } from './system-projections';

/**
 * Where one `system_info` event lands. The open thread binds this to its flat store actions, a
 * background thread to its thread-scoped writers; message writes of both go through the same
 * named-message writer (`store`).
 */
export interface SystemInfoPort extends SystemRowSink {
  readonly path: 'active' | 'background';
  readonly threadId: string;
  /** Store the named-message writer reads and writes. */
  readonly store: () => NamedMessageStore;
  readonly resolveCatName: (catId: string) => string;
  /** Timestamp of rows and tool events this client creates. */
  readonly createdAt: number;
  /** Id of a row or tool event this client creates (never a message identity it could take). */
  newId(kind: 'web-search' | 'gov-blocked'): string;
  catInvocation(catId: string): CatInvocationInfo | undefined;
  setCatStatus(catId: string, status: CatStatusType, detail?: string): void;
  setCatInvocation(catId: string, info: Partial<CatInvocationInfo>): void;
  removeRow(id: string): void;
  /** Open thread only: invocation_created re-homes the slot to the cat that owns it. */
  reconcileInvocationOwnership?(catId: string, invocationId: string): void;
  /** Open thread only: diagnostics kept for the error row they explain. */
  stashTimeoutDiagnostics?(catId: string, diagnostics: Record<string, unknown>): void;
}
