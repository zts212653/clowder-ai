// F257: Approval-executor minimal surface — operator-gated hook override management.
// KD-14 审批执行器 first leg: the execute path for approved segment-patch trials
// (five-ring: candidate → operator approve → THIS ROUTE → behavior diff → verify).
//
// Auth mirrors trigger-now (eval-hub.ts): session + connector-write network/owner
// gates — mutating live prompt segments is privilege-equivalent to waking eval
// cats (cloud codex R9 P1 precedent). The store's own three-axis gates
// (safetyTier / disableable / unknown-hook) stay authoritative; this route only
// transports and maps OverrideGateError to HTTP.
//
// GET list doubles as the read API for the Phase D lifeline view (KD-19).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  requireConnectorWriteNetworkGuard,
  requireConnectorWriteOwner,
} from '../config/connector-secret-write-guards.js';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import { OverrideGateError } from '../domains/prompt-hooks/HookOverrideStore.js';
import {
  ManualVersionCycleError,
  ManualVersionCycleService,
} from '../infrastructure/harness-eval/evaluation/ManualVersionCycleService.js';
import type { ObjectiveEvaluationRuntime } from '../infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js';
import { validateCanonicalVersionContent } from './prompt-injection-version-content.js';

export interface PromptInjectionOverrideRoutesOptions {
  /** Undefined when redis is absent — routes answer 503 (observability infra off). */
  overrideStore: HookOverrideStore | undefined;
  /** Publish durable mutations into the synchronous prompt-pipeline snapshot before replying. */
  refreshOverrideSnapshot?: () => Promise<void>;
  /** Required for cycle-aware historical version activation. */
  runtime?: ObjectiveEvaluationRuntime;
  /** Test seam; production defaults to canonical template source validation. */
  validateVersionContent?: (hookId: string, content: string) => string | null;
}

const ACTIONS = ['enable', 'disable'] as const;
type OverrideAction = (typeof ACTIONS)[number];

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

/** Session + connector-write network/owner gates for the mutating surface. */
function requireWriteAuth(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = requireSession(request, reply);
  if (!userId) return null;
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status).send({ error: networkError.error });
    return null;
  }
  const ownerError = requireConnectorWriteOwner(userId);
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return null;
  }
  return userId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dispatch an approved action to the store — gates live in the store, not here. */
async function executeOverrideAction(
  store: HookOverrideStore,
  action: OverrideAction,
  hookId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const actionOpts = { source: 'operator' as const, reason };
  if (action === 'enable') return store.enable(hookId, userId, actionOpts);
  return store.disable(hookId, userId, actionOpts);
}

/**
 * Parse the untrusted request body. Non-record bodies and non-string fields
 * map to 400, never 500 (terra P2: this is an operator-facing trust boundary).
 */
function parseOverrideBody(raw: unknown): { action: OverrideAction; reason: string } | { error: string } {
  const body = isRecord(raw) ? raw : {};
  const action = body.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return { error: `action must be one of: ${ACTIONS.join(' | ')}` };
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return { error: 'reason is required (audit trail)' };
  }
  return { action: action as OverrideAction, reason };
}

function parseActivateBody(
  raw: unknown,
): { epochVersion: number; reason: string; origin?: 'manifest' | 'local' } | { error: string } {
  const body = isRecord(raw) ? raw : {};
  const epochVersion = typeof body.epochVersion === 'number' ? body.epochVersion : null;
  if (epochVersion === null || !Number.isSafeInteger(epochVersion) || epochVersion < 1) {
    return { error: 'epochVersion (positive integer) is required' };
  }
  // A shipped manifest version and a local epoch can carry the same number.
  // The caller that rendered the lifeline knows which row was chosen; without
  // this the store fails closed rather than guessing.
  if (body.origin !== undefined && body.origin !== 'manifest' && body.origin !== 'local') {
    return { error: "origin must be 'manifest' or 'local' when provided" };
  }
  const origin = body.origin as 'manifest' | 'local' | undefined;
  const suppliedReason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const reason = suppliedReason || `手动切换当前版本至 v${epochVersion}`;
  return { epochVersion, reason, ...(origin ? { origin } : {}) };
}

