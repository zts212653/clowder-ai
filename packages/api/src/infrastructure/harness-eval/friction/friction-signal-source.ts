/**
 * F245 Phase A — 摩擦信号源 Port
 *
 * 4 个采集通道（paw-feel / cancel / user-feedback / eval-domain）共享的 pull 接口。
 * Phase A 实现首个：PawFeelAdapter。其余通道 Phase B 起接入。
 *
 * 设计：read-only pull，无持久状态（KD-4 只读 rollup 域）。幂等由 deterministic
 * FrictionSignal.id 保证，采集层零去重存储。
 */

import type { FrictionChannel, FrictionSignal } from '@cat-cafe/shared';

export interface IFrictionSignalSource {
  /** 此 source 负责的通道标识。 */
  readonly channelId: FrictionChannel;
  /**
   * 拉取 [sinceMs, untilMs) 时间窗内的全部摩擦信号。
   * 幂等：同一 message+marker 多次 pull 产出相同 id 的 signal。
   */
  pull(sinceMs: number, untilMs: number): Promise<FrictionSignal[]>;
}
