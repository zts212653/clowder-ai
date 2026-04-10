/** F33 Phase 3: Shared types for session strategy Hub UI */

export interface StrategyThresholds {
  warn: number;
  action: number;
}

export interface EffectiveStrategy {
  strategy: 'handoff' | 'compress' | 'hybrid';
  thresholds: StrategyThresholds;
  turnBudget?: number;
  safetyMargin?: number;
  hybrid?: { maxCompressions: number };
  compress?: { trackPostCompression: boolean; maxCompressions?: number };
  handoff?: { preSealMemoryDump: boolean; bootstrapDepth: string };
}

export interface CatStrategyEntry {
  catId: string;
  displayName: string;
  clientId: string;
  breedId?: string;
  effective: EffectiveStrategy;
  source: string;
  hasOverride: boolean;
  override: Partial<EffectiveStrategy> | null;
  hybridCapable: boolean;
  sessionChainEnabled: boolean;
}

export type StrategyType = 'handoff' | 'compress' | 'hybrid';

export const SOURCE_LABELS: Record<string, string> = {
  runtime_override: '运行时覆盖',
  config_file: '配置文件',
  breed_code: '代码默认',
  provider_default: 'Provider 默认',
  global_default: '全局默认',
};

export const STRATEGY_LABELS: Record<StrategyType, string> = {
  handoff: 'Handoff（到阈值就换 Session）',
  compress: 'Compress（让 CLI 自行压缩）',
  hybrid: 'Hybrid（压缩 N 次后换 Session）',
};
