import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { createWorkspaceContentSource, resolveWorkspaceContentRoot } from './workspace-content-source-factory.js';
import { openedWorkspaceContentMatchesCanonicalLocator } from './workspace-content-source-utils.js';
import { resolveWorkspaceFilesystemPath, WorkspaceSecurityError } from './workspace-security.js';

const ASSET_MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const IDLE_MS = 30 * 60 * 1000;
const MAX_GRANTS = 128;
interface PreviewGrant {
  userId: string;
  worktreeId: string;
  root: string;
  directory: string;
  expiresAt: number;
  assertSessionCurrent?: () => void;
}

/** A read-only directory capability for an opaque iframe, never a browser session or a file writer. */
export class WorkspaceHtmlPreviews {
  private readonly grants = new Map<string, PreviewGrant>();
  constructor(private readonly now: () => number = Date.now) {}

  async prepare(userId: string, worktreeId: string, path: string, assertSessionCurrent?: () => void) {
    if (!/\.html?$/i.test(path)) throw new WorkspaceSecurityError('HTML file required', 'DENIED');
    const source = createWorkspaceContentSource(userId);
    const locator = await source.resolveFileLocator({ principal: { userId }, locator: { worktreeId, path } });
    const { root } = await resolveWorkspaceContentRoot(locator.worktreeId);
    const canonicalRoot = await realpath(root);
    const selected = await realpath(await resolveWorkspaceFilesystemPath(canonicalRoot, locator.path));
    assertSessionCurrent?.();
    for (const [id, grant] of this.grants) if (grant.expiresAt <= this.now()) this.grants.delete(id);
    const oldest = this.grants.keys().next().value;
    if (this.grants.size >= MAX_GRANTS && oldest !== undefined) this.grants.delete(oldest);
    const id = randomUUID();
    this.grants.set(id, {
      userId,
      worktreeId: locator.worktreeId,
      root: canonicalRoot,
      directory: dirname(selected),
      expiresAt: this.now() + IDLE_MS,
      assertSessionCurrent,
    });
    return { id, assetPath: `/api/workspace/html-preview/${id}/` };
  }

  revoke(userId: string, id: string): boolean {
    if (this.grants.get(id)?.userId !== userId) return false;
    return this.grants.delete(id);
  }

  clear(): void {
    this.grants.clear();
  }

  async openAsset(id: string, path: string): Promise<{ handle: FileHandle; size: number; mime: string }> {
    const grant = this.grants.get(id);
    if (!grant || grant.expiresAt <= this.now()) {
      this.grants.delete(id);
      throw new WorkspaceSecurityError('Preview is no longer open', 'NOT_FOUND');
    }
    try {
      grant.assertSessionCurrent?.();
    } catch {
      this.grants.delete(id);
      throw new WorkspaceSecurityError('Preview is no longer open', 'NOT_FOUND');
    }
    if (!path || path.length > 4096 || isAbsolute(path) || /[\\\0]/.test(path))
      throw new WorkspaceSecurityError('Invalid asset path', 'DENIED');
    const current = await resolveWorkspaceContentRoot(grant.worktreeId);
    if ((await realpath(current.root)) !== grant.root)
      throw new WorkspaceSecurityError('Preview directory changed', 'DENIED');
    const resolved = await realpath(await resolveWorkspaceFilesystemPath(grant.root, join(grant.directory, path)));
    const within = relative(grant.directory, resolved);
    if (!within || within === '..' || within.startsWith(`..${sep}`))
      throw new WorkspaceSecurityError('Asset outside preview directory', 'DENIED');
    const mime = ASSET_MIME[extname(resolved).toLowerCase()];
    if (!mime) throw new WorkspaceSecurityError('Unsupported page asset', 'DENIED');
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      const locator = { worktreeId: grant.worktreeId, path: relative(grant.root, resolved).split(sep).join('/') };
      if (
        !info.isFile() ||
        !(await openedWorkspaceContentMatchesCanonicalLocator(grant.root, resolved, locator, handle))
      )
        throw new WorkspaceSecurityError('Asset changed while opening', 'DENIED');
      if (info.size > MAX_ASSET_BYTES) throw new WorkspaceSecurityError('Asset exceeds preview limit', 'DENIED');
      grant.assertSessionCurrent?.();
      grant.expiresAt = this.now() + IDLE_MS;
      return { handle, size: info.size, mime };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
