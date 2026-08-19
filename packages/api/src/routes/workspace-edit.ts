/**
 * Workspace Edit Routes — F063 AC-9 + Gap 4
 *
 * POST   /api/workspace/edit-session  — sign edit session token (30min TTL)
 * PUT    /api/workspace/file          — write file (edit_session_token + sha256 conflict)
 * POST   /api/workspace/file/create   — create new file
 * POST   /api/workspace/dir/create    — create directory (mkdir -p)
 * DELETE /api/workspace/file          — delete file or empty directory
 * POST   /api/workspace/file/rename   — rename/move file
 * POST   /api/workspace/upload        — upload file (multipart)
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { signEditToken, verifyEditToken, writeWorkspaceFile } from '../domains/workspace/workspace-edit.js';
import {
  getWorktreeRoot,
  resolveWorkspaceFilesystemPath,
  WorkspaceSecurityError,
} from '../domains/workspace/workspace-security.js';

/** Extensions allowed for text editing (whitelist approach). */
const EDITABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.py',
  '.txt',
]);

/** Dotfiles (no extension) that are safe to edit. */
const EDITABLE_DOTFILES = new Set([
  '.gitignore',
  '.npmrc',
  '.eslintrc',
  '.prettierrc',
  '.editorconfig',
  '.env.example',
  '.nvmrc',
  '.dockerignore',
  '.prettierignore',
]);

function isEditable(filepath: string): boolean {
  const ext = extname(filepath);
  if (ext && EDITABLE_EXTENSIONS.has(ext)) return true;
  // Dotfiles without extension — only explicit safe list
  const basename = filepath.split('/').pop() ?? '';
  if (EDITABLE_DOTFILES.has(basename)) return true;
  return false;
}

