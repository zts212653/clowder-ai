/**
 * IM Connector Plugin Interface — F240
 *
 * Unified contract for all IM connector adapters (built-in and external).
 * Built-in connectors (Feishu, DingTalk, etc.) implement this interface
 * as reference implementations. External plugins are installed as tar.gz
 * archives via the Hub UI (`.cat-cafe/plugins/<id>/`).
 *
 * Design decision (KD-1): No YAML templating — every real-world IM has
 * heavy platform-specific logic. Interface + package is the right level.
 */

import type { ConnectorDefinition, OperationState } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorWebhookHandler } from '../../routes/connector-webhooks.js';
import type { IOutboundAdapter } from './OutboundDeliveryHook.js';

// ── Plugin Context (injected by the loader) ──

/** Dependencies provided to each plugin by the host. */
export interface IMConnectorPluginContext {
  /** Environment variables (filtered to plugin's declared keys). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: FastifyBaseLogger;
  readonly redis?: RedisClient | undefined;
  /** @internal Test-only: dependency injection overrides from the bootstrap host. */
  readonly _testOverrides?: Readonly<Record<string, unknown>>;
}

// ── Inbound Message (plugin → router) ──

/** Attachment extracted from an inbound platform message. */
export interface InboundAttachment {
  readonly type: 'image' | 'file' | 'audio';
  /** Platform-native key/URL for downloading. */
  readonly platformKey: string;
  /** Original message ID on the platform (needed for some download APIs). */
  readonly messageId?: string;
  readonly fileName?: string;
  readonly duration?: number;
}

/**
 * Callback the plugin invokes for each inbound message after parsing.
 * The host wires this to `ConnectorRouter.route()`.
 */
export type InboundMessageCallback = (msg: {
  readonly chatId: string;
  readonly text: string;
  readonly messageId: string;
  readonly attachments?: InboundAttachment[];
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly chatType?: 'p2p' | 'group';
  readonly chatName?: string;
}) => Promise<void>;

// ── Media Download ──

/** Function that downloads a platform-native media resource to a Buffer. */
export type MediaDownloadFn = (platformKey: string, type: string, messageId?: string) => Promise<Buffer>;

// ── Lifecycle Handle ──

/** Returned by `startInbound()` — the host calls `stop()` on shutdown. */
export interface IMConnectorLifecycleHandle {
  stop(): Promise<void>;
}

// ── Action handling (AC-A15/A16) ──

/** Result returned by a plugin's handleAction() method. */
export interface HandleActionResult {
  /** Frontend render type for the result (e.g. 'img' for QR code, 'status' for text) */
  render: string;
  /** Result data — shape depends on render type (e.g. { url } for img, { label } for status) */
  data: unknown;
  /** Optional display label */
  label?: string;
  /** Values to backfill into target input fields (envName → value). AC-A19. */
  targetValues?: Record<string, string>;
  /**
   * Whether to advance currentAction to next. Default: true.
   * Set to false for polling actions that haven't completed yet
   * (e.g. QR scan still pending — frontend keeps polling, state stays).
   */
  advance?: boolean;
  /**
   * Whether to activate the connector after credential backfill. Default: true.
   * Set to false for disconnect/deactivate actions that clear credentials —
   * prevents the gateway from restarting a connector that was just stopped.
   */
  activate?: boolean;
}

/** Context passed to handleAction — includes adapter and current operation state. */
export interface HandleActionContext extends IMConnectorPluginContext {
  /**
   * The outbound adapter for this connector (same instance from createAdapter).
   * Undefined when the connector is not yet configured (e.g. QR login flow
   * acquires credentials — adapter doesn't exist until after activation).
   */
  adapter: IOutboundAdapter | undefined;
  /** Current persisted operation state (undefined if no state yet). */
  operationState: OperationState | undefined;
}

// ── The Plugin Interface ──

export interface IMConnectorPlugin {
  /** Unique connector ID (e.g. 'feishu', 'dingtalk', 'welink'). */
  readonly id: string;

  /** Frontend display metadata (icon, color, displayName). */
  readonly definition: ConnectorDefinition;

  /**
   * Environment variable names that MUST be set for this connector to start.
   * Used by `isConfigured()` default logic and Hub UI.
   */
  readonly requiredEnvKeys: readonly string[];

  /** Environment variable names that are optional. */
  readonly optionalEnvKeys?: readonly string[];

  /**
   * Check whether this connector has enough credentials to start.
   * Default behavior: all `requiredEnvKeys` are non-empty.
   * Override for connectors with complex conditional logic (e.g. Feishu
   * websocket mode doesn't need VERIFICATION_TOKEN).
   */
  isConfigured(env: Readonly<Record<string, string | undefined>>): boolean;

  /**
   * Create the outbound adapter instance.
   * The adapter is registered in the shared `adapters` Map and used by
   * `OutboundDeliveryHook` / `StreamingOutboundHook` for outbound delivery.
   * May return a Promise for adapters that need async initialization
   * (e.g. dynamic imports for heavy SDK dependencies).
   */
  createAdapter(ctx: IMConnectorPluginContext): IOutboundAdapter | Promise<IOutboundAdapter>;

  /**
   * Start receiving inbound messages (for non-webhook connectors).
   * Use this for: WebSocket, long polling, SDK stream, etc.
   * Returns a lifecycle handle with `stop()` for cleanup.
   *
   * Mutually exclusive with `createWebhookHandler` — use one or the other.
   * If both are provided, both will be used (e.g. Feishu supports both modes).
   */
  startInbound?(
    adapter: IOutboundAdapter,
    onMessage: InboundMessageCallback,
    ctx: IMConnectorPluginContext,
  ): Promise<IMConnectorLifecycleHandle>;

  /**
   * Create a webhook handler for HTTP webhook-based inbound messages.
   * The handler is registered at `POST /api/connectors/:connectorId/webhook`.
   *
   * Return undefined to skip webhook registration (e.g. Feishu in websocket mode).
   */
  createWebhookHandler?(
    adapter: IOutboundAdapter,
    onMessage: InboundMessageCallback,
    ctx: IMConnectorPluginContext,
  ): ConnectorWebhookHandler | undefined;

  /**
   * Create a media download function for this connector.
   * Registered with `ConnectorMediaService` for inbound attachment processing.
   * Receives the adapter instance so downloaders can reuse connection state
   * (e.g. WeComBot's wsClient) instead of constructing a disconnected copy.
   */
  createMediaDownloader?(adapter: IOutboundAdapter, ctx: IMConnectorPluginContext): MediaDownloadFn;

  /**
   * Optional one-time setup after adapter creation but before inbound starts.
   * Use for: admin seeding, bot identity resolution, session restore, etc.
   */
  setup?(adapter: IOutboundAdapter, ctx: IMConnectorPluginContext): Promise<void>;

  /**
   * Handle an action within an operation's state machine (AC-A15).
   * Called by the generic `POST /api/connectors/:id/actions/:operationName/:actionId` endpoint.
   *
   * The host automatically:
   * - persists `currentAction = next` on success (AC-A20)
   * - backfills `target` input fields with `targetValues` (AC-A19)
   * - activates connector after credential backfill (creates adapter + starts inbound)
   *
   * Timeout rollback (AC-A21) is a frontend responsibility: frontend reads `updatedAt`
   * from operation state + YAML `timeout`, then calls the `rollback` target action.
   *
   * Only connectors with operation-type fields need to implement this.
   */
  handleAction?(operationName: string, actionId: string, ctx: HandleActionContext): Promise<HandleActionResult>;
}
