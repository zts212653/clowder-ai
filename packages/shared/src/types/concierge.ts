/**
 * F229: 猫猫球前台猫 — 共享类型定义
 *
 * ConciergeConfig: per-deployment 配置，per-user 存储（TTL=0，铁律 5）
 * ConciergeBallState: 球的八态状态机（UI 侧驱动）
 * ConciergeCardAction: CardBlock concierge actions（前端 action handler 注册）
 */

/** ConciergeConfig: 前台猫配置（per-user 持久化，用户可见可追溯可恢复） */
export interface ConciergeConfig {
  /** 是否启用前台猫 (default true) */
  enabled: boolean;
  /** 皮肤 — Phase E0: ragdoll-v1 默认，yarn-ball 保留为 legacy fallback */
  skin: 'yarn-ball' | 'ragdoll-v1';
  /** 前台猫显示名（KD-6: per-deployment 可配置，本家 Phase A 落地投票） */
  displayName: string;
  /** 一句话人设基调（注入岗位 prompt） */
  personaTone: string;
  /** 值班猫 profileId — 指向已配置的 cat profile (KD-7: provider-agnostic) */
  dutyCatProfileId: string;
  /**
   * 主动性等级（OQ-4 四级白名单）:
   * - 'ambient': Tier 0 仅环境感知，零主动文本
   * - 'quiet-badge': Tier 0-1 低优先级 badge，hover 才出文字（Phase A 默认）
   */
  proactivePolicy: 'ambient' | 'quiet-badge';
  /** 一键静音/隐藏整个球 (AC-A6) */
  muted: boolean;
  /** 球位置 (PR-A3b INV-P3: per-user 持久化) — null = default bottom-right */
  ballPosition: { x: number; y: number } | null;
}

/** ConciergeConfig 默认值（dutyCatProfileId 由 API 层根据 roster 解析） */
export const CONCIERGE_CONFIG_DEFAULTS: Omit<ConciergeConfig, 'dutyCatProfileId'> = {
  enabled: true,
  skin: 'ragdoll-v1',
  displayName: '猫猫球',
  personaTone: '温暖、简短、不啰嗦',
  proactivePolicy: 'quiet-badge',
  muted: false,
  ballPosition: null,
};

/**
 * 球八态状态机
 * idle        — 默认待机（呼吸动画）
 * sleeping    — 静音/非活跃（可配置降级态）
 * listening   — STT 录音中（Phase C）
 * thinking    — 值班猫 invocation 进行中
 * found       — 记忆/功能发现返回结果（态 3）
 * needs-confirmation — 待用户确认（态 4 转接 / 任何 action card）
 * handoff     — relay 投递完成，等回执
 * error       — 调用失败
 */
export type ConciergeBallState =
  | 'idle'
  | 'sleeping'
  | 'listening'
  | 'thinking'
  | 'found'
  | 'needs-confirmation'
  | 'handoff'
  | 'error';

/**
 * threadKind: Thread 字段扩展（F229）
 * concierge = 专属前台猫对话载体（per-user，sidebar 默认隐藏）
 */
export type ConciergeThreadKind = 'concierge';

/**
 * CardBlock concierge actions（前端 action handler 注册点）
 * 前台猫不直接执行跳转/传话——发确认卡，用户点击后由前端执行（调研红线）
 */
