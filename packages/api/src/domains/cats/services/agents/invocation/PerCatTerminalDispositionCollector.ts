/**
 * Derives durable per-cat success witnesses from a route event stream.
 *
 * A bare `done` is not sufficient when the same cat was canceled or emitted a
 * terminal error earlier. The collector is deliberately stateful so every
 * producer applies the same fail-closed terminal contract.
 */

import type { QueueTerminalConsumptionWitness } from '@cat-cafe/shared';
import { normalizeQueueTerminalConsumptions } from './queue-terminal-consumption.js';

export interface TerminalDispositionEvent {
  type: string;
  catId?: string;
  error?: unknown;
  errorCode?: unknown;
  errorDisposition?: 'transient' | 'terminal';
  invocationId?: string;
  turnCustodyTerminalWitness?: QueueTerminalConsumptionWitness;
  turnCustodyTerminalWitnesses?: readonly QueueTerminalConsumptionWitness[];
}

export interface PerCatTerminalDispositionCollectorOptions {
  targetCatIds: readonly string[];
  isCanceled?: (catId: string) => boolean;
}

/**
 * Whether an event releases the exact InvocationTracker slot.
 *
 * Provider diagnostics may use `type: 'error'` while explicitly declaring
 * themselves transient. Those frames must remain visible without surrendering
 * the controller that powers exact Stop.
 */
export function isTerminalDispositionEvent(event: TerminalDispositionEvent): boolean {
  return event.type === 'done' || (event.type === 'error' && event.errorDisposition !== 'transient');
}

export class PerCatTerminalDispositionCollector {
  private readonly disqualifiedCatIds = new Set<string>();
  private readonly successfulCatIds = new Set<string>();
  private readonly preflightRejectedCatIds = new Set<string>();
  private readonly targetCatIds: Set<string>;
  private readonly isCanceled: (catId: string) => boolean;
  private primaryTerminalError: string | undefined;
  private readonly terminalInvocationIdByCatId = new Map<string, string>();
  private readonly terminalConsumptionByInvocationId = new Map<string, readonly QueueTerminalConsumptionWitness[]>();

  constructor(options: PerCatTerminalDispositionCollectorOptions) {
    this.targetCatIds = new Set(options.targetCatIds);
    this.isCanceled = options.isCanceled ?? (() => false);
  }

  observe(event: TerminalDispositionEvent): void {
    this.observeCustody(event);
    const { catId } = event;
    if (!catId || !this.targetCatIds.has(catId)) return;

    if (event.type === 'error') {
      if (event.errorDisposition === 'transient') return;
      if (event.errorCode === 'routing_preflight_rejected') this.preflightRejectedCatIds.add(catId);
      this.primaryTerminalError ??= this.readTerminalError(event.error, event.errorCode, catId);
      this.disqualify(catId);
      return;
    }

    if (event.type !== 'done') return;

    if (event.errorCode !== undefined || this.isCanceled(catId)) {
      if (event.errorCode !== undefined) {
        this.primaryTerminalError ??= this.readTerminalError(undefined, event.errorCode, catId);
      }
      this.disqualify(catId);
      return;
    }

    if (!this.disqualifiedCatIds.has(catId)) {
      this.successfulCatIds.add(catId);
    }
  }

  private observeCustody(event: TerminalDispositionEvent): void {
    // Custody belongs to an exact child/source, including adopted wakes. Every
    // route consumer must forward it independently of aggregate parent success.
    if (
      event.catId &&
      typeof event.invocationId === 'string' &&
      event.invocationId.length > 0 &&
      isTerminalDispositionEvent(event)
    ) {
      this.terminalInvocationIdByCatId.set(event.catId, event.invocationId);
      if (event.type === 'done') {
        const witnesses = normalizeQueueTerminalConsumptions(
          event.turnCustodyTerminalWitnesses ?? event.turnCustodyTerminalWitness,
        );
        if (witnesses.length > 0) {
          this.terminalConsumptionByInvocationId.set(
            event.invocationId,
            normalizeQueueTerminalConsumptions([
              ...(this.terminalConsumptionByInvocationId.get(event.invocationId) ?? []),
              ...witnesses,
            ]),
          );
        }
      }
    }
  }

  getSuccessfulCatIds(): string[] {
    return [...this.successfulCatIds];
  }

  getPrimaryTerminalError(): string | undefined {
    return this.primaryTerminalError;
  }

  getTerminalInvocationIdByCatId(): Record<string, string> {
    return Object.fromEntries(this.terminalInvocationIdByCatId);
  }

  getTerminalConsumptionByInvocationId(): Record<string, readonly QueueTerminalConsumptionWitness[]> {
    return Object.fromEntries(this.terminalConsumptionByInvocationId);
  }

  getPreflightRejectedCatIds(): string[] {
    return [...this.preflightRejectedCatIds];
  }

  private readTerminalError(error: unknown, errorCode: unknown, catId: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    if (typeof errorCode === 'string' && errorCode.trim()) return errorCode;
    return `target cat ${catId} failed without a terminal error detail`;
  }

  private disqualify(catId: string): void {
    this.disqualifiedCatIds.add(catId);
    this.successfulCatIds.delete(catId);
  }
}
