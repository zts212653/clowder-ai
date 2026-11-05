import { open, realpath, stat } from 'node:fs/promises';
import { resolvePersistentProjectPathDetailed } from '../../utils/persistent-project-path.js';
import { awaitStoreRead } from '../cats/services/stores/ports/StoreReadOptions.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import { recognizesRoadmapProject, roadmapFilePath } from './thread-roadmap-project.js';
import { type RoadmapVersion, readRoadmapVersion } from './thread-roadmap-version.js';
import {
  canonicalizeWorkspaceContentLocator,
  decodeWorkspaceText,
  digestWorkspaceFile,
  hasSameWorkspaceFileState,
  openedWorkspaceContentMatchesCanonicalLocator,
} from './workspace-content-source-utils.js';

export interface RoadmapPointer {
  status: 'available' | 'revoked' | 'invalid' | 'unavailable';
  reason?: string;
  projectPath?: string;
  path?: string;
  revision?: number;
  sourceRef?: string;
  revokedBy?: string;
  revokedAt?: number;
  revokeSourceRef?: string;
  version?: RoadmapVersion;
  contentSha256?: string;
  asOf?: number | null;
  documentUpdated?: string;
  activityAfterDocument?: boolean | null;
  drillDown?: { tool: 'cat_cafe_read_file_slice'; args: { path: string; startLine: number; endLine: number } };
}
type DocumentSource = Omit<RoadmapPointer, 'revision' | 'sourceRef' | 'activityAfterDocument'>;
export type RoadmapReadCache = Map<string, Promise<DocumentSource>>;

async function readDocument(root: string, path: string, signal: AbortSignal): Promise<DocumentSource> {
  try {
    if ((await realpath(root)) !== root) return { status: 'unavailable', reason: 'project_identity_changed' };
    const project = await resolvePersistentProjectPathDetailed(root);
    if (!project.ok || project.path !== root) return { status: 'unavailable', reason: 'project_unavailable' };
    if (!(await stat(root)).isDirectory()) return { status: 'unavailable', reason: 'project_unavailable' };
  } catch {
    return { status: 'unavailable', reason: 'project_unavailable' };
  }
  try {
    const safePath = await roadmapFilePath(root, path);
    const canonical = await canonicalizeWorkspaceContentLocator(root, { worktreeId: 'roadmap', path });
    const handle = await open(safePath, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) return { status: 'invalid', reason: 'not_a_file' };
      if (before.size > 256 * 1024) return { status: 'unavailable', reason: 'file_exceeds_read_budget' };
      if (!(await openedWorkspaceContentMatchesCanonicalLocator(root, safePath, canonical.locator, handle)))
        return { status: 'unavailable', reason: 'file_changed_during_read' };
      signal.throwIfAborted();
      const content = await digestWorkspaceFile(handle, before.size, true);
      const version = await readRoadmapVersion(root, path, signal);
      if (
        !hasSameWorkspaceFileState(before, await handle.stat()) ||
        !(await openedWorkspaceContentMatchesCanonicalLocator(root, safePath, canonical.locator, handle))
      )
        return { status: 'unavailable', reason: 'file_changed_during_read' };
      const text = decodeWorkspaceText(content.bytes ?? Buffer.alloc(0));
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(0, 16_000));
      const updated = frontmatter && /^updated:\s*(.+)$/m.exec(frontmatter[1]);
      return {
        status: 'available',
        projectPath: root,
        path,
        version,
        contentSha256: content.digest,
        asOf: version.status === 'available' ? version.committedAt : null,
        ...(updated ? { documentUpdated: updated[1].trim().slice(0, 200) } : {}),
        drillDown: { tool: 'cat_cafe_read_file_slice', args: { path: canonical.path, startLine: 1, endLine: 120 } },
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['ENOENT', 'ENOTDIR'].includes(code)) return { status: 'invalid', reason: 'file_missing' };
    return { status: 'unavailable', reason: signal.aborted ? 'budget_exhausted' : 'file_unreachable' };
  }
}

