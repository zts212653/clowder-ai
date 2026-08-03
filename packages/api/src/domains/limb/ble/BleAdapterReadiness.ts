import type { BleHelperEvent } from './BleHelperProtocol.js';

type BleAdapterState = Extract<BleHelperEvent, { event: 'adapter.state' }>['data']['state'];

interface BleEventSource {
  on(event: 'event', listener: (message: BleHelperEvent) => void): unknown;
  off(event: 'event', listener: (message: BleHelperEvent) => void): unknown;
}

export class BleAdapterReadiness {
  private state: BleAdapterState | null = null;
  private readonly rejectWaiters = new Set<(error: Error) => void>();

  constructor(
    private readonly events: BleEventSource,
    private readonly timeoutMs: number,
  ) {}

  reset(): void {
    this.state = null;
    const error = new Error('BLE adapter readiness was reset');
    for (const rejectWaiter of [...this.rejectWaiters]) rejectWaiter(error);
  }

  observe(message: BleHelperEvent): void {
    if (message.event === 'adapter.state') this.state = message.data.state;
  }

  waitForPoweredOn(): Promise<void> {
    const currentError = this.stateError();
    if (currentError) return Promise.reject(currentError);
    if (this.state === 'poweredOn') return Promise.resolve();

    return new Promise<void>((resolveReady, rejectReady) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.events.off('event', onEvent);
        this.rejectWaiters.delete(rejectWaiter);
      };
      const rejectWaiter = (error: Error): void => {
        cleanup();
        rejectReady(error);
      };
      const checkState = (): void => {
        const error = this.stateError();
        if (error) {
          rejectWaiter(error);
        } else if (this.state === 'poweredOn') {
          cleanup();
          resolveReady();
        }
      };
      const onEvent = (message: BleHelperEvent): void => {
        if (message.event === 'adapter.state') checkState();
      };
      const timer = setTimeout(() => {
        rejectWaiter(new Error('BLE adapter state timed out before poweredOn'));
      }, this.timeoutMs);
      timer.unref();
      this.rejectWaiters.add(rejectWaiter);
      this.events.on('event', onEvent);
      checkState();
    });
  }

  private stateError(): Error | null {
    if (this.state === 'poweredOff' || this.state === 'unauthorized' || this.state === 'unsupported') {
      return new Error(`BLE adapter is not powered on: ${this.state}`);
    }
    return null;
  }
}
