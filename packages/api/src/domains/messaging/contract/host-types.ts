/**
 * Host-internal types — NOT part of the published plugin contract.
 *
 * These types exist only in the K-1 messaging kernel and are never exposed
 * to plugins through the contract package. They cover:
 * - Call context / grant projections (stamped by the Host broker)
 * - Host-side response shapes (ReadResult, SnapshotResult, SubscribeResult)
 * - The MessagingError class (Host throw convention; plugins receive codes)
 * - MessageOutputEventInput (sequence-less event shape for store ingestion)
 */

import type {
  MessageElementsAppendEvent,
  MessageEnvelope,
  MessageOutputEvent,
  MessagePublishEvent,
  MessagingErrorCode,
} from '@clowder-ai/plugin-contract';

// ── Re-export MessagingErrorCode so consumers can import from one place ──

export type { MessagingErrorCode } from '@clowder-ai/plugin-contract';

// ── Call context & grants (Host-only; never in the plugin-facing contract) ──

/** Identity bound by the host broker per call — never self-reported inside payloads. */
export interface PluginCallContext {
  readonly pluginInstanceId: string;
}

/** Grant projection carried by a handle (control plane hands issuance to K-2). */
export interface HandleScope {
  readonly canSend: boolean;
  readonly canSubscribe: boolean;
  /** Whisper allowed-target set; whisper drafts must target a subset (§3.1). */
  readonly allowedWhisperTargets?: readonly string[];
}

// ── Host-internal response shapes ──

export interface SubscribeResult {
  readonly subscriptionId: string;
}

export interface ReadResult {
  readonly events: readonly MessageOutputEvent[];
  /** Opaque, subscription-local (INV-5). Null when no events were delivered. */
  readonly ackToken: string | null;
  /** Cursor fell behind the retention window — resync via snapshot (INV-9). */
  readonly stale: boolean;
}

export interface SnapshotResult {
  readonly envelopes: readonly MessageEnvelope[];
  /** Cursor position after catch-up; subsequent reads resume from here. */
  readonly resumeSequence: number;
}

// ── Derived event type (store-side; sequence assigned atomically by EventLogStore) ──

/** Event as submitted to the log — the store assigns `sequence` atomically (INV-3). */
export type MessageOutputEventInput =
  | Omit<MessagePublishEvent, 'sequence'>
  | Omit<MessageElementsAppendEvent, 'sequence'>;

// ── Errors (Host throw convention; plugins receive error codes, not this class) ──

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: MessagingErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
