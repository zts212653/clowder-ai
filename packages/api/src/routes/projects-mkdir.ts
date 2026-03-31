/**
 * F113 Phase E: POST /api/projects/mkdir
 * Creates a subdirectory within an allowed parent directory.
 * Uses parentPath + name (not full path) to prevent path-traversal attacks.
 */

import { mkdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { isUnderAllowedRoot, validateProjectPath } from '../utils/project-path.js';
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

    if (!parentPath || !name) {
      reply.status(400);
      return { error: 'parentPath and name are required' };
    }

    // Validate name: no traversal, no special chars
    if (name.includes('..') || INVALID_NAME.test(name)) {
      reply.status(400);
      return { error: 'Invalid directory name' };
    }

    // Validate parentPath exists and is under allowed roots
    const validatedParent = await validateProjectPath(parentPath);
    if (!validatedParent) {
      reply.status(403);
      return { error: 'Parent path not allowed' };
    }

    // Resolve target and double-check it stays within allowed boundaries
    const targetPath = resolve(join(validatedParent, name));
    if (!isUnderAllowedRoot(targetPath)) {
      reply.status(403);
      return { error: 'Target path not allowed' };
    }

    // Check if target already exists
    try {
      await stat(targetPath);
      reply.status(409);
      return { error: 'Directory already exists' };
    } catch {
      // Expected — target should not exist
    }

    await mkdir(targetPath);
    return { createdPath: targetPath, name: basename(targetPath) };
  });
};
