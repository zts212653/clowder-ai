/**
 * Prompt Injection Template Overlay API (F237 Checkpoint C)
 *
 * Endpoints for reading, editing, previewing, and resetting
 * prompt injection template overlays (.local files).
 *
 * GET  /api/prompt-injection/segment/:id/content — current effective content
 * POST /api/prompt-injection/segment/:id/preview — compile preview with vars
 * PUT  /api/prompt-injection/segment/:id/override — save .local overlay
 * DELETE /api/prompt-injection/segment/:id/override — reset to default
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import YAML from 'yaml';
import {
  requireCapabilityWriteOwner,
  requireLocalCapabilityWriteRequest,
} from '../config/capabilities/capability-write-guards.js';
import { clearL0Cache } from '../domains/cats/services/agents/providers/l0-compiler.js';
import {
  getOverrideStatus,
  getTemplateFileInfo,
  getTemplateOverlayPath,
  getTemplateRawContent,
  renderTemplate,
  stripComments,
} from '../domains/cats/services/context/prompt-template-loader.js';
import { RICH_BLOCK_SHORT } from '../domains/cats/services/context/rich-block-rules.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveHookContent } from './prompt-injection-hooks.js';

/**
 * Session-only auth for write operations — reads sessionUserId directly
 * from the cookie-backed session middleware, bypassing resolveUserId's
 * X-Cat-Cafe-User header fallback that non-browser clients could spoof.
 * Matches the capability-write-guards.ts pattern.
 */
