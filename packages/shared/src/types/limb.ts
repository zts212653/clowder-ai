/**
 * Limb Types — F126 四肢控制面
 *
 * 四肢节点的类型定义：接口、能力、状态、权限。
 * 猫猫是灵魂议会的议员，四肢是外部设备/节点。
 */

// ─── Node Status ─────────────────────────────────────────────

/** 四肢节点状态 */
export type LimbNodeStatus = 'online' | 'busy' | 'offline' | 'degraded';

// ─── Authorization ───────────────────────────────────────────

/** 能力授权级别 */
export type LimbAuthLevel = 'free' | 'leased' | 'gated';

// ─── Capabilities ────────────────────────────────────────────

/** 单个四肢能力 */
export interface LimbCapability {
  /** 高级类别: "camera", "voice", "gpu_render", "browser", "exec" */
  cap: string;
  /** 精确命令白名单: ["camera.snap", "camera.record"] */
  commands: string[];
  /** 授权级别 */
  authLevel: LimbAuthLevel;
}

// ─── Access Policy (Phase A schema 预留, Phase B 实现) ────────

/** 三维权限条目: catId × nodeId × capability */
export interface LimbAccessEntry {
  catId: string;
  nodeId: string;
  capability: string;
  authLevel: LimbAuthLevel;
}

// ─── ILimbNode Interface ─────────────────────────────────────

/** 四肢调用结果 */
export interface LimbInvokeResult {
  success: boolean;
  data?: unknown;
  artifactUri?: string;
  error?: string;
}

/**
 * ILimbNode — 所有四肢必须实现的接口
 *
 * 四肢是外部设备/节点（iPhone, Windows 机, Mac Mini, Watch 等），
 * 不是猫猫 Provider（AgentService 不变）。
 */
export interface ILimbNode {
  /** 节点唯一 ID */
  readonly nodeId: string;
  /** 显示名称 */
  readonly displayName: string;
  /** 运行平台 */
  readonly platform: string;
  /** 节点暴露的能力列表 */
  readonly capabilities: LimbCapability[];

  /** 向 Registry 注册 */
  register(): Promise<void>;
  /** 调用节点能力 */
  invoke(command: string, params: Record<string, unknown>): Promise<LimbInvokeResult>;
  /** 健康检查 */
  healthCheck(): Promise<LimbNodeStatus>;
  /** 从 Registry 注销 */
  deregister(): Promise<void>;
}

// ─── Lease (Phase B) ─────────────────────────────────────────

/** 租约记录 — 独占资源的锁 */
export interface LimbLease {
  leaseId: string;
  nodeId: string;
  capability: string;
  catId: string;
  acquiredAt: number;
  expiresAt: number;
  renewCount: number;
}

// ─── Action Log (Phase B) ────────────────────────────────────

/** Action Log 条目 — 最小 provenance 字段集 */
export interface LimbActionLogEntry {
  requestId: string;
  invocationId: string;
  leaseId: string | null;
  catId: string;
  nodeId: string;
  capability: string;
  command: string;
  artifactUri: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt: number | null;
  idempotencyKey: string | null;
}

// ─── Registry Record ─────────────────────────────────────────

/** Registry 中的节点记录（运行时状态） */
export interface LimbNodeRecord {
  nodeId: string;
  displayName: string;
  platform: string;
  capabilities: LimbCapability[];
  status: LimbNodeStatus;
  registeredAt: number;
  lastHeartbeatAt: number;
}
