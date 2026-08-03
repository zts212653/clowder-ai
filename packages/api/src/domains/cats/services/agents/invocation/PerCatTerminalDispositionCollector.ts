/**
 * Derives durable per-cat success witnesses from a route event stream.
 *
 * A bare `done` is not sufficient when the same cat was canceled or emitted a
 * terminal error earlier. The collector is deliberately stateful so every
 * producer applies the same fail-closed terminal contract.
 */

export interface TerminalDispositionEvent {
  type: string;
  catId?: string;
  errorCode?: unknown;
  errorDisposition?: 'transient' | 'terminal';
}

export interface PerCatTerminalDispositionCollectorOptions {
  targetCatIds: readonly string[];
  isCanceled?: (catId: string) => boolean;
}

export class PerCatTerminalDispositionCollector {
  private readonly disqualifiedCatIds = new Set<string>();
  private readonly successfulCatIds = new Set<string>();
  private readonly targetCatIds: Set<string>;
  private readonly isCanceled: (catId: string) => boolean;

  constructor(options: PerCatTerminalDispositionCollectorOptions) {
    this.targetCatIds = new Set(options.targetCatIds);
    this.isCanceled = options.isCanceled ?? (() => false);
  }

  observe(event: TerminalDispositionEvent): void {
    const { catId } = event;
    if (!catId || !this.targetCatIds.has(catId)) return;

    if (event.type === 'error') {
      if (event.errorDisposition === 'transient') return;
      this.disqualify(catId);
      return;
    }

    if (event.type !== 'done') return;

    if (event.errorCode !== undefined || this.isCanceled(catId)) {
      this.disqualify(catId);
      return;
    }

    if (!this.disqualifiedCatIds.has(catId)) {
      this.successfulCatIds.add(catId);
    }
  }

  getSuccessfulCatIds(): string[] {
    return [...this.successfulCatIds];
  }

  private disqualify(catId: string): void {
    this.disqualifiedCatIds.add(catId);
    this.successfulCatIds.delete(catId);
  }
}