function resolveWriteUserId(request: import('fastify').FastifyRequest): string | null {
  const sessionUserId = (request as import('fastify').FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof sessionUserId === 'string' && sessionUserId.trim() ? sessionUserId.trim() : null;
}

/**
 * Combined session + owner gate for overlay write endpoints.
 * Returns the userId on success, or sends an error reply and returns null.
 * Matches the capability-write-guards.ts two-layer pattern:
 *   Layer 1 — session auth (401 if missing)
 *   Layer 2 — owner gate (403 if DEFAULT_OWNER_USER_ID configured and mismatch)
 */
type OverlayWriteAuthResult = { ok: true; userId: string } | { ok: false; status: number; error: string };

function requireOverlayWriteAuth(request: import('fastify').FastifyRequest): OverlayWriteAuthResult {
  const userId = resolveWriteUserId(request);
  if (!userId) {
    return { ok: false, status: 401, error: 'Authentication required for overlay writes' };
  }
  const localError = requireLocalCapabilityWriteRequest(request);
  if (localError) {
    return { ok: false, status: localError.status, error: localError.error };
  }
  const ownerError = requireCapabilityWriteOwner(userId, { allowMissingOwner: true });
  if (ownerError) {
    return { ok: false, status: ownerError.status, error: ownerError.error };
  }
  return { ok: true, userId };
}

/**
 * Validate that YAML content parses to a mapping of string values.
 * Returns an error message or null if valid.
 * Used by both save and restore-backup paths (P2 audit: same gate on all write paths).
 */
function validateYamlStringMapping(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (e) {
    return `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'YAML must be a mapping (object), not a scalar or list';
  }
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      return `Value for key "${key}" must be a string, got ${typeof val}`;
    }
  }
  return null;
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function tmpPathFor(path: string): string {
  return `${path}.${process.pid}.${process.hrtime.bigint()}.tmp`;
}

function atomicWriteFileSync(path: string, content: string): void {
  const tmpPath = tmpPathFor(path);
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, path);
  } finally {
    removeIfExists(tmpPath);
  }
}

function atomicCopyFileSync(sourcePath: string, targetPath: string): void {
  const tmpPath = tmpPathFor(targetPath);
  try {
    copyFileSync(sourcePath, tmpPath);
    renameSync(tmpPath, targetPath);
  } finally {
    removeIfExists(tmpPath);
  }
}

function invalidateNativeL0CacheForSegment(segmentId: string): void {
  if (segmentId === 'S6') {
    clearL0Cache();
  }
}

// ── Dynamic segment metadata (derived from TEMPLATE_FILES registry) ──

interface SegmentMeta {
  allowLocalOverride: boolean;
  ext: 'yaml' | 'md';
  vars: string[];
}

/** Known runtime values for template variable preview rendering */
const KNOWN_PREVIEW_VARS: Record<string, string> = {
  RICH_BLOCK_SHORT: RICH_BLOCK_SHORT,
  CC_MENTION: '@铲屎官',
};

/** Derive segment meta dynamically from TEMPLATE_FILES registry (all 49 segments) */
function resolveSegmentMeta(id: string): SegmentMeta | null {
  const fileInfo = getTemplateFileInfo(id);
  if (!fileInfo) return null;
  const ext: 'yaml' | 'md' = fileInfo.base.endsWith('.yaml') ? 'yaml' : 'md';
  const raw = getTemplateRawContent(id, false);
  const vars: string[] = [];
  if (raw) {
    for (const m of raw.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!vars.includes(m[1])) vars.push(m[1]);
    }
  }
  return { allowLocalOverride: !!fileInfo.local, ext, vars };
}

function resolveVars(segmentId: string): Record<string, string> {
  const meta = resolveSegmentMeta(segmentId);
  if (!meta) return {};
  const result: Record<string, string> = {};
  for (const v of meta.vars) {
    if (v in KNOWN_PREVIEW_VARS) result[v] = KNOWN_PREVIEW_VARS[v];
  }
  return result;
}

// ── Route plugin ─────────────────────────────────────────────

export const promptInjectionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/prompt-injection/segment/:id/content
   * Returns raw template content (base or override) + override status.
   */
  app.get<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/content', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { id } = request.params;
    const meta = resolveSegmentMeta(id);

    // Hook segments (H1-H3): read source script file directly
    if (!meta) {
      const hookResult = await resolveHookContent(id);
      if (hookResult) return hookResult;
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }

    const status = getOverrideStatus(id);
    const content = getTemplateRawContent(id, true);
    const baseContent = status?.hasOverride ? getTemplateRawContent(id, false) : content;
    const overlayPath = getTemplateOverlayPath(id);
    const hasBackup = overlayPath ? existsSync(`${overlayPath}.bak`) : false;

    return {
      segmentId: id,
      allowLocalOverride: meta.allowLocalOverride,
      hasOverride: status?.hasOverride ?? false,
      hasBackup,
      content: content ?? '',
      baseContent: baseContent ?? '',
      vars: meta.vars,
    };
  });

  /**
   * POST /api/prompt-injection/segment/:id/preview
   * Compile preview — renders template with runtime variables.
   * Body: { content: string }
   */
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    '/api/prompt-injection/segment/:id/preview',
    async (request, reply) => {
      if (!resolveUserId(request)) {
        reply.status(401);
        return { error: 'Authentication required' };
      }
      const { id } = request.params;
      const meta = resolveSegmentMeta(id);
      if (!meta) {
        reply.status(404);
        return { error: `Segment ${id} is not template-backed` };
      }

      const { content } = request.body ?? {};
      if (typeof content !== 'string') {
        reply.status(400);
        return { error: 'Missing content field' };
      }

      const vars = resolveVars(id);
      let rendered: string;
      if (meta.ext === 'yaml') {
        // YAML preview: parse and show per-key values
        try {
          const parsed: unknown = YAML.parse(content);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reply.status(400);
            return { error: 'YAML must be a mapping (object), not a scalar or list' };
          }
          const entries: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            entries[k] = typeof v === 'string' ? v.trimEnd() : String(v);
          }
          rendered = JSON.stringify(entries, null, 2);
        } catch (e) {
          reply.status(400);
          return { error: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
        }
      } else {
        rendered = renderTemplate(stripComments(content), vars);
      }
      return { segmentId: id, rendered };
    },
  );

  /**
   * PUT /api/prompt-injection/segment/:id/override
   * Save .local overlay file. Only allowed for allowLocalOverride: true segments.
   * Body: { content: string }
   * Backs up existing .local to .local.bak before overwriting.
   */
  app.put<{ Params: { id: string }; Body: { content: string } }>(
    '/api/prompt-injection/segment/:id/override',
    async (request, reply) => {
      const auth = requireOverlayWriteAuth(request);
      if (!auth.ok) {
        reply.status(auth.status);
        return { error: auth.error };
      }
      const { id } = request.params;
      const meta = resolveSegmentMeta(id);
      if (!meta) {
        reply.status(404);
        return { error: `Segment ${id} is not template-backed` };
      }
      if (!meta.allowLocalOverride) {
        reply.status(403);
        return { error: `Segment ${id} is readonly — override not allowed` };
      }

      const { content } = request.body ?? {};
      if (typeof content !== 'string' || content.trim().length === 0) {
        reply.status(400);
        return { error: 'Missing or empty content field' };
      }

      // Validate YAML segments parse to a string-valued mapping
      if (meta.ext === 'yaml') {
        const yamlErr = validateYamlStringMapping(content);
        if (yamlErr) {
          reply.status(400);
          return { error: yamlErr };
        }
      }

      const fileInfo = getTemplateFileInfo(id);
      if (!fileInfo) {
        reply.status(500);
        return { error: 'Template file info not found' };
      }

      const localPath = getTemplateOverlayPath(id);
      if (!localPath) {
        reply.status(500);
        return { error: 'Template overlay path not found' };
      }
      mkdirSync(dirname(localPath), { recursive: true });

      // Backup existing .local to .local.bak
      if (existsSync(localPath)) {
        const bakPath = `${localPath}.bak`;
        atomicCopyFileSync(localPath, bakPath);
      }

      atomicWriteFileSync(localPath, content);
      invalidateNativeL0CacheForSegment(id);

      return { segmentId: id, saved: true, path: fileInfo.local };
    },
  );

  /**
   * DELETE /api/prompt-injection/segment/:id/override
   * Remove .local overlay, reverting to default template.
   */
  app.delete<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/override', async (request, reply) => {
    const auth = requireOverlayWriteAuth(request);
    if (!auth.ok) {
      reply.status(auth.status);
      return { error: auth.error };
    }
    const { id } = request.params;
    const meta = resolveSegmentMeta(id);
    if (!meta) {
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }
    if (!meta.allowLocalOverride) {
      reply.status(403);
      return { error: `Segment ${id} is readonly` };
    }

    const fileInfo = getTemplateFileInfo(id);
    if (!fileInfo?.local) {
      return { segmentId: id, deleted: false, reason: 'No overlay path defined' };
    }

    const localPath = getTemplateOverlayPath(id);
    if (!localPath) {
      return { segmentId: id, deleted: false, reason: 'No overlay path defined' };
    }
    if (existsSync(localPath)) {
      unlinkSync(localPath);
      invalidateNativeL0CacheForSegment(id);
      return { segmentId: id, deleted: true };
    }
    return { segmentId: id, deleted: false, reason: 'No override file exists' };
  });

  /**
   * POST /api/prompt-injection/segment/:id/restore-backup
   * Restore .local from .local.bak (one-click rollback to previous version).
   */
  app.post<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/restore-backup', async (request, reply) => {
    const auth = requireOverlayWriteAuth(request);
    if (!auth.ok) {
      reply.status(auth.status);
      return { error: auth.error };
    }
    const { id } = request.params;
    const meta = resolveSegmentMeta(id);
    if (!meta) {
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }
    if (!meta.allowLocalOverride) {
      reply.status(403);
      return { error: `Segment ${id} is readonly` };
    }
    const fileInfo = getTemplateFileInfo(id);
    if (!fileInfo?.local) {
      reply.status(500);
      return { error: 'Template file info not found' };
    }
    const localPath = getTemplateOverlayPath(id);
    if (!localPath) {
      reply.status(500);
      return { error: 'Template overlay path not found' };
    }
    const bakPath = `${localPath}.bak`;
    if (!existsSync(bakPath)) {
      reply.status(404);
      return { error: 'No backup file exists' };
    }

    // Validate backup content before restoring (P2-7: same gate as save path)
    if (meta.ext === 'yaml') {
      const bakContent = readFileSync(bakPath, 'utf-8');
      const yamlErr = validateYamlStringMapping(bakContent);
      if (yamlErr) {
        reply.status(400);
        return { error: `Backup file is invalid — ${yamlErr}` };
      }
    }

    atomicCopyFileSync(bakPath, localPath);
    invalidateNativeL0CacheForSegment(id);
    return { segmentId: id, restored: true };
  });
};
