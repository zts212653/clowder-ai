import type { CatId } from '@cat-cafe/shared';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { IConversationHostAdapter } from './conversation-host-adapter.js';
import type { BridgeFallbackReason, IPinchTabBridgeAdapter } from './types.js';
import type { WorkspaceAgentTransportResolver } from './workspace-agent/workspace-agent-config.js';

export type EmitFallbackFn = (params: {
  readonly threadId: string;
  readonly catId: CatId | string;
  readonly reason: BridgeFallbackReason;
  readonly detail?: string;
}) => Promise<void>;

export interface BridgeLogger {
  warn(ctx: object, msg: string): void;
  info(ctx: object, msg: string): void;
  error?(ctx: object, msg: string): void;
}

export interface CloudInvokeBridgeDeps {
  readonly hostAdapter?: IConversationHostAdapter | null;
  readonly pinchTabAdapter: IPinchTabBridgeAdapter | null;
  /**
   * F247 Workspace Agent (KD-24 pending): per-dispatch resolver; a non-null
   * result makes the official Trigger API path own the outbound outcome
   * (fail closed — no silent Personal Chrome fallback). Resolution is
   * read-per-use so Settings changes apply without an API restart.
   */
  readonly workspaceAgent?: WorkspaceAgentTransportResolver | null;
  readonly emitFallback: EmitFallbackFn;
  readonly threadStore: IThreadStore;
  readonly logger?: BridgeLogger;
}

export const noopBridgeLogger: BridgeLogger = {
  warn() {},
  info() {},
};