function parseContentBody(
  raw: unknown,
): { content: string; reason: string; baseVersion: number; expectedActiveVersion: number } | { error: string } {
  const body = isRecord(raw) ? raw : {};
  const content = typeof body.content === 'string' ? body.content : null;
  if (!content) return { error: 'content (string) is required' };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return { error: 'reason is required (audit trail)' };
  const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : null;
  if (baseVersion === null || !Number.isSafeInteger(baseVersion) || baseVersion < 1) {
    return { error: 'baseVersion (positive integer) is required' };
  }
  const expectedActiveVersion = typeof body.expectedActiveVersion === 'number' ? body.expectedActiveVersion : null;
  if (expectedActiveVersion === null || !Number.isSafeInteger(expectedActiveVersion) || expectedActiveVersion < 1) {
    return { error: 'expectedActiveVersion (positive integer) is required' };
  }
  return { content, reason, baseVersion, expectedActiveVersion };
}

function parseValidatedContentBody(
  raw: unknown,
  hookId: string,
  validate: (hookId: string, content: string) => string | null,
):
  | { content: string; reason: string; baseVersion: number; expectedActiveVersion: number }
  | { error: string; code: string } {
  const parsed = parseContentBody(raw);
  if ('error' in parsed) return { ...parsed, code: 'invalid_version_request' };
  const validationError = validate(hookId, parsed.content);
  return validationError ? { error: validationError, code: 'invalid_version_content' } : parsed;
}

function resolveVersionCreationDependencies(
  opts: PromptInjectionOverrideRoutesOptions,
  service: ManualVersionCycleService | null,
): { store: HookOverrideStore; service: ManualVersionCycleService } | { error: string } {
  if (!opts.overrideStore) return { error: 'override store unavailable (redis off)' };
  if (!service) return { error: 'Objective evaluation runtime unavailable' };
  return { store: opts.overrideStore, service };
}

/** Map store errors to HTTP status codes. Returns null if not a known gate error. */
function mapGateError(err: unknown, reply: FastifyReply): boolean {
  if (err instanceof OverrideGateError) {
    const status = err.gate === 'unknown-hook' ? 404 : 409;
    reply.status(status).send({ error: err.message, gate: err.gate, hookId: err.hookId });
    return true;
  }
  if (err instanceof Error && err.message.includes('No content snapshot')) {
    reply.status(404).send({ error: err.message });
    return true;
  }
  return false;
}

function mapManualSwitchError(err: unknown, reply: FastifyReply): boolean {
  if (!(err instanceof ManualVersionCycleError)) return false;
  const status = err.code === 'segment_not_found' || err.code === 'base_version_not_found' ? 404 : 409;
  const messages: Record<ManualVersionCycleError['code'], string> = {
    segment_not_found: 'Segment evaluation manifest entry not found',
    cycle_not_initialized: 'Objective evaluation cycle is not initialized',
    evaluation_in_progress: '当前正在评估，完成后可切换版本',
    version_already_active: '所选版本已经是当前版本',
    active_version_changed: '当前版本已变化，请重新载入后再编辑',
    base_version_not_found: '作为编辑基础的版本不存在',
    version_cycle_mismatch: '当前版本与评估周期不一致，请先检查运行状态',
    concurrent_transition: '评估已开始，请等待完成',
    compensation_failed: '版本切换未完整落地，自动恢复失败，请停止操作并检查运行状态',
  };
  reply.status(status).send({ error: messages[err.code], code: err.code });
  return true;
}

