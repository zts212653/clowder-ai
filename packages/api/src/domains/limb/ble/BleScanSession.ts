import { randomUUID } from 'node:crypto';
import type { BleHelperEvent } from './BleHelperProtocol.js';

export const BLE_SCAN_TIMEOUT_MS = 30_000;

export interface BleHelperRequester {
  request(command: string, params: Record<string, unknown>): Promise<unknown>;
  on(event: 'event', listener: (message: BleHelperEvent) => void): this;
  off(event: 'event', listener: (message: BleHelperEvent) => void): this;
}

export interface BleDiscoveryView {
  discoveryId: string;
  name: string | null;
  rssi: number;
  serviceUuids: string[];
}

export interface BleResolvedDiscovery extends BleDiscoveryView {
  platformDeviceId: string;
}

export interface BleScanSnapshot {
  active: boolean;
  sessionId: string | null;
  startedAt: number | null;
  expiresAt: number | null;
  discoveries: BleDiscoveryView[];
}

interface ActiveScan {
  sessionId: string;
  startedAt: number;
  expiresAt: number;
}

interface TimerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimer?: (timer: NodeJS.Timeout | number) => void;
}

export class BleScanSession {
  private active: ActiveScan | null = null;
  private timer: NodeJS.Timeout | number | null = null;
  private readonly discoveries = new Map<string, BleResolvedDiscovery>();
  private readonly platformToDiscovery = new Map<string, string>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout | number;
  private readonly clearTimer: (timer: NodeJS.Timeout | number) => void;

  constructor(
    private readonly helper: BleHelperRequester,
    options: TimerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.helper.on('event', this.handleHelperEvent);
  }

  async start(): Promise<ActiveScan> {
    if (this.active) throw new Error('A BLE scan session is already active');
    const startedAt = this.now();
    const active = {
      sessionId: randomUUID(),
      startedAt,
      expiresAt: startedAt + BLE_SCAN_TIMEOUT_MS,
    };
    this.active = active;
    this.discoveries.clear();
    this.platformToDiscovery.clear();
    try {
      await this.helper.request('scan.start', { sessionId: active.sessionId, timeoutMs: BLE_SCAN_TIMEOUT_MS });
    } catch (error) {
      this.clearLocalState();
      throw error;
    }
    // The helper can report an early stop immediately after acknowledging
    // scan.start (for example when Bluetooth powers off). Do not resurrect a
    // local timeout after that event already cleared the session.
    if (this.active !== active) return active;
    this.timer = this.setTimer(() => {
      void this.stop('timeout');
    }, BLE_SCAN_TIMEOUT_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
    return active;
  }

  async stop(_reason: 'explicit' | 'timeout' = 'explicit'): Promise<void> {
    const session = this.active;
    if (!session) return;
    this.clearLocalState();
    try {
      await this.helper.request('scan.stop', { sessionId: session.sessionId });
    } catch {
      // Privacy state is already cleared. A helper failure must not restore discoveries.
    }
  }

  snapshot(): BleScanSnapshot {
    return {
      active: this.active !== null,
      sessionId: this.active?.sessionId ?? null,
      startedAt: this.active?.startedAt ?? null,
      expiresAt: this.active?.expiresAt ?? null,
      discoveries: [...this.discoveries.values()].map(({ platformDeviceId: _privateId, ...view }) => ({ ...view })),
    };
  }

  resolveDiscovery(sessionId: string, discoveryId: string): BleResolvedDiscovery | null {
    if (!this.active || this.active.sessionId !== sessionId) return null;
    const discovery = this.discoveries.get(discoveryId);
    return discovery ? { ...discovery, serviceUuids: [...discovery.serviceUuids] } : null;
  }

  dispose(): void {
    this.clearLocalState();
    this.helper.off('event', this.handleHelperEvent);
  }

  private readonly handleHelperEvent = (message: BleHelperEvent): void => {
    if (!this.active) return;
    if (message.event === 'scan.state') {
      if (message.data.sessionId === this.active.sessionId && message.data.state !== 'started') this.clearLocalState();
      return;
    }
    if (message.event !== 'scan.discovered' || message.data.sessionId !== this.active.sessionId) return;
    let discoveryId = this.platformToDiscovery.get(message.data.deviceId);
    if (!discoveryId) {
      discoveryId = randomUUID();
      this.platformToDiscovery.set(message.data.deviceId, discoveryId);
    }
    this.discoveries.set(discoveryId, {
      discoveryId,
      platformDeviceId: message.data.deviceId,
      name: message.data.name,
      rssi: message.data.rssi,
      serviceUuids: [...message.data.serviceUuids],
    });
  };

  private clearLocalState(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.active = null;
    this.discoveries.clear();
    this.platformToDiscovery.clear();
  }
}