export type ConciergeCardAction =
  /** 去：F227 teleport 跳转到目标 thread/message */
  | { kind: 'concierge_teleport'; threadId: string; messageId?: string }
  /** 取：原地 inline 展开 anchor 前后往来原文（不离开当前页） */
  | { kind: 'concierge_peek'; threadId: string; messageId: string }
  /** 传话：cross_post 投递 + 注册回执监听 */
  | {
      kind: 'concierge_relay';
      targetThreadId: string;
      targetCats: string[];
      originalText: string;
      sourceMessageId: string;
    }
  /** 跟去：teleport 到目标 thread 跟进 */
  | { kind: 'concierge_go'; targetThreadId: string }
  /** 开新调查：propose_thread 创建新 thread (Phase B) */
  | { kind: 'concierge_propose_thread'; title: string; description: string }
  /** 分诊确认：用户确认 TriagePlan (Phase B) */
  | {
      kind: 'concierge_triage_confirm';
      planId: string;
      intent: TriagePlanIntent;
      summary: string;
    }
  /** 分诊取消：用户取消 TriagePlan (Phase B) */
  | { kind: 'concierge_triage_cancel'; planId: string };

// ---------------------------------------------------------------------------
// RelayReceipt — §1a state machine (lifecycle owner = POST /api/concierge/relay)
// ---------------------------------------------------------------------------

/**
 * RelayReceipt 状态：
 *   draft(确认卡渲染) → confirmed(用户点传话) → dispatched(cross_post 成功)
 *                                              ↘ dispatch_failed(可手动重试 → confirmed)
 *
 * INV R1: 先落记录再投递（crash window 内可恢复）
 * INV R2: dispatch_failed 手动重试，不自动重试
 * INV R3: 同一 receipt 重试用同一 clientMessageId（幂等）
 * INV R4: 仅 relay 端点写 relay 记录（旁路禁令）
 */
export type RelayReceiptStatus = 'draft' | 'confirmed' | 'dispatched' | 'dispatch_failed';