/** Coordinates remain in ThreadMetadata. Each read verifies present project standing and the original file. */
export async function readThreadRoadmap(input: {
  thread: Thread;
  threadStore: IThreadStore;
  userId: string;
  signal?: AbortSignal;
  cache?: RoadmapReadCache;
}): Promise<RoadmapPointer | undefined> {
  const binding = input.thread.threadMetadata?.roadmap;
  if (!binding) return undefined;
  const signal = AbortSignal.any([AbortSignal.timeout(1200), ...(input.signal ? [input.signal] : [])]);
  try {
    return await awaitStoreRead(
      (async () => {
        if (!(await recognizesRoadmapProject(input.threadStore, input.userId, binding.projectPath, input.thread))) {
          // A disconnected legacy project alias cannot prove identity; that is not a permission withdrawal.
          try {
            await stat(binding.projectPath);
          } catch {
            return { status: 'unavailable' as const, reason: 'project_unavailable' };
          }
          return { status: 'unavailable' as const, reason: 'project_identity_unverified' };
        }
        const coordinate = {
          projectPath: binding.projectPath,
          path: binding.path,
          revision: binding.revision,
          sourceRef: binding.sourceRef,
        };
        if (binding.state === 'revoked')
          return {
            ...coordinate,
            status: 'revoked' as const,
            revokedBy: binding.revokedBy,
            revokedAt: binding.revokedAt,
            revokeSourceRef: binding.revokeSourceRef,
          };
        const key = JSON.stringify([binding.projectPath, binding.path]);
        const pending = input.cache?.get(key) ?? readDocument(binding.projectPath, binding.path, signal);
        input.cache?.set(key, pending);
        const document = await pending;
        return {
          ...coordinate,
          ...document,
          activityAfterDocument: document.asOf == null ? null : input.thread.lastActiveAt > document.asOf,
        };
      })(),
      { signal },
    );
  } catch {
    return { status: 'unavailable', reason: signal.aborted ? 'budget_exhausted' : 'source_error' };
  }
}

export async function readNavigationRoadmap(
  threadStore: IThreadStore,
  userId: string,
  threadId: string,
): Promise<RoadmapPointer | undefined> {
  const signal = AbortSignal.timeout(1200);
  try {
    const thread = await awaitStoreRead(
      Promise.resolve().then(() => threadStore.get(threadId)),
      { signal },
    );
    return thread ? await readThreadRoadmap({ thread, threadStore, userId, signal }) : undefined;
  } catch {
    return { status: 'unavailable', reason: signal.aborted ? 'budget_exhausted' : 'metadata_source_error' };
  }
}

export function formatRoadmapPointer(pointer: RoadmapPointer): string {
  if (pointer.status === 'revoked')
    return `roadmap: 已撤回 · ${pointer.revokedBy} · ${new Date(pointer.revokedAt ?? 0).toISOString()}`;
  if (pointer.status !== 'available')
    return `roadmap: ${pointer.status === 'invalid' ? '失效' : '暂不可达/未知'}（${pointer.reason}）`;
  const version = pointer.version;
  const versionLabel =
    version?.status === 'available'
      ? `@${version.commit?.slice(0, 12) ?? '无版本'}${version.dirty ? '+未提交改动' : ''} · 分支 ${version.branch ?? '未知'}`
      : `版本未知（${version?.reason === 'git_timeout' ? 'git 超时' : 'git 查询失败'}）`;
  return `roadmap: ${JSON.stringify(`${pointer.projectPath}:${pointer.path}`)} ${versionLabel} · 截至 ${pointer.asOf == null ? '未知' : new Date(pointer.asOf).toISOString()}${pointer.documentUpdated ? ' · 文档含自述 updated 字段，见原文' : ''}${pointer.activityAfterDocument ? ' · 此后线程有新活动，内容变化待核' : ''} · 按需 cat_cafe_read_file_slice(${JSON.stringify(pointer.drillDown?.args)})；读取权限由原工具核定，责任看原Task`;
}
