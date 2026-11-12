/**
 * F113 Phase E: POST /api/projects/mkdir
 * Creates a subdirectory within an allowed parent directory.
 * Uses parentPath + name (not full path) to prevent path-traversal attacks.
 */

import { lstat, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { validateNewProjectPath } from '../utils/persistent-project-path.js';
import { isUnderAllowedRoot } from '../utils/project-path.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

/** Characters not allowed in directory names (cross-platform safe) */
const INVALID_NAME = /[/\\:*?"<>|]/;

export const mkdirRoute: FastifyPluginAsync = async (app) => {
  app.post('/api/projects/mkdir', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const body = request.body as { parentPath?: string; name?: string } | null;
    const parentPath = body?.parentPath;
    const name = body?.name;

    if (typeof parentPath !== 'string' || !parentPath || typeof name !== 'string' || !name) {
      reply.status(400);
      return { error: 'parentPath and name are required' };
    }

    // Validate name: no traversal, no special chars
    if (name.includes('..') || INVALID_NAME.test(name)) {
      reply.status(400);
      return { error: 'Invalid directory name' };
    }

    // Validate parentPath exists and is under allowed roots
    const parent = await validateNewProjectPath(parentPath, 'Parent path not allowed');
    if (!parent.ok) {
      reply.status(403);
      return { error: parent.error };
    }

    // Resolve target and double-check it stays within allowed boundaries
    const targetPath = resolve(join(parent.path, name));
    if (!isUnderAllowedRoot(targetPath)) {
      reply.status(403);
      return { error: 'Target path not allowed' };
    }

    // A new child inherits the canonical parent's location. An existing link can resolve elsewhere.
    const existing = await lstat(targetPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return undefined;
    });
    if (existing) {
      if (existing.isDirectory() || existing.isSymbolicLink()) {
        const target = await validateNewProjectPath(targetPath, 'Target path not allowed');
        if (!target.ok) {
          reply.status(403);
          return { error: target.error };
        }
      }
      reply.status(409);
      return { error: 'Directory already exists' };
    }

    await mkdir(targetPath);
    return { createdPath: targetPath, name: basename(targetPath) };
  });
};
