/**
 * F232: Thread Artifacts Panel — 共享 DTO
 *
 * thread 产物聚合视图的统一返回类型。后端聚合器（thread-artifacts-aggregator）
 * 把三源（rich blocks / PR tasks / threadMemory ledger）映射成 ThreadArtifactDTO[]，
 * 前端 ArtifactsPanel + useThreadArtifacts 消费。
 */

/** 产物类型 — 决定前端图标 / 筛选分组 */
export type ThreadArtifactType = 'image' | 'file' | 'code' | 'pr' | 'audio' | 'video';

export interface ThreadArtifactDTO {
  /** 产物类型（图 / 文件 / 代码 / PR / 语音 / 视频） */
  type: ThreadArtifactType;
  /** 显示名（fileName / caption / filePath / PR 标题） */
  name: string;
  /** 哪只猫产生的（null = 未知 / 系统） */
  catId: string | null;
  /** 产生 / 更新时间（毫秒 epoch；排序键，时间倒序） */
  createdAt: number;
  /** 跳回原消息的锚点 messageId（AC-A4；null = 无源消息，如 ledger 文件） */
  sourceMessageId: string | null;
  /** 资源 URL（图 / 文件 / 语音的 /uploads/ 或外链；diff / 无 url 产物省略） */
  url?: string;
  /** 去重键（PR ref `org/repo#123` / 文件路径）；同 ref 取最新 */
  ref?: string;
}

/** GET /api/threads/:threadId/artifacts 响应 */
export interface ThreadArtifactsResponse {
  threadId: string;
  /** 时间倒序 */
  artifacts: ThreadArtifactDTO[];
}

/**
 * F232 Phase B: 全局产物 DTO — 扩展 ThreadArtifactDTO 附带 thread 上下文。
 * GET /api/artifacts 返回跨所有 thread 的产物聚合。
 */
export interface GlobalArtifactDTO extends ThreadArtifactDTO {
  /** 产物所属 thread */
  threadId: string;
  /** thread 标题（用于分组标签 / 上下文显示） */
  threadTitle: string;
}

/** GET /api/artifacts 响应 */
export interface GlobalArtifactsResponse {
  /** 时间倒序 */
  artifacts: GlobalArtifactDTO[];
  total: number;
}
