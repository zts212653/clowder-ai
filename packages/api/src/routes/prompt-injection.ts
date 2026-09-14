/**
 * Prompt Injection Template Overlay API (F237 Checkpoint C)
 *
 * Read/preview surface for prompt injection templates. Legacy `.local`
 * mutations remain registered only to fail closed and direct callers to the
 * cycle-aware version lifecycle.
 *
 * GET  /api/prompt-injection/segment/:id/content — current effective content
 * POST /api/prompt-injection/segment/:id/preview — compile preview with vars
 * PUT/DELETE /api/prompt-injection/segment/:id/override — retired (409)
 */

import { existsSync } from 'node:fs';
import type { HookVariableDef, SafetyTier, SegmentEnablementMatrix } from '@cat-cafe/shared';
import { resolveSegmentEnablementMatrix } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import YAML from 'yaml';
import {
  requireCapabilityWriteOwner,
  requireLocalCapabilityWriteRequest,
} from '../config/capabilities/capability-write-guards.js';
import {
  getOverrideStatus,
  getTemplateFileInfo,
  getTemplateOverlayPath,
  renderTemplate,
  stripComments,
} from '../domains/cats/services/context/prompt-template-loader.js';
import { RICH_BLOCK_SHORT } from '../domains/cats/services/context/rich-block-rules.js';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import { resolveUserId } from '../utils/request-identity.js';
import { getHookManifest, getHookVariableDefs, readSegmentSource } from './prompt-injection-hooks.js';

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

const VERSIONED_EDITOR_REQUIRED = {
  code: 'versioned_editor_required',
  error: '段内容编辑已迁移到版本生命周期，请使用产生并应用新版本',
} as const;

/**
 * Validate that YAML content parses to a mapping of string values.
 * Returns an error message or null if valid.
 * Used by both save and restore-backup paths (P2 audit: same gate on all write paths).
 */
type RouteError = { status: number; error: string };

function isRouteError(result: unknown): result is RouteError {
  return typeof result === 'object' && result !== null && 'error' in result;
}