export const promptInjectionOverrideRoutes: FastifyPluginAsync<PromptInjectionOverrideRoutesOptions> = async (
  app,
  opts,
) => {
  const versionCycleService =
    opts.overrideStore && opts.runtime && opts.refreshOverrideSnapshot
      ? new ManualVersionCycleService({
          runtime: opts.runtime,
          overrideStore: opts.overrideStore,
          refreshOverrideSnapshot: opts.refreshOverrideSnapshot,
        })
      : null;
  // Read surface: current overrides (lifeline "治理" nodes come from here + event stream).
  app.get('/api/prompt-hooks/overrides', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;
    if (!opts.overrideStore) {
      return reply.status(503).send({ error: 'override store unavailable (redis off)' });
    }
    const overrides = await opts.overrideStore.listOverrides();
    return reply.send({ overrides });
  });

  // Write surface: execute an approved action. reason is REQUIRED — every
  // operator action must carry a why (audit trail feeds the lifeline view).
  app.post('/api/prompt-hooks/:hookId/override', async (request, reply) => {
    const userId = requireWriteAuth(request, reply);
    if (!userId) return;
    if (!opts.overrideStore) {
      return reply.status(503).send({ error: 'override store unavailable (redis off)' });
    }

    const { hookId } = request.params as { hookId: string };
    const parsed = parseOverrideBody(request.body);
    if ('error' in parsed) {
      return reply.status(400).send({ error: parsed.error });
    }

    const store = opts.overrideStore;
    try {
      await executeOverrideAction(store, parsed.action, hookId, userId, parsed.reason);
      await opts.refreshOverrideSnapshot?.();
      const override = await store.getOverride(hookId);
      return reply.send({ ok: true, hookId, action: parsed.action, override });
    } catch (err) {
      if (!mapGateError(err, reply)) throw err;
    }
  });

  // ── P1-3: Version management routes ──────────────────────────

  // List all version snapshots for a hook (epochVersion-keyed).
  app.get('/api/prompt-hooks/:hookId/versions', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;
    if (!opts.overrideStore) {
      return reply.status(503).send({ error: 'override store unavailable (redis off)' });
    }
    const { hookId } = request.params as { hookId: string };
    const versions = await opts.overrideStore.listVersions(hookId);
    return reply.send({ hookId, versions });
  });

  // Read one immutable full-content snapshot. The list endpoint intentionally
  // returns previews only; lifecycle version selection needs the exact body.
  app.get('/api/prompt-hooks/:hookId/versions/:epochVersion/content', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;
    if (!opts.overrideStore) {
      return reply.status(503).send({ error: 'override store unavailable (redis off)' });
    }
    const { hookId, epochVersion: rawEpochVersion } = request.params as {
      hookId: string;
      epochVersion: string;
    };
    const epochVersion = Number(rawEpochVersion);
    if (!Number.isInteger(epochVersion) || epochVersion < 1) {
      return reply.status(400).send({ error: 'epochVersion must be a positive integer' });
    }
    const content = await opts.overrideStore.getVersionContent(hookId, epochVersion);
    if (content === null) {
      return reply.status(404).send({ error: `No content snapshot for hook '${hookId}' epochVersion ${epochVersion}` });
    }
    return reply.send({ hookId, epochVersion, content });
  });

  // Activate a specific version by epochVersion.
  app.post('/api/prompt-hooks/:hookId/versions/activate', async (request, reply) => {
    const userId = requireWriteAuth(request, reply);
    if (!userId) return;
    if (!opts.overrideStore) {
      return reply.status(503).send({ error: 'override store unavailable (redis off)' });
    }
    if (!versionCycleService) {
      return reply.status(503).send({ error: 'Objective evaluation runtime unavailable' });
    }
    const { hookId } = request.params as { hookId: string };
    const parsed = parseActivateBody(request.body);
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error });

    try {
      const transition = await versionCycleService.switch({
        ownerUserId: userId,
        segmentId: hookId,
        targetVersion: parsed.epochVersion,
        actorId: userId,
        reason: parsed.reason,
        ...(parsed.origin ? { origin: parsed.origin } : {}),
      });
      const override = await opts.overrideStore.getOverride(hookId);
      return reply.send({ ok: true, hookId, epochVersion: parsed.epochVersion, override, transition });
    } catch (err) {
      if (!mapGateError(err, reply) && !mapManualSwitchError(err, reply)) throw err;
    }
  });

  // Create a new version (content override). Creates epochVersion snapshot.
  app.post('/api/prompt-hooks/:hookId/versions', async (request, reply) => {
    const userId = requireWriteAuth(request, reply);
    if (!userId) return;
    const dependencies = resolveVersionCreationDependencies(opts, versionCycleService);
    if ('error' in dependencies) return reply.status(503).send(dependencies);
    const { hookId } = request.params as { hookId: string };
    const parsed = parseValidatedContentBody(
      request.body,
      hookId,
      opts.validateVersionContent ?? validateCanonicalVersionContent,
    );
    if ('error' in parsed) return reply.status(400).send(parsed);

    try {
      const transition = await dependencies.service.create({
        ownerUserId: userId,
        segmentId: hookId,
        content: parsed.content,
        baseVersion: parsed.baseVersion,
        expectedActiveVersion: parsed.expectedActiveVersion,
        actorId: userId,
        reason: parsed.reason,
      });
      const versions = await dependencies.store.listVersions(hookId);
      const override = await dependencies.store.getOverride(hookId);
      return reply.send({ ok: true, hookId, override, versions, transition });
    } catch (err) {
      if (!mapGateError(err, reply) && !mapManualSwitchError(err, reply)) throw err;
    }
  });
};
