/**
 * F229 PR-A3a: conciergeProjection — 猫猫球态投影（纯函数 + 输入类型）
 *
 * Extracted from conciergeStore.ts for file-size hygiene.
 * This module is store-independent: zero Zustand, zero side effects.
 *
 * projectBallState is the single source of truth for ball visual state.
 * ballState = f(ConciergeInputs) — pure projection, never stored (INV-2).
 */

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 三层展开状态机（A3a）: collapsed=猫收起 | toolbar=工具栏展开 | bubble=对话气泡 */
export type SurfaceState = 'collapsed' | 'toolbar' | 'bubble';

/**
 * ConciergeInputs: projectBallState 的唯一输入。
 * 这些字段是 store 的实际状态（INV-2: ballState 自身绝不在此）。
 */
export interface ConciergeInputs {
  enabled: boolean;
  muted: boolean;
  /** concierge thread 最新 invocation 状态（chat-types:433 语义） */
  invocationStatus: 'idle' | 'pending' | 'in_progress' | 'error';
  /** 面板内未决确认卡（PR-A3b 前恒 0） */
  pendingConfirmationCount: number;
  /** relay 已投递未回执数（PR-A3b 前恒 0） */
  pendingRelayCount: number;
  /** found 未查看数；bubble 打开并滚到底 → 清零 */
  unseenResultCount: number;
  /** A3a: 三层展开状态（替代 A2 的 panelOpen: boolean） */
  surfaceState: SurfaceState;
  inputFocused: boolean;
}

// ---------------------------------------------------------------------------
// projectBallState — 纯函数（INV-4，导出供测试直接 import）
// ---------------------------------------------------------------------------

/**
 * 球态投影函数。输入 ConciergeInputs，输出球状态或 'hidden'。
 *
 * 优先级全序（高到低）：
 *   hidden(disabled/muted) > error > needs-confirmation > thinking > handoff > listening > found > idle
 *
 * A3a: listening 条件 = surfaceState==='bubble' && inputFocused
 *   （toolbar 展开但未进入气泡时不算 listening，避免误切状态）
 *
 * 无副作用，同 inputs 重复调用输出恒等（INV-4）。
 */
export function projectBallState(i: ConciergeInputs): import('@cat-cafe/shared').ConciergeBallState | 'hidden' {
  if (!i.enabled || i.muted) return 'hidden';
  if (i.invocationStatus === 'error') return 'error';
  if (i.pendingConfirmationCount > 0) return 'needs-confirmation';
  if (i.invocationStatus === 'pending' || i.invocationStatus === 'in_progress') return 'thinking';
  if (i.pendingRelayCount > 0) return 'handoff';
  if (i.surfaceState === 'bubble' && i.inputFocused) return 'listening';
  if (i.unseenResultCount > 0) return 'found';
  return 'idle';
}
