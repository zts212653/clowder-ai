/**
 * F085 Phase 4+6 — Hyperfocus Brake Platform Types
 * 平台级健康守护：后端活跃追踪 + WebSocket 推送 + 前端 UI
 * Phase 6: 社区默认 OFF (opt-in) + TD110 持久化 + 温柔/硬核双档
 */

/** Brake interaction mode (Phase 6) */
export type BrakeMode = 'gentle' | 'hardcore';

/** WebSocket event payload: brake:trigger */
export interface BrakeEvent {
  level: 1 | 2 | 3;
  activeMinutes: number;
  nightMode: boolean;
  /** Phase 6: mode travels with the trigger so the modal renders correctly without a settings fetch */
  mode: BrakeMode;
  timestamp: number;
}

/** POST /api/brake/checkin request body */
export interface BrakeCheckinRequest {
  choice: 'rest' | 'wrap_up' | 'continue';
  reason?: string; // required when choice === 'continue'
}

/** POST /api/brake/checkin response */
export interface BrakeCheckinResponse {
  ok: boolean;
  nextCheckMinutes: number; // 0=timer reset, 10=wrap_up, 30/45/-1=continue
  /** True when bypass is exhausted (3+ times in 4h) — frontend should hide continue */
  bypassDisabled?: boolean;
}

/** User-configurable brake settings (GET/PUT /api/brake/settings) */
export interface BrakeSettings {
  enabled: boolean; // default: false (Phase 6: 社区默认 OFF, opt-in)
  thresholdMinutes: number; // default: 90, range: 30–240
  mode: BrakeMode; // default: 'gentle' (Phase 6: 温柔档可一键 dismiss)
}

/** Internal state per user (also exposed via GET /api/brake/state) */
export interface BrakeState {
  activeWorkMs: number;
  lastActivityTs: number;
  triggerLevel: 0 | 1 | 2 | 3;
  bypassCount: number;
  dismissed: boolean;
  dismissCooldownMs: number;
  lastCheckinTs: number;
}
