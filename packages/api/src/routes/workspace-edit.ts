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
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { signEditToken, verifyEditToken, writeWorkspaceFile } from '../domains/workspace/workspace-edit.js';
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  moveWorkspaceFile,
  removeWorkspaceFile,
  uploadWorkspaceFile,
  WorkspaceMutationError,
} from '../domains/workspace/workspace-file-mutations.js';
import {
  getWorktreeRoot,
  resolveWorkspaceFilesystemPath,
  WorkspaceSecurityError,
} from '../domains/workspace/workspace-security.js';
import { isWorkspaceTextEditable as isEditable } from '../domains/workspace/workspace-text-policy.js';

/** Max upload size: 10MB */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const workspaceEditRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorkspaceMutationError) return reply.code(error.status).send({ error: error.message });
    return reply.send(error);
  });
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
      return { path: filePath, ...(await createWorkspaceFile(resolved, content ?? '')) };
    } catch (e) {
      if (e instanceof WorkspaceMutationError) throw e;
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
      await createWorkspaceDirectory(resolved);
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
      await removeWorkspaceFile(resolved);
      return { path: filePath, deleted: true };
    } catch (e) {
      if (e instanceof WorkspaceMutationError) throw e;
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
      await moveWorkspaceFile(resolvedOld, resolvedNew);
      return { oldPath, newPath };
    } catch (e) {
      if (e instanceof WorkspaceMutationError) throw e;
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

      await uploadWorkspaceFile(resolved, fileBuffer, overwrite);
      return { path: filePath, size: fileBuffer.length };
    } catch (e) {
      if (e instanceof WorkspaceMutationError) throw e;
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      reply.status(500);
      return { error: 'Internal error' };
    }
  });
};
