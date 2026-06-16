/**
 * Prompt Injection Template Overlay API (F226 Checkpoint C)
 *
 * Endpoints for reading, editing, previewing, and resetting
 * prompt injection template overlays (.local files).
 *
 * GET  /api/prompt-injection/segment/:id/content — current effective content
 * POST /api/prompt-injection/segment/:id/preview — compile preview with vars
 * PUT  /api/prompt-injection/segment/:id/override — save .local overlay
 * DELETE /api/prompt-injection/segment/:id/override — reset to default
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import YAML from 'yaml';
import {
  getOverrideStatus,
  getTemplateFileInfo,
  getTemplateRawContent,
  renderTemplate,
  stripComments,
  TEMPLATES_DIR,
} from '../domains/cats/services/context/prompt-template-loader.js';
import { RICH_BLOCK_SHORT } from '../domains/cats/services/context/rich-block-rules.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
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
function requireOverlayWriteAuth(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): string | null {
  const userId = resolveWriteUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  const ownerError = resolveOwnerGate(userId);
  if (ownerError) {
    reply.status(ownerError.status);
    return null;
  }
  return userId;
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
    const fileInfo = getTemplateFileInfo(id);
    const hasBackup = fileInfo ? existsSync(join(TEMPLATES_DIR, `${fileInfo.local}.bak`)) : false;

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
      if (!requireOverlayWriteAuth(request, reply)) {
        return { error: 'Authentication required for overlay writes' };
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

      const localPath = join(TEMPLATES_DIR, fileInfo.local);
      mkdirSync(dirname(localPath), { recursive: true });

      // Backup existing .local to .local.bak
      if (existsSync(localPath)) {
        const bakPath = `${localPath}.bak`;
        copyFileSync(localPath, bakPath);
      }

      writeFileSync(localPath, content, 'utf-8');

      return { segmentId: id, saved: true, path: fileInfo.local };
    },
  );

  /**
   * DELETE /api/prompt-injection/segment/:id/override
   * Remove .local overlay, reverting to default template.
   */
  app.delete<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/override', async (request, reply) => {
    if (!requireOverlayWriteAuth(request, reply)) {
      return { error: 'Authentication required for overlay writes' };
    }
    const { id } = request.params;
    const meta = resolveSegmentMeta(id);
    if (!meta) {
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }

    const fileInfo = getTemplateFileInfo(id);
    if (!fileInfo?.local) {
      return { segmentId: id, deleted: false, reason: 'No overlay path defined' };
    }

    const localPath = join(TEMPLATES_DIR, fileInfo.local);
    if (existsSync(localPath)) {
      unlinkSync(localPath);
      return { segmentId: id, deleted: true };
    }
    return { segmentId: id, deleted: false, reason: 'No override file exists' };
  });

  /**
   * POST /api/prompt-injection/segment/:id/restore-backup
   * Restore .local from .local.bak (one-click rollback to previous version).
   */
  app.post<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/restore-backup', async (request, reply) => {
    if (!requireOverlayWriteAuth(request, reply)) {
      return { error: 'Authentication required for overlay writes' };
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
    const bakPath = join(TEMPLATES_DIR, `${fileInfo.local}.bak`);
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

    const localPath = join(TEMPLATES_DIR, fileInfo.local);
    copyFileSync(bakPath, localPath);
    return { segmentId: id, restored: true };
  });
};
