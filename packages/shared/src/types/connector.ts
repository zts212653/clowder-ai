/**
 * Connector Types — 外部信息源 / notice transport 抽象
 *
 * Connector transport covers both:
 * 1) true external systems（GitHub、iMessage、Slack 等）, and
 * 2) thread-visible system notices that reuse the same persistence/socket path.
 *
 * Visual presentation is not implied by storage transport:
 * - default connector messages render as ConnectorBubble
 * - messages with `source.meta.presentation = 'system_notice'` render as in-thread notice bars
 *
 * BACKLOG #97
 */

import { CONNECTOR_DEFINITIONS } from './connector-definitions.js';

// ── Connector Source (附加到 StoredMessage) ──

/** Shared prefix for scheduler trigger messages that act as reply anchors. */
export const SCHEDULER_TRIGGER_PREFIX = '[定时任务]';

export type SchedulerLifecycleEvent =
  | 'registered'
  | 'paused'
  | 'resumed'
  | 'deleted'
  | 'succeeded'
  | 'failed'
  | 'missed_window';

export interface SchedulerToastPayload {
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
  duration: number;
  lifecycleEvent: SchedulerLifecycleEvent;
}

export interface SchedulerMessageExtra {
  scheduler?: {
    hiddenTrigger?: boolean;
    toast?: SchedulerToastPayload;
  };
  /** F276: server-written, content-free carrier for one deferred write-opportunity re-entry. */
  writeOpportunityReentry?: import('./memory-write-opportunity.js').WriteOpportunityReentryCarrierV1;
  /** F276: one unified clerk invocation may carry up to eight independent re-entries. */
  writeOpportunityReentries?: readonly import('./memory-write-opportunity.js').WriteOpportunityReentryCarrierV1[];
  /** F292/F296: server-written, refs-only retry for one unchanged write-opportunity generation. */
  writeOpportunityPresentationRetry?: import('./memory-write-opportunity.js').WriteOpportunityPresentationRetryCarrierV1;
}

export type ReplyPreviewKind = 'scheduler_trigger';

export interface ReplyPreview {
  senderCatId: string | null;
  content: string;
  deleted?: true;
  kind?: ReplyPreviewKind;
}

/** Source metadata attached to connector-transport messages. */
export interface ConnectorSource {
  /** Stable connector identifier (used for routing + styling) */
  readonly connector: string;
  /** Human-readable display name */
  readonly label: string;
  /** Emoji or icon URL for avatar position */
  readonly icon: string;
  /** Link to original source (e.g., PR URL) */
  readonly url?: string;
  /** Connector-specific metadata (e.g. presentation='system_notice', debugging, routing) */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** F134: Original sender info for group chat messages (message-level binding, not thread-level) */
  readonly sender?: { readonly id: string; readonly name?: string };
}

/**
 * F167 PR5: immutable identity for the user-visible managed-hold wake/result
 * rows that Message Bundle may offer. Runtime authorship and owner access are
 * additional server-side guards; this shared predicate keeps Web affordance
 * and API source classification on the same connector contract.
 */
export function isSelectableManagedHoldConnectorSource(
  source: Pick<ConnectorSource, 'connector' | 'meta'> | null | undefined,
): boolean {
  const meta = source?.meta;
  return Boolean(
    source?.connector === 'hold-ball' &&
      meta?.wakeWhen === true &&
      typeof meta.taskId === 'string' &&
      meta.taskId.trim().length > 0 &&
      typeof meta.threadId === 'string' &&
      meta.threadId.trim().length > 0 &&
      typeof meta.catId === 'string' &&
      meta.catId.trim().length > 0,
  );
}

// ── Connector Definition (registry entry) ──

/** How a connector's avatar icon is rendered.
 *  - `svg`: maps to a React SVG component by `iconId` or renders a bundled SVG file from `src`
 *  - `png`: renders an image from `src` path */
export type ConnectorIconSpec =
  | { readonly type: 'svg'; readonly iconId: string; readonly src?: string }
  | { readonly type: 'png'; readonly src: string };

/** Static definition of a connector type for frontend rendering.
 *  Every connector shares the same metadata shape: name + themeColor + icon.
 *  The OKLCH pipeline derives bubble/surface/ring colors from `themeColor`. */
export interface ConnectorDefinition {
  readonly id: string;
  /** Display name shown next to the message bubble. */
  readonly displayName: string;
  /** Avatar icon spec — single source of truth for icon rendering. */
  readonly icon: ConnectorIconSpec;
  /** Theme color hex — single source for OKLCH hue/chroma derivation + avatar ring.
   *  Avatar bg is computed via `tintedLight(themeColor, 0.5)`. */
  readonly themeColor: string;
  readonly description: string;
}

// ── Thread Binding (external platform ↔ Clowder AI thread) ──

/** Bidirectional mapping between an external chat and a Clowder AI thread. */
export interface ConnectorThreadBinding {
  readonly connectorId: string;
  readonly externalChatId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly createdAt: number;
  /** IM Hub thread for command isolation (ISSUE-8 Phase 8A). Lazily created on first IM command. */
  readonly hubThreadId?: string;
}

/** Target for outbound delivery after agent execution completes. */
export interface OutboundDeliveryTarget {
  readonly connectorId: string;
  readonly externalChatId: string;
  readonly metadata?: Record<string, unknown>;
}

// ── Connector Registry ──

const connectorMap = new Map<string, ConnectorDefinition>(CONNECTOR_DEFINITIONS.map((d) => [d.id, d]));

/** Static IDs from compile-time definitions — immune to runtime registration. */
const staticConnectorIds = new Set(CONNECTOR_DEFINITIONS.map((d) => d.id));

/**
 * Check whether an ID belongs to a static (compile-time) connector definition.
 * Unlike `getConnectorDefinition()`, this is NOT affected by runtime
 * `registerConnectorDefinition()` calls — safe for hot-reload ID conflict checks.
 */
export function isStaticConnectorId(id: string): boolean {
  return staticConnectorIds.has(id);
}

/**
 * Register a connector definition at runtime (F240 dynamic plugins).
 * External IM connector plugins call this to make their definition
 * available to frontend rendering (icon, color, displayName).
 * Built-in definitions cannot be overridden.
 */
export function registerConnectorDefinition(def: ConnectorDefinition): void {
  if (staticConnectorIds.has(def.id)) return;
  connectorMap.set(def.id, def);
}

/**
 * Unregister a runtime-added connector definition (F240 plugin uninstall).
 * Static (compile-time) definitions are immune — only dynamically registered
 * entries can be removed.
 */
export function unregisterConnectorDefinition(id: string): void {
  if (!staticConnectorIds.has(id)) {
    connectorMap.delete(id);
  }
}

/** Look up a connector definition by ID. */
export function getConnectorDefinition(connectorId: string): ConnectorDefinition | undefined {
  return connectorMap.get(connectorId);
}

/** Get all registered connector definitions (built-in + dynamically registered). */
export function getAllConnectorDefinitions(): readonly ConnectorDefinition[] {
  return Array.from(connectorMap.values());
}
