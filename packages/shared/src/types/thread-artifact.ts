/**
 * F232: Thread Artifacts Panel — 共享 DTO
 *
 * thread 产物聚合视图的统一返回类型。后端聚合器（thread-artifacts-aggregator）
 * 把三源（rich blocks / PR tasks / threadMemory ledger）映射成 ThreadArtifactDTO[]，
 * 前端 ArtifactsPanel + useThreadArtifacts 消费。
 */

/** 产物类型 — 决定前端图标 / 筛选分组 */
import type { MessageMediaItemSelector } from './media-publication-source.js';

export type ThreadArtifactType = 'image' | 'file' | 'code' | 'pr' | 'audio' | 'video' | 'widget';

export interface ThreadArtifactDTO {
  /** 产物类型（图 / 文件 / 代码 / PR / 语音 / 视频 / 小组件） */
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
  /** Exact item within the durable source message; URL/name never disambiguate a publication. */
  publicationItem?: MessageMediaItemSelector;
  /**
   * `html_widget` 在原消息 `extra.rich.blocks` 里的块 id。
   *
   * 只回答「哪条消息里的哪个 HTML 块」，不是作品 ID、不是版本号，也不含正文。
   * 由服务端从已持久化的原块生成；读取正文时必须重新核对 thread / message / block id
   * 以及 `kind === 'html_widget'`，不能只按标题或数组里第一个 widget 命中。
   * 没有这个字段的 widget 产物（interactive 卡片、旧数据）不能进 HTML 预览。
   */
  widgetBlockId?: string;
  /** 去重键（PR ref `org/repo#123` / 文件路径）；同 ref 取最新 */
  ref?: string;
  /** File-ledger owner key, independent of display name/update time. Not execution-root proof. */
  fileLedgerRef?: string;
  /** Exact, currently authorized F309 publication landing. Absent means its version is unknown. */
  work?: GlobalArtifactWork;
}

/** GET /api/threads/:threadId/artifacts 响应 */
export interface ThreadArtifactsResponse {
  threadId: string;
  /** 时间倒序 */
  artifacts: ThreadArtifactDTO[];
  /** Owner reads can be unavailable while the original artifacts remain readable. */
  workLineage?: 'resolved' | 'unavailable';
  /** Explicit delivery view; the default remains the original full file/PR/publication catalogue. */
  view?: 'works';
  /** Count of distinct proven sources; exact historical DTOs remain in artifacts for existing return coordinates. */
  total?: number;
  complete?: boolean;
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

export interface GlobalArtifactWork {
  contentRef: string;
  ownerRevision: number;
  currentOwnerRevision: number;
  /** Source-provenanced production time for this fixed version, distinct from catalogue import order. */
  versionCreatedAt?: number;
  versionTimeSource?: string;
}

/** GET /api/artifacts 响应 */
export interface GlobalArtifactsResponse {
  view?: 'works' | 'recent-works';
  /** 时间倒序 */
  artifacts: GlobalArtifactDTO[];
  total: number;
  /** `unavailable` means the owner catalogue could not be read completely; no partial work fields are exposed. */
  workLineage: 'resolved' | 'unavailable';
  /** Present on bounded views. False means older owner history was intentionally not scanned. */
  complete?: boolean;
  /** Only on opt-in Works pages. Positions convey no authority; every page rechecks owner access. */
  nextCursor?: string;
}

/** Opt-in `view=works&read=pages`: page size is never a claimed whole-catalogue total. */
export interface GlobalWorksPageResponse extends Omit<GlobalArtifactsResponse, 'total' | 'complete' | 'view'> {
  view: 'works';
  pageTotal: number;
  complete: boolean;
}
