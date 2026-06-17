/**
 * F232 Phase A.1 — ArtifactsPanel 纯展示逻辑（无 React，便于单测）。
 *
 * - artifactRowMeta (AC-A5): catId → 昵称（fallback 原值）+ createdAt → 相对时间。
 * - classifyArtifactView (AC-A7): 产物按 type + 数据可用性分发到内容查看策略。
 *   决定「点击产物看什么」——这是 F232 灵魂（点击看内容，不只列清单）的判定核心。
 */
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { formatRelativeTime } from '../ThreadSidebar/thread-utils';

export interface ArtifactRowMeta {
  /** 显示名：已知 catId → 昵称；未知 → 原 catId；null → — */
  catLabel: string;
  /** 相对时间（委托 formatRelativeTime：刚刚/N分钟前/N小时前/N天前） */
  relativeTime: string;
}

export function artifactRowMeta(
  a: Pick<ThreadArtifactDTO, 'catId' | 'createdAt'>,
  resolveNickname: (id: string) => string | undefined,
): ArtifactRowMeta {
  return {
    catLabel: a.catId ? (resolveNickname(a.catId) ?? a.catId) : '—',
    relativeTime: formatRelativeTime(a.createdAt),
  };
}

/** 内容查看策略：决定点击产物后 panel 内渲染什么。 */
export type ArtifactView = 'image' | 'audio' | 'video' | 'pr' | 'text' | 'download' | 'fallback';

// 文本类扩展名 → panel 内看正文（MarkdownContent / CodeViewer）。
const TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'log',
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'html',
  'yml',
  'yaml',
  'sh',
  'bash',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sql',
  'toml',
  'xml',
  'csv',
  'tsv',
  'env',
]);
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function classifyArtifactView(a: Pick<ThreadArtifactDTO, 'type' | 'name' | 'url' | 'ref'>): ArtifactView {
  if (a.type === 'image' && a.url) return 'image';
  if (a.type === 'audio' && a.url) return 'audio';
  if (a.type === 'video' && a.url) return 'video';
  if (a.type === 'pr') return 'pr';
  // file / code：先看有无内容源，再按扩展名分文本 vs 二进制。
  const hasSource = Boolean(a.url || a.ref);
  if (!hasSource) return 'fallback';
  const ext = extensionOf(a.name);
  // allowlist：无扩展名（如 LICENSE/Makefile，当文本试）或已知文本扩展名 → panel 内看正文；
  // 其余（已知二进制 + 未知扩展名）→ download，避免把二进制 fetch+decode 成文本（hang panel/乱码）。
  if (!ext || TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'download';
}

/** PR ref（org/repo#123）→ GitHub PR url；解析失败返回 undefined。 */
export function prRefToUrl(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(ref.trim());
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : undefined;
}

/**
 * 站内资源路径（uploads/api/avatars）判定。
 * fetch() 跨域默认不发 cookie，站内资源在 hosted 路径（cafe→api.clowder-ai.com）跨域时必须显式带
 * session cookie；img/audio/a 标签则由浏览器自动带 same-site cookie，无需特殊处理。
 */
export function isSiteAssetPath(url: string | undefined): boolean {
  if (!url) return false;
  const t = url.trim();
  return t.startsWith('/uploads/') || t.startsWith('/api/') || t.startsWith('/avatars/');
}

/** 资源 url 解析：/uploads/ 等站内相对路径补 apiBase 前缀；外链原样返回。 */
export function resolveAssetUrl(url: string | undefined, apiBase: string): string | undefined {
  if (!url) return undefined;
  const t = url.trim();
  if (isSiteAssetPath(t)) return `${apiBase}${t}`;
  return t;
}

/**
 * 文本类产物（view='text'）的内容来源判定：
 *  - 有 url（uploads 文本文件）→ 直接 fetch url
 *  - 无 url 有 ref + 有 worktreeId（repo 文件，如 backlog）→ 走 workspace 文件 API
 *  - 无 url 无 ref，或 repo 文件但无 worktreeId（用户没开过 workspace）→ none（降级到 fallback）
 */
export type ArtifactContentSource =
  | { kind: 'url'; url: string }
  | { kind: 'workspace'; path: string }
  | { kind: 'none' };

export function artifactContentSource(
  a: Pick<ThreadArtifactDTO, 'url' | 'ref'>,
  worktreeId: string | null,
): ArtifactContentSource {
  if (a.url) return { kind: 'url', url: a.url };
  if (a.ref && worktreeId) return { kind: 'workspace', path: a.ref };
  return { kind: 'none' };
}

export { TEXT_EXTENSIONS };
