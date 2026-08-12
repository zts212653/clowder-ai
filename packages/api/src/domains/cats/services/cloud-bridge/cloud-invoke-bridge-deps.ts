import type { CatId } from '@cat-cafe/shared';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { IConversationHostAdapter } from './conversation-host-adapter.js';
import type { BridgeFallbackReason, IPinchTabBridgeAdapter } from './types.js';

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
  readonly emitFallback: EmitFallbackFn;
  readonly threadStore: IThreadStore;
  readonly logger?: BridgeLogger;
}

export const noopBridgeLogger: BridgeLogger = {
  warn() {},
  info() {},
};