export interface RelayReceipt {
  id: string;
  userId: string;
  conciergeThreadId: string;
  targetThreadId: string;
  targetCats: string[];
  /** 用户原话全文（KD-3/KD-13：不是模型复述） */
  originalText: string;
  /** concierge thread 中的源消息 ID */
  sourceMessageId: string;
  /** cross_post 幂等 key（INV R3） */
  clientMessageId: string;
  status: RelayReceiptStatus;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// PendingConfirmation — §1b state machine
// ---------------------------------------------------------------------------

/**
 * PendingConfirmation 状态：
 *   rendered → confirmed(执行一次) | cancelled(变灰)
 *   刷新后从持久层重建可点性
 *
 * INV C1: 点击即 disabled，double-click 不双发
 * INV C2: payload 自包含，执行 deterministic，不回查模型
 * INV C3: 确认/取消状态持久化，刷新后保持
 * INV C4: 未知 action 走 CardBlock:102 现有 warn 路径
 */
export type ConfirmationStatus = 'rendered' | 'confirmed' | 'cancelled';

export interface PendingConfirmation {
  id: string;
  userId: string;
  messageId: string;
  action: ConciergeCardAction;
  status: ConfirmationStatus;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// TriagePlan — Phase B §2 state machine (lifecycle owner = dispatch handler)
// ---------------------------------------------------------------------------

/**
 * TriagePlan intent — 总机四大路径
 * relay: 传话到目标 thread
 * go: 跳转到目标 thread
 * propose_thread: 开新调查 thread
 * investigate: 前台猫自己查（Phase B2 InvestigationJob）
 */
export type TriagePlanIntent = 'relay' | 'go' | 'propose_thread' | 'investigate';

/**
 * TriagePlan 状态：
 *   proposed(值班猫生成) → confirmed(用户点确认) → dispatched(执行中)
 *                                                → completed(执行成功)
 *                                                → failed(执行失败，可重试)
 *   proposed → cancelled(用户取消/超时)
 *   failed → confirmed(用户重试)
 *
 * INV T1: 先落 proposed 再出确认卡
 * INV T2: 确认后才 dispatch（不自行跳过确认）
 * INV T3: failed 可手动重试（→ confirmed）
 */
export type TriagePlanStatus = 'proposed' | 'confirmed' | 'dispatched' | 'completed' | 'failed' | 'cancelled';

/** TriagePlan target — 根据 intent 不同字段可选 */
export interface TriagePlanTarget {
  /** relay/go 的目标 thread */
  threadId?: string;
  /** 目标 thread 标题（展示用） */
  threadTitle?: string;
  /** relay 的目标猫（resolver 产出或用户选择） */
  targetCats?: string[];
  /** relay 目标猫候选（resolver 模糊时，等待用户选择） */
  candidateCats?: string[];
  /** investigate/propose_thread 的查询/描述 */
  query?: string;
}

/** TriagePlan dispatch 结果 */
export interface TriagePlanResult {
  /** relay dispatch 的 receipt ID */
  relayReceiptId?: string;
  /** propose_thread 的 thread ID */
  proposedThreadId?: string;
  /** investigate 的 job ID (Phase B2) */
  investigationJobId?: string;
}

/**
 * TriagePlan: 用户描述 → 值班猫分诊 → 可确认的执行计划
 * TTL=0（铁律 5 LL-048）
 */
export interface TriagePlan {
  id: string;
  userId: string;
  /** 用户原话所在消息 ID */
  sourceMessageId: string;
  /** 承载确认卡的值班猫回复消息 ID（刷新后恢复 CardBlock 状态用） */
  confirmationMessageId?: string;
  /** 用户原话全文快照 */
  originalText: string;
  /** 分诊意图 */
  intent: TriagePlanIntent;
  /** 执行目标（按 intent 填充） */
  target: TriagePlanTarget;
  /** 状态机 */
  status: TriagePlanStatus;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  /** dispatch 结果 */
  result?: TriagePlanResult;
}

// ---------------------------------------------------------------------------
// InvestigationJob — Phase B2 §4 state machine (bounded async investigation)
// ---------------------------------------------------------------------------

/**
 * InvestigationJob 状态：
 *   queued(dispatch 创建) → running(worker 开始)
 *   running → done(报告已生成)
 *   running → failed(API 错误 / 所有源均失败)
 *   running → cancelled(用户取消 / deadline 到期)
 *   queued → cancelled(用户取消)
 *
 * INV I1: queued/running → cancelled（fail-closed on deadline）
 * INV I2: running → done 必须有 report
 * INV I3: 60s deadline 到期自动 cancel（不能 stuck running）
 */
export type InvestigationJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** InvestigationJob 报告中的单个 anchor（R-handle） */
export interface InvestigationAnchor {
  /** R1, R2, ... — 复用 KD-17 HandleMap 短标记 */
  handle: string;
  /** anchor 类型：thread=可跳转, doc/feature/github=路径/URL 呈现 */
  kind: 'thread' | 'doc' | 'feature' | 'github' | 'unknown';
  /** 目标 thread ID（仅 kind=thread） */
  threadId?: string;
  /** 可选 message ID（仅 kind=thread，精确到消息级别） */
  messageId?: string;
  /** 文件路径/URL（仅 kind=doc/feature/github） */
  path?: string;
  /** anchor 标题（展示用） */
  title: string;
  /** 相关度说明 */
  relevance: string;
}

/** InvestigationJob 报告（search 完成后生成） */
export interface InvestigationReport {
  /** 调查摘要 */
  summary: string;
  /** 带 R-handle 的 anchor 列表 */
  anchors: InvestigationAnchor[];
}

/**
 * InvestigationJob: 前台猫自查——bounded async 调查任务
 * TTL=0（铁律 5 LL-048）
 */
export interface InvestigationJob {
  id: string;
  userId: string;
  /** 关联的 TriagePlan ID */
  triagePlanId: string;
  /** 调查查询 */
  query: string;
  /** 允许的调查源 */
  scope: Array<'memory' | 'docs' | 'feat_index' | 'github'>;
  /** 状态机 */
  status: InvestigationJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** deadline = createdAt + 60_000（默认 1 分钟上限） */
  deadline: number;
  /** 调查报告（done 时必有） */
  report?: InvestigationReport;
}