function renderPreview(
  id: string,
  content: string,
  meta: SegmentMeta,
): { status: number; rendered: string } | RouteError {
  if (typeof content !== 'string') {
    return { status: 400, error: 'Missing content field' };
  }

  if (meta.ext === 'yaml') {
    try {
      const parsed: unknown = YAML.parse(content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: 400, error: 'YAML must be a mapping (object), not a scalar or list' };
      }
      const entries: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        entries[k] = typeof v === 'string' ? v.trimEnd() : String(v);
      }
      return { status: 200, rendered: JSON.stringify(entries, null, 2) };
    } catch (e) {
      return { status: 400, error: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const vars = resolveVars(id);
  return { status: 200, rendered: renderTemplate(stripComments(content), vars) };
}

// ── Route options ────────────────────────────────────────────

export interface PromptInjectionRoutesOptions {
  /** Runtime override store. When absent, matrix uses default override state. */
  overrideStore?: HookOverrideStore;
}

// ── Segment metadata (TEMPLATE_FILES entries + hook-registry segments) ──

interface SegmentMeta {
  allowLocalOverride: boolean;
  ext: 'yaml' | 'md';
  templateRef: string;
  vars: string[];
  variableDefs: HookVariableDef[];
  safetyTier: SafetyTier;
  disableable: boolean;
}

/** Known runtime values for template variable preview rendering */
const KNOWN_PREVIEW_VARS: Record<string, string> = {
  RICH_BLOCK_SHORT: RICH_BLOCK_SHORT,
  CC_MENTION: '@co-creator',
};

/**
 * Derive segment meta for a Console segment. TEMPLATE_FILES entries keep their
 * overlay semantics; a segment known only to the shared hook registry (a
 * governance-added unit) derives everything from its manifest and template, so
 * content / preview / version validation work without a restart.
 */
function resolveSegmentMeta(id: string): SegmentMeta | null {
  const fileInfo = getTemplateFileInfo(id);
  // F257 Console 判据⑥: safety constraints come from the hook manifest so the
  // enablement matrix is authoritative; the registry is the reload-aware one.
  const manifest = getHookManifest(id);
  if (!fileInfo && !manifest) return null;
  const templateRef = fileInfo?.base ?? manifest?.template ?? '';
  const ext: 'yaml' | 'md' = templateRef.endsWith('.yaml') ? 'yaml' : 'md';
  const raw = readSegmentSource(id, false);
  const vars: string[] = [];
  if (raw) {
    for (const m of raw.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!vars.includes(m[1])) vars.push(m[1]);
    }
  }
  // Canonical variable definitions come from the hook manifest first, then
  // fall back to the TEMPLATE_FILES registry for non-hook template-backed segments.
  const variableDefs = getHookVariableDefs(id) ?? (fileInfo?.variables || []);
  return {
    allowLocalOverride: !!fileInfo?.local,
    ext,
    templateRef,
    vars,
    variableDefs,
    safetyTier: manifest?.safetyTier ?? 'readonly',
    disableable: manifest?.disableable ?? false,
  };
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

async function buildContentEnablementMatrix(
  segmentId: string,
  meta: SegmentMeta,
  hasLocalOverlay: boolean,
  hasBackup: boolean,
  overrideStore: HookOverrideStore | undefined,
): Promise<SegmentEnablementMatrix> {
  let enabled = true;
  let hasOverride = false;
  let hasContentOverride = false;
  let hasVersionSnapshot = false;
  const availableEpochVersions: number[] = [];

  if (overrideStore) {
    const override = await overrideStore.getOverride(segmentId);
    if (override) {
      enabled = override.enabled !== false;
      hasOverride = true;
      hasContentOverride = typeof override.contentOverride === 'string' && override.contentOverride.length > 0;
    }
    if (typeof overrideStore.listVersions === 'function') {
      const versions = await overrideStore.listVersions(segmentId);
      if (versions.length > 0) {
        hasVersionSnapshot = true;
        for (const v of versions) availableEpochVersions.push(v.version);
      }
    }
  }

  return resolveSegmentEnablementMatrix({
    segmentId,
    safetyTier: meta.safetyTier,
    allowLocalOverride: meta.allowLocalOverride,
    disableable: meta.disableable,
    localOverlay: { hasOverlay: hasLocalOverlay, hasBackup },
    runtimeOverride: {
      enabled,
      hasOverride,
      hasContentOverride,
      hasVersionSnapshot,
      availableEpochVersions,
    },
  });
}

// ── Route plugin ─────────────────────────────────────────────

export const promptInjectionRoutes: FastifyPluginAsync<PromptInjectionRoutesOptions> = async (app, opts) => {
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
    if (!meta) {
      reply.status(404);
      return { error: `Segment ${id} is not template-backed` };
    }

    const status = getOverrideStatus(id);
    const hasLocalOverlay = status?.hasOverride ?? false;
    const content = readSegmentSource(id, true);
    const baseContent = hasLocalOverlay ? readSegmentSource(id, false) : content;
    const overlayPath = getTemplateOverlayPath(id);
    const hasBackup = overlayPath ? existsSync(`${overlayPath}.bak`) : false;

    const enablementMatrix = await buildContentEnablementMatrix(
      id,
      meta,
      hasLocalOverlay,
      hasBackup,
      opts.overrideStore,
    );

    return {
      segmentId: id,
      allowLocalOverride: meta.allowLocalOverride,
      hasOverride: status?.hasOverride ?? false,
      hasBackup,
      content: content ?? '',
      baseContent: baseContent ?? '',
      templateRef: meta.templateRef,
      vars: meta.vars,
      variableDefs: meta.variableDefs,
      enablementMatrix,
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
      const preview = renderPreview(id, content, meta);
      reply.status(preview.status);
      return isRouteError(preview) ? { error: preview.error } : { segmentId: id, rendered: preview.rendered };
    },
  );

  /** Legacy mutation route retained as an authenticated fail-closed boundary. */
  app.put<{ Params: { id: string }; Body: { content: string } }>(
    '/api/prompt-injection/segment/:id/override',
    async (request, reply) => {
      const auth = requireOverlayWriteAuth(request);
      if (!auth.ok) {
        reply.status(auth.status);
        return { error: auth.error };
      }
      reply.status(409);
      return VERSIONED_EDITOR_REQUIRED;
    },
  );

  /** Legacy reset cannot bypass the version/cycle transition. */
  app.delete<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/override', async (request, reply) => {
    const auth = requireOverlayWriteAuth(request);
    if (!auth.ok) {
      reply.status(auth.status);
      return { error: auth.error };
    }
    reply.status(409);
    return VERSIONED_EDITOR_REQUIRED;
  });

  /** Legacy backup restore cannot bypass the version/cycle transition. */
  app.post<{ Params: { id: string } }>('/api/prompt-injection/segment/:id/restore-backup', async (request, reply) => {
    const auth = requireOverlayWriteAuth(request);
    if (!auth.ok) {
      reply.status(auth.status);
      return { error: auth.error };
    }
    reply.status(409);
    return VERSIONED_EDITOR_REQUIRED;
  });
};