/** Max upload size: 10MB */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const workspaceEditRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });
  // POST /api/workspace/edit-session — sign an edit session token (30min TTL)
  app.post<{
    Body: { worktreeId: string };
  }>('/api/workspace/edit-session', async (request, reply) => {
    const { worktreeId } = request.body ?? {};
    if (!worktreeId) {
      reply.status(400);
      return { error: 'worktreeId required' };
    }
    try {
      await getWorktreeRoot(worktreeId); // validate worktree exists
      const token = signEditToken(worktreeId);
      return { token, expiresIn: 1800 };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(404);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // PUT /api/workspace/file — write file content (requires edit_session_token + baseSha256)
  app.put<{
    Body: {
      worktreeId: string;
      path: string;
      content: string;
      baseSha256: string;
      editSessionToken: string;
    };
  }>('/api/workspace/file', async (request, reply) => {
    const { worktreeId, path: filePath, content, baseSha256, editSessionToken } = request.body ?? {};
    if (!worktreeId || !filePath || content == null || !baseSha256 || !editSessionToken) {
      reply.status(400);
      return { error: 'worktreeId, path, content, baseSha256, and editSessionToken required' };
    }

    // Token validation
    const payload = verifyEditToken(editSessionToken, worktreeId);
    if (!payload) {
      reply.status(401);
      return { error: 'Invalid or expired edit session token' };
    }

    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspaceFilesystemPath(root, filePath);
      // Reject non-editable files (binary, images, unknown extensions)
      if (!isEditable(filePath)) {
        reply.status(400);
        return { error: 'Cannot edit binary files' };
      }

      const result = await writeWorkspaceFile(resolved, content, baseSha256);
      if (!result.ok) {
        reply.status(409);
        return { error: 'Conflict: file was modified', currentSha256: result.currentSha256 };
      }

      return { path: filePath, sha256: result.newSha256, size: result.size };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404);
        return { error: 'File not found' };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // POST /api/workspace/file/create — create new file (no overwrite)
  app.post<{
    Body: { worktreeId: string; path: string; content?: string; editSessionToken: string };
  }>('/api/workspace/file/create', async (request, reply) => {
    const { worktreeId, path: filePath, content, editSessionToken } = request.body ?? {};
    if (!worktreeId || !filePath) {
      reply.status(400);
      return { error: 'worktreeId and path required' };
    }
    if (!editSessionToken || !verifyEditToken(editSessionToken, worktreeId)) {
      reply.status(401);
      return { error: 'Invalid or expired edit session token' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspaceFilesystemPath(root, filePath);
      // Check if file already exists
      try {
        await stat(resolved);
        reply.status(409);
        return { error: 'File already exists' };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      // Ensure parent directory exists
      await mkdir(dirname(resolved), { recursive: true });
      const fileContent = content ?? '';
      await writeFile(resolved, fileContent, 'utf-8');
      const sha = createHash('sha256').update(fileContent).digest('hex');
      return { path: filePath, sha256: sha, size: Buffer.byteLength(fileContent) };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // POST /api/workspace/dir/create — create directory (mkdir -p)
  app.post<{
    Body: { worktreeId: string; path: string; editSessionToken: string };
  }>('/api/workspace/dir/create', async (request, reply) => {
    const { worktreeId, path: dirPath, editSessionToken } = request.body ?? {};
    if (!worktreeId || !dirPath || !editSessionToken) {
      reply.status(400);
      return { error: 'worktreeId, path, and editSessionToken required' };
    }
    if (!verifyEditToken(editSessionToken, worktreeId)) {
      reply.status(401);
      return { error: 'Invalid or expired edit session token' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspaceFilesystemPath(root, dirPath);
      await mkdir(resolved, { recursive: true });
      return { path: dirPath };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // DELETE /api/workspace/file — delete file or empty directory
  app.delete<{
    Body: { worktreeId: string; path: string; editSessionToken: string };
  }>('/api/workspace/file', async (request, reply) => {
    const { worktreeId, path: filePath, editSessionToken } = request.body ?? {};
    if (!worktreeId || !filePath) {
      reply.status(400);
      return { error: 'worktreeId and path required' };
    }
    if (!editSessionToken || !verifyEditToken(editSessionToken, worktreeId)) {
      reply.status(401);
      return { error: 'Invalid or expired edit session token' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspaceFilesystemPath(root, filePath);
      const s = await stat(resolved).catch(() => null);
      if (!s) {
        reply.status(404);
        return { error: 'File not found' };
      }
      if (s.isDirectory()) {
        await rmdir(resolved); // fails if non-empty (safe)
      } else {
        await rm(resolved);
      }
      return { path: filePath, deleted: true };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // POST /api/workspace/file/rename — rename/move file
  app.post<{
    Body: { worktreeId: string; oldPath: string; newPath: string; editSessionToken: string };
  }>('/api/workspace/file/rename', async (request, reply) => {
    const { worktreeId, oldPath, newPath, editSessionToken } = request.body ?? {};
    if (!worktreeId || !oldPath || !newPath || !editSessionToken) {
      reply.status(400);
      return { error: 'worktreeId, oldPath, newPath, and editSessionToken required' };
    }
    if (!verifyEditToken(editSessionToken, worktreeId)) {
      reply.status(401);
      return { error: 'Invalid or expired edit session token' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const resolvedOld = await resolveWorkspaceFilesystemPath(root, oldPath);
      const resolvedNew = await resolveWorkspaceFilesystemPath(root, newPath);
      // Source must exist
      const s = await stat(resolvedOld).catch(() => null);
      if (!s) {
        reply.status(404);
        return { error: 'Source not found' };
      }
      // Target must not exist
      const t = await stat(resolvedNew).catch(() => null);
      if (t) {
        reply.status(409);
        return { error: 'Target already exists' };
      }
      await mkdir(dirname(resolvedNew), { recursive: true });
      await rename(resolvedOld, resolvedNew);
      return { oldPath, newPath };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });

  // POST /api/workspace/upload — upload file (multipart/form-data)
  app.post('/api/workspace/upload', async (request, reply) => {
    try {
      const parts = request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } });
      let worktreeId = '';
      let filePath = '';
      let editSessionToken = '';
      let fileBuffer: Buffer | null = null;

      for await (const part of parts) {
        if (part.type === 'field') {
          const val = String(part.value);
          if (part.fieldname === 'worktreeId') worktreeId = val;
          else if (part.fieldname === 'path') filePath = val;
          else if (part.fieldname === 'editSessionToken') editSessionToken = val;
        } else if (part.type === 'file') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk);
          fileBuffer = Buffer.concat(chunks);
        }
      }

      if (!worktreeId || !filePath || !fileBuffer) {
        reply.status(400);
        return { error: 'worktreeId, path, and file required' };
      }
      if (!editSessionToken || !verifyEditToken(editSessionToken, worktreeId)) {
        reply.status(401);
        return { error: 'Invalid or expired edit session token' };
      }

      const overwrite = (request.query as Record<string, string>).overwrite === 'true';
      const root = await getWorktreeRoot(worktreeId);
      const resolved = await resolveWorkspaceFilesystemPath(root, filePath);

      if (!overwrite) {
        try {
          await stat(resolved);
          reply.status(409);
          return { error: 'File already exists. Use ?overwrite=true to replace.' };
        } catch {
          // ENOENT = file doesn't exist, proceed
        }
      }

      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, fileBuffer);
      return { path: filePath, size: fileBuffer.length };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });
};
