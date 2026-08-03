export interface BleStatus {
  platform: string;
  available: boolean;
  state: 'idle' | 'starting' | 'ready' | 'degraded' | 'unsupported';
  reason: string | null;
  restartAttempts: number;
  bindingCount: number;
}

export interface BleBindingView {
  bindingId: string;
  displayName: string;
  adapterId: string;
  commands: string[];
  nodeId: string;
  createdAt: number;
  lastConnectedAt: number | null;
}

export interface BleBindingCheckView {
  bindingId: string;
  state: 'reachable' | 'unreachable' | 'profile_mismatch';
  checkedAt: number;
  reason?: 'busy' | 'connection_failed' | 'disconnected' | 'inspection_failed' | 'timeout' | 'unavailable';
}

export interface BleDiscoveryView {
  discoveryId: string;
  name: string | null;
  rssi: number;
  serviceUuids: string[];
}

export interface BleScanSnapshot {
  active: boolean;
  sessionId: string | null;
  startedAt: number | null;
  expiresAt: number | null;
  discoveries: BleDiscoveryView[];
}

export const EMPTY_BLE_SCAN: BleScanSnapshot = {
  active: false,
  sessionId: null,
  startedAt: null,
  expiresAt: null,
  discoveries: [],
};
