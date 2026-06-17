/**
 * Concierge API Routes (F229 PR-A1 + A3b + Phase B)
 *
 * GET  /api/concierge/config         — 获取当前用户的前台猫配置（不存在则返回默认值）
 * PUT  /api/concierge/config         — 覆盖写入用户的前台猫配置（TTL=0 持久化）
 * POST /api/concierge/thread         — 懒创建/获取 per-user concierge thread，返回 threadId
 * POST /api/concierge/relay          — 投递 relay 消息到目标 thread (§1a RelayReceipt)
 * POST /api/concierge/confirm        — 更新确认卡状态 (§1b PendingConfirmation)
 * GET  /api/concierge/peek           — 获取目标消息的前后上下文 (concierge_peek)
 * GET  /api/concierge/confirmations  — mount-time 批量查询确认状态 (Phase B §1)
 * POST /api/concierge/triage         — 创建 TriagePlan (Phase B §2)
 * POST /api/concierge/triage/:planId/confirm — 确认 TriagePlan (Phase B §2)
 * POST /api/concierge/triage/:planId/cancel  — 取消 TriagePlan (Phase B §2)
 */

import { randomUUID } from 'node:crypto';
import {
  type CatId,
  catIdSchema,
  type InvestigationJob,
  type PendingConfirmation,
  type TriagePlan,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isCatAvailable } from '../config/cat-config-loader.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IConciergeConfigStore } from '../domains/concierge/ConciergeConfigStore.js';
import type { IConciergeConfirmationStore } from '../domains/concierge/ConciergeConfirmationStore.js';
import type { IConciergeInvestigationJobStore } from '../domains/concierge/ConciergeInvestigationJobStore.js';
import { isJobExpired } from '../domains/concierge/ConciergeInvestigationJobStore.js';
import { executeInvestigation } from '../domains/concierge/ConciergeInvestigationWorker.js';
import type { IConciergeRelayStore } from '../domains/concierge/ConciergeRelayStore.js';
import type { ConciergeThreadService } from '../domains/concierge/ConciergeThreadService.js';
import type { IConciergeTriagePlanStore } from '../domains/concierge/ConciergeTriagePlanStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import { resolveStrictUserId, resolveUserId } from '../utils/request-identity.js';

const log = createModuleLogger('concierge-routes');

/**
 * Partial schema for PUT /api/concierge/config.
 * All fields optional (partial update semantics — merged with existing config).
 * TTL=0 contract: validated values only ever reach the store.
 */
const patchConciergeConfigSchema = z
  .object({
    enabled: z.boolean(),
    skin: z.enum(['yarn-ball', 'ragdoll-v1']),
    // No newlines/CR allowed: both fields are interpolated verbatim into the concierge
    // system prompt. Embedded newlines would inject prompt directives (P1 prompt injection).
    displayName: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[^\n\r]+$/, 'displayName must not contain newlines'),
    personaTone: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\n\r]+$/, 'personaTone must not contain newlines'),
    dutyCatProfileId: catIdSchema().refine((id) => isCatAvailable(id), {
      message: 'Duty cat is currently unavailable',
    }),
    proactivePolicy: z.enum(['ambient', 'quiet-badge']),
    muted: z.boolean(),
    /** PR-A3b: ball position persistence (INV-P3) */
    ballPosition: z.object({ x: z.number().finite(), y: z.number().finite() }).nullable(),
  })
  .partial()
  .strict();

/** Schema for POST /api/concierge/relay body (§1a + §1c INVs) */
const relaySchema = z.object({
  targetThreadId: z.string().min(1).max(100),
  targetCats: z.array(catIdSchema()).min(1),
  /** User's original text verbatim (INV-E1: must be non-empty) */
  originalText: z.string().min(1).max(100000),
  /** Source message ID in the concierge thread */
  sourceMessageId: z.string().min(1).max(100),
  /** Concierge thread ID (for routing credentials template) */
  conciergeThreadId: z.string().min(1).max(100),
});

/** Schema for POST /api/concierge/confirm body (§1b) */
const confirmSchema = z.object({
  confirmationId: z.string().min(1).max(100),
  status: z.enum(['confirmed', 'cancelled']),
});

/** Schema for GET /api/concierge/peek query (concierge_peek) */
const peekSchema = z.object({
  threadId: z.string().min(1).max(100),
  messageId: z.string().min(1).max(100),
  /** Number of messages before/after to show */
  windowSize: z.coerce.number().int().min(1).max(10).default(3),
});

/** Schema for POST /api/concierge/triage body (Phase B §2) */
const triageSchema = z.object({
  sourceMessageId: z.string().min(1).max(100),
  originalText: z.string().min(1).max(100000),
  intent: z.enum(['relay', 'go', 'propose_thread', 'investigate']),
  target: z
    .object({
      threadId: z.string().min(1).max(100).optional(),
      threadTitle: z.string().max(200).optional(),
      targetCats: z.array(z.string().min(1)).optional(),
      candidateCats: z.array(z.string().min(1)).optional(),
      query: z.string().max(10000).optional(),
    })
    .default({}),
});

/** Optional body for POST /api/concierge/triage/:planId/confirm */
const triageConfirmSchema = z
  .object({
    targetCats: z.array(catIdSchema()).min(1).optional(),
  })
  .default({});

interface ConciergeRoutesOptions {
  conciergeConfigStore: IConciergeConfigStore;
  conciergeThreadService: ConciergeThreadService;
  conciergeRelayStore: IConciergeRelayStore;
  conciergeConfirmationStore: IConciergeConfirmationStore;
  conciergeTriagePlanStore?: IConciergeTriagePlanStore;
  conciergeInvestigationJobStore?: IConciergeInvestigationJobStore;
  /** Evidence store for investigation search (optional — investigation degrades gracefully) */
  evidenceStore?: import('../domains/concierge/concierge-search-context.js').ConciergeEvidenceStore;
  messageStore: IMessageStore;
}

function validateTriageTarget(plan: TriagePlan): string | null {
  if (plan.intent === 'relay' && (!plan.target.threadId || !plan.target.targetCats?.length)) {
    return 'Invalid relay target: threadId and targetCats are required';
  }
  if (plan.intent === 'go' && !plan.target.threadId) return 'Invalid go target: threadId is required';
  if (plan.intent === 'propose_thread' && !plan.target.query) {
    return 'Invalid propose_thread target: query is required';
  }
  return null;
}

function validateSelectedTargetCats(plan: TriagePlan, selectedTargetCats: string[] | undefined): string | null {
  if (!selectedTargetCats?.length) return null;
  if (plan.intent !== 'relay') return 'targetCats selection is only valid for relay plans';
  // Uniquely-resolved plans (targetCats present, no candidateCats): server owns the target.
  // Any client-provided targetCats is a redundant echo — validation passes but the caller
  // MUST ignore the client value (use plan as-is). Without this, a client could rewrite
  // the relay target to any registered catId.
  if (!plan.target.candidateCats?.length) {
    if (plan.target.targetCats?.length) return null; // redundant echo, caller ignores
    return 'No candidate targetCats are available for this plan';
  }
  const allowed = new Set(plan.target.candidateCats);
  for (const catId of selectedTargetCats) {
    if (!allowed.has(catId)) return `Invalid selected target cat: ${catId}`;
  }
  return null;
}

function mapTriagePlanToConfirmation(plan: TriagePlan): PendingConfirmation | null {
  if (!plan.confirmationMessageId) return null;

  if (plan.status === 'cancelled') {
    return {
      id: `triage:${plan.id}:cancel`,
      userId: plan.userId,
      messageId: plan.confirmationMessageId,
      action: { kind: 'concierge_triage_cancel', planId: plan.id },
      status: 'cancelled',
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }
  if (plan.status !== 'confirmed' && plan.status !== 'dispatched' && plan.status !== 'completed') return null;

  return {
    id: `triage:${plan.id}:confirm`,
    userId: plan.userId,
    messageId: plan.confirmationMessageId,
    action: {
      kind: 'concierge_triage_confirm',
      planId: plan.id,
      intent: plan.intent,
      summary: plan.originalText || plan.target.threadTitle || plan.target.query || plan.intent,
      // P1-1 fix: include investigationJobId so frontend can restore report on refresh
      ...(plan.result?.investigationJobId ? { investigationJobId: plan.result.investigationJobId } : {}),
    },
    status: 'confirmed',
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

async function dispatchConfirmedTriagePlan(opts: {
  app: FastifyInstance;
  conciergeThreadService: ConciergeThreadService;
  conciergeTriagePlanStore: IConciergeTriagePlanStore;
  conciergeInvestigationJobStore?: IConciergeInvestigationJobStore;
  evidenceStore?: import('../domains/concierge/concierge-search-context.js').ConciergeEvidenceStore;
  plan: TriagePlan;
  planId: string;
  userId: string;
}): Promise<{ statusCode?: number; body: Record<string, unknown> }> {
  const {
    app,
    conciergeThreadService,
    conciergeTriagePlanStore,
    conciergeInvestigationJobStore,
    evidenceStore,
    plan,
    planId,
    userId,
  } = opts;
  if (plan.intent === 'go') {
    await conciergeTriagePlanStore.updateStatus(planId, 'completed');
    return { body: { planId, status: 'completed', threadId: plan.target.threadId } };
  }
  if (plan.intent === 'investigate') {
    try {
      return await dispatchInvestigateTriage({
        conciergeTriagePlanStore,
        conciergeInvestigationJobStore,
        evidenceStore,
        plan,
        planId,
        userId,
      });
    } catch (err) {
      log.error({ err, planId }, 'InvestigationJob dispatch failed');
      await conciergeTriagePlanStore.updateStatus(planId, 'failed');
      return { statusCode: 502, body: { error: 'Investigation dispatch failed' } };
    }
  }

  try {
    await conciergeTriagePlanStore.updateStatus(planId, 'dispatched');
    if (plan.intent === 'relay') {
      return await dispatchRelayTriage({ app, conciergeThreadService, conciergeTriagePlanStore, plan, planId, userId });
    }
    return await dispatchProposeThreadTriage({
      conciergeThreadService,
      conciergeTriagePlanStore,
      plan,
      planId,
      userId,
    });
  } catch (err) {
    log.error({ err, planId }, 'TriagePlan dispatch failed');
    await conciergeTriagePlanStore.updateStatus(planId, 'failed');
    return { statusCode: 502, body: { error: 'Triage dispatch failed' } };
  }
}

async function dispatchRelayTriage(opts: {
  app: FastifyInstance;
  conciergeThreadService: ConciergeThreadService;
  conciergeTriagePlanStore: IConciergeTriagePlanStore;
  plan: TriagePlan;
  planId: string;
  userId: string;
}): Promise<{ body: Record<string, unknown> }> {
  const { app, conciergeThreadService, conciergeTriagePlanStore, plan, planId, userId } = opts;
  const { threadId, targetCats } = plan.target;
  if (!threadId || !targetCats?.length) throw new Error('Invalid relay target');

  const conciergeThreadId = await conciergeThreadService.findThreadId(userId);
  if (!conciergeThreadId) throw new Error('Concierge thread not found');

  const relayResult = await app.inject({
    method: 'POST',
    url: '/api/concierge/relay',
    payload: {
      targetThreadId: threadId,
      targetCats,
      originalText: plan.originalText,
      sourceMessageId: plan.sourceMessageId,
      conciergeThreadId,
    },
    headers: {
      'x-cat-cafe-user': userId,
      'content-type': 'application/json',
    },
  });

  if (relayResult.statusCode >= 400) throw new Error(`Relay dispatch failed: HTTP ${relayResult.statusCode}`);

  const relayBody = JSON.parse(relayResult.body) as { receiptId?: string };
  await conciergeTriagePlanStore.setResult(planId, { relayReceiptId: relayBody.receiptId });
  await conciergeTriagePlanStore.updateStatus(planId, 'completed');
  return { body: { planId, status: 'completed', relayReceiptId: relayBody.receiptId } };
}

async function dispatchProposeThreadTriage(opts: {
  conciergeThreadService: ConciergeThreadService;
  conciergeTriagePlanStore: IConciergeTriagePlanStore;
  plan: TriagePlan;
  planId: string;
  userId: string;
}): Promise<{ body: Record<string, unknown> }> {
  const { conciergeThreadService, conciergeTriagePlanStore, plan, planId, userId } = opts;
  if (!plan.target.query) throw new Error('Invalid propose_thread target');
  const thread = await conciergeThreadService.createProposedThread(userId, plan.target.query);
  await conciergeTriagePlanStore.setResult(planId, { proposedThreadId: thread });
  await conciergeTriagePlanStore.updateStatus(planId, 'completed');
  return { body: { planId, status: 'completed', threadId: thread } };
}

/** Default investigation deadline: 60 seconds */
const INVESTIGATION_DEADLINE_MS = 60_000;

async function dispatchInvestigateTriage(opts: {
  conciergeTriagePlanStore: IConciergeTriagePlanStore;
  conciergeInvestigationJobStore?: IConciergeInvestigationJobStore;
  evidenceStore?: import('../domains/concierge/concierge-search-context.js').ConciergeEvidenceStore;
  plan: TriagePlan;
  planId: string;
  userId: string;
}): Promise<{ statusCode?: number; body: Record<string, unknown> }> {
  const { conciergeTriagePlanStore, conciergeInvestigationJobStore, evidenceStore, plan, planId, userId } = opts;
  if (!conciergeInvestigationJobStore) {
    // Graceful degradation: store not wired up yet → fall back to confirmed-only
    return { body: { planId, status: 'confirmed' } };
  }
  if (!plan.target.query) {
    await conciergeTriagePlanStore.updateStatus(planId, 'failed');
    return { statusCode: 422, body: { error: 'Invalid investigate target: query is required' } };
  }

  const now = Date.now();
  const job: InvestigationJob = {
    id: randomUUID(),
    userId,
    triagePlanId: planId,
    query: plan.target.query,
    scope: ['memory', 'docs', 'feat_index'],
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    deadline: now + INVESTIGATION_DEADLINE_MS,
  };

  await conciergeInvestigationJobStore.create(job);
  await conciergeTriagePlanStore.setResult(planId, { investigationJobId: job.id });
  await conciergeTriagePlanStore.updateStatus(planId, 'dispatched');

  // Fire-and-forget: kick off async investigation worker.
  // The worker handles its own error recovery (→ failed transition).
  // Client polls GET /investigation/:jobId for status + report.
  executeInvestigation({
    jobId: job.id,
    jobStore: conciergeInvestigationJobStore,
    evidenceStore,
    triagePlanStore: conciergeTriagePlanStore,
  }).catch((err) => log.error({ err, jobId: job.id }, 'Investigation worker uncaught error'));

  log.info({ planId, jobId: job.id, query: plan.target.query }, 'InvestigationJob created');
  return { body: { planId, status: 'dispatched', investigationJobId: job.id } };
}

export const conciergeRoutes: FastifyPluginAsync<ConciergeRoutesOptions> = async (app, opts) => {
  const {
    conciergeConfigStore,
    conciergeThreadService,
    conciergeRelayStore,
    conciergeConfirmationStore,
    conciergeTriagePlanStore,
    conciergeInvestigationJobStore,
    messageStore,
  } = opts;

  // GET /api/concierge/config — 获取用户前台猫配置
  app.get('/api/concierge/config', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const config = await conciergeConfigStore.get(userId);
    return { config };
  });

  // PUT /api/concierge/config — 覆盖写入用户前台猫配置（TTL=0 持久化，铁律 5 LL-048）
  app.put('/api/concierge/config', async (request, reply) => {
    // Mutations require strict identity: session cookie OR X-Cat-Cafe-User (non-browser).
    // Browser requests without a session return null → 401 (prevents overwriting TTL=0
    // config for 'default-user' via trusted-origin fallback).
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    // Schema-validated partial update — prevents bad values poisoning TTL=0 persistent config
    const parseResult = patchConciergeConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid config fields', details: parseResult.error.flatten().fieldErrors };
    }
    const patch = parseResult.data;
    // Merge with existing config (partial update semantics)
    const existing = await conciergeConfigStore.get(userId);
    const updated = { ...existing, ...patch };
    await conciergeConfigStore.put(userId, updated);
    // P2 cloud fix: sync thread.preferredCats immediately so duty-cat change takes effect
    // on the next @mention-free message without requiring a /api/concierge/thread roundtrip.
    // Fail-open: getOrCreate self-heals on next call if this races or throws.
    if (updated.dutyCatProfileId) {
      try {
        await conciergeThreadService.syncPreferredCats(userId, updated.dutyCatProfileId as CatId);
      } catch {
        // best-effort — routing stale at worst until next getOrCreate
      }
    }
    return { config: updated };
  });

  // POST /api/concierge/thread — 懒创建/获取 per-user concierge thread
  app.post('/api/concierge/thread', async (request, reply) => {
    // Mutations require strict identity (same as PUT above).
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const threadId = await conciergeThreadService.getOrCreate(userId);
    return { threadId };
  });

  // POST /api/concierge/relay — 投递 relay 消息到目标 thread (§1a RelayReceipt + §1c EscalationContext)
  //
  // INV R1: 先落记录再投递（store.write 先于 cross_post dispatch）
  // INV R2: dispatch_failed 手动重试（不自动重试）
  // INV R3: 同一 receipt 重试用同一 clientMessageId（幂等）
  // INV-E1: originalText 非空且 sourceMessageId 存在（schema 硬校验）
  // INV-E2: 投递内容 = 原文段 + anchor + routing credentials 模板（机器拼接）
  app.post('/api/concierge/relay', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parseResult = relaySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid relay payload', details: parseResult.error.flatten().fieldErrors };
    }
    const { targetThreadId, targetCats, originalText, sourceMessageId, conciergeThreadId } = parseResult.data;

    // Check for existing receipt for retry (INV R3: reuse clientMessageId)
    const receiptId = randomUUID();
    // Cloud P1 fix: idempotencyKey must be a valid UUID (messages.schema.ts:22).
    // `relay-${receiptId}` fails z.string().uuid() → every dispatch would 400.
    // Use receiptId directly — it's already a UUID from randomUUID().
    const clientMessageId = receiptId;
    const now = Date.now();

    const receipt = {
      id: receiptId,
      userId,
      conciergeThreadId,
      targetThreadId,
      targetCats,
      originalText,
      sourceMessageId,
      clientMessageId,
      status: 'confirmed' as const,
      createdAt: now,
      updatedAt: now,
    };

    // R1: 先落记录再投递 — crash window 内可恢复
    await conciergeRelayStore.create(receipt);

    try {
      // R3: use receipt's clientMessageId for idempotent dispatch
      // INV-E2: relay content = user original text + routing credentials template
      const relayContent = buildRelayContent(originalText, conciergeThreadId, targetCats);

      // Dispatch via internal POST /api/messages (reuses full routing pipeline)
      const injectResult = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: {
          content: relayContent,
          threadId: targetThreadId,
          mentions: targetCats,
          deliveryMode: 'immediate',
          idempotencyKey: clientMessageId,
        },
        headers: {
          'x-cat-cafe-user': userId,
          'content-type': 'application/json',
        },
      });

      if (injectResult.statusCode >= 400) {
        log.warn(
          { receiptId, targetThreadId, statusCode: injectResult.statusCode, body: injectResult.body },
          'Relay dispatch failed',
        );
        await conciergeRelayStore.updateStatus(receiptId, 'dispatch_failed');
        reply.status(502);
        return { error: 'Relay dispatch failed', receiptId, status: 'dispatch_failed' };
      }

      // Dispatch succeeded
      await conciergeRelayStore.updateStatus(receiptId, 'dispatched');
      log.info({ receiptId, targetThreadId, targetCats }, 'Relay dispatched successfully');

      return { receiptId, status: 'dispatched' };
    } catch (err) {
      log.error({ err, receiptId }, 'Relay dispatch threw');
      await conciergeRelayStore.updateStatus(receiptId, 'dispatch_failed');
      reply.status(502);
      return { error: 'Relay dispatch failed', receiptId, status: 'dispatch_failed' };
    }
  });

  // POST /api/concierge/relay/:receiptId/retry — 手动重试失败的 relay (INV R2)
  app.post<{ Params: { receiptId: string } }>('/api/concierge/relay/:receiptId/retry', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { receiptId } = request.params;
    const receipt = await conciergeRelayStore.get(receiptId);
    if (!receipt || receipt.userId !== userId) {
      reply.status(404);
      return { error: 'Receipt not found' };
    }
    if (receipt.status !== 'dispatch_failed') {
      reply.status(409);
      return { error: `Cannot retry receipt in status: ${receipt.status}` };
    }

    // R3: reuse original clientMessageId for idempotency
    await conciergeRelayStore.updateStatus(receiptId, 'confirmed');

    try {
      const relayContent = buildRelayContent(receipt.originalText, receipt.conciergeThreadId, receipt.targetCats);
      const injectResult = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: {
          content: relayContent,
          threadId: receipt.targetThreadId,
          mentions: receipt.targetCats,
          deliveryMode: 'immediate',
          idempotencyKey: receipt.clientMessageId,
        },
        headers: {
          'x-cat-cafe-user': userId,
          'content-type': 'application/json',
        },
      });

      if (injectResult.statusCode >= 400) {
        await conciergeRelayStore.updateStatus(receiptId, 'dispatch_failed');
        reply.status(502);
        return { error: 'Retry dispatch failed', receiptId, status: 'dispatch_failed' };
      }

      await conciergeRelayStore.updateStatus(receiptId, 'dispatched');
      return { receiptId, status: 'dispatched' };
    } catch (err) {
      log.error({ err, receiptId }, 'Retry dispatch threw');
      await conciergeRelayStore.updateStatus(receiptId, 'dispatch_failed');
      reply.status(502);
      return { error: 'Retry dispatch failed', receiptId, status: 'dispatch_failed' };
    }
  });

  // POST /api/concierge/confirm — 更新确认卡状态 (§1b)
  app.post('/api/concierge/confirm', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parseResult = confirmSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid confirm payload', details: parseResult.error.flatten().fieldErrors };
    }
    const { confirmationId, status } = parseResult.data;

    const confirmation = await conciergeConfirmationStore.get(confirmationId);
    if (!confirmation || confirmation.userId !== userId) {
      reply.status(404);
      return { error: 'Confirmation not found' };
    }
    // C1: only 'rendered' → 'confirmed' | 'cancelled' is valid
    if (confirmation.status !== 'rendered') {
      reply.status(409);
      return { error: `Cannot update confirmation in status: ${confirmation.status}` };
    }

    await conciergeConfirmationStore.updateStatus(confirmationId, status);
    return { confirmationId, status };
  });

  // GET /api/concierge/peek — 获取目标消息的前后上下文 (concierge_peek)
  app.get('/api/concierge/peek', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parseResult = peekSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid peek query', details: parseResult.error.flatten().fieldErrors };
    }
    const { threadId, messageId, windowSize } = parseResult.data;

    // Fetch messages around the target (scoped to requesting user — cloud review P1)
    const allMessages = await messageStore.getByThread(threadId, 200, userId);
    const targetIdx = allMessages.findIndex((m) => m.id === messageId);

    // Cloud R2-P2 + R3-P1 + R4-P1 fix: if target is beyond the 200-message window,
    // verify the user actually owns messages in this thread before falling back to
    // unscoped getById. getByThread includes isSystemUserMessage results (system/
    // scheduler messages visible to all), so allMessages.length > 0 alone does NOT
    // prove user ownership — a non-owning user could bypass via system-message presence.
    // Defense: require at least one message with matching userId (not just system msgs).
    if (targetIdx === -1) {
      const userOwnsThread = allMessages.some((m) => m.userId === userId);
      if (!userOwnsThread) {
        // User has no owned messages in this thread — block access.
        reply.status(404);
        return { error: 'Target message not found in thread' };
      }
      const targetMsg = await messageStore.getById(messageId);
      if (!targetMsg || targetMsg.threadId !== threadId) {
        reply.status(404);
        return { error: 'Target message not found in thread' };
      }
      // Target exists but is outside the recent window — return it as sole context
      return {
        window: [
          {
            id: targetMsg.id,
            content: targetMsg.content,
            catId: targetMsg.catId,
            userId: targetMsg.userId,
            timestamp: targetMsg.timestamp,
            isTarget: true,
          },
        ],
      };
    }

    const startIdx = Math.max(0, targetIdx - windowSize);
    const endIdx = Math.min(allMessages.length, targetIdx + windowSize + 1);
    const window = allMessages.slice(startIdx, endIdx).map((m) => ({
      id: m.id,
      content: m.content,
      catId: m.catId,
      userId: m.userId,
      timestamp: m.timestamp,
      isTarget: m.id === messageId,
    }));

    return { threadId, messageId, window };
  });

  // =========================================================================
  // Phase B routes (F229 Phase B: 总机能力)
  // =========================================================================

  // GET /api/concierge/confirmations — mount-time 批量查询确认状态
  // userId 从 session identity 解析（砚砚 P1: 不从 query 传）
  app.get('/api/concierge/confirmations', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const confirmations = await conciergeConfirmationStore.listByUser(userId);
    const triageConfirmations = conciergeTriagePlanStore
      ? (await conciergeTriagePlanStore.listByUser(userId)).map(mapTriagePlanToConfirmation).filter((entry) => entry)
      : [];
    confirmations.push(...(triageConfirmations as PendingConfirmation[]));
    confirmations.sort((a, b) => b.createdAt - a.createdAt);
    return { confirmations };
  });

  // POST /api/concierge/propose-thread — propose_thread action 的后端执行面 (Phase B §2b)
  // 前端 CardBlock concierge_propose_thread → 此 endpoint → 创建 thread 提议
  app.post('/api/concierge/propose-thread', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const bodySchema = z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(10000).default(''),
    });
    const parseResult = bodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid propose-thread payload', details: parseResult.error.flatten().fieldErrors };
    }
    const { title, description } = parseResult.data;

    // Create a new thread via the thread service
    // Phase B v1: simple thread creation, no propose_thread MCP (that's for cat-side proposals)
    const threadId = await conciergeThreadService.createProposedThread(userId, title, description);
    log.info({ threadId, title, userId }, 'Proposed thread created');

    return { threadId, title };
  });

  // POST /api/concierge/triage — 创建 TriagePlan（INV T1: 先落 proposed 再出确认卡）
  app.post('/api/concierge/triage', async (request, reply) => {
    if (!conciergeTriagePlanStore) {
      reply.status(501);
      return { error: 'Triage not available' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parseResult = triageSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid triage payload', details: parseResult.error.flatten().fieldErrors };
    }
    const { sourceMessageId, originalText, intent, target } = parseResult.data;

    const planId = randomUUID();
    const now = Date.now();
    const plan = {
      id: planId,
      userId,
      sourceMessageId,
      originalText,
      intent: intent as import('@cat-cafe/shared').TriagePlanIntent,
      target,
      status: 'proposed' as const,
      createdAt: now,
      updatedAt: now,
    };

    // T1: 先落记录再出确认卡
    await conciergeTriagePlanStore.create(plan);
    log.info({ planId, intent, userId }, 'TriagePlan created');

    return { planId, status: 'proposed' };
  });

  // POST /api/concierge/triage/:planId/confirm — 确认 TriagePlan（proposed → confirmed）
  app.post<{ Params: { planId: string } }>('/api/concierge/triage/:planId/confirm', async (request, reply) => {
    if (!conciergeTriagePlanStore) {
      reply.status(501);
      return { error: 'Triage not available' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { planId } = request.params;
    const plan = await conciergeTriagePlanStore.get(planId);
    if (!plan) {
      reply.status(404);
      return { error: 'Plan not found' };
    }
    if (plan.userId !== userId) {
      reply.status(403);
      return { error: 'Not your plan' };
    }
    // Fast-fail: reject plans in terminal/non-retryable states.
    // State machine allows: proposed → confirmed, failed → confirmed (retry).
    // The real race protection is claimTransition below.
    const confirmableStatuses = new Set(['proposed', 'failed']);
    if (!confirmableStatuses.has(plan.status)) {
      reply.status(409);
      return { error: `Cannot confirm plan in status: ${plan.status}` };
    }

    const selectionResult = triageConfirmSchema.safeParse(request.body ?? {});
    if (!selectionResult.success) {
      reply.status(400);
      return { error: 'Invalid triage confirmation payload', details: selectionResult.error.flatten().fieldErrors };
    }
    const selectedTargetCats = selectionResult.data.targetCats;
    const selectionError = validateSelectedTargetCats(plan, selectedTargetCats);
    if (selectionError) {
      reply.status(422);
      return { error: selectionError };
    }
    // Only apply client-selected targetCats when plan has candidateCats (ambiguous resolution).
    // For uniquely-resolved plans (targetCats present, no candidateCats), server owns the
    // target — ignore any client echo to prevent relay target rewrite attacks.
    const useClientSelection = selectedTargetCats?.length && plan.target.candidateCats?.length;
    const dispatchPlan = useClientSelection
      ? { ...plan, target: { ...plan.target, targetCats: selectedTargetCats } }
      : plan;

    const targetError = validateTriageTarget(dispatchPlan);
    if (targetError) {
      // Atomic claim: only the first request transitions to 'failed'.
      // Use plan.status as expected (supports both proposed and failed→retry paths).
      const claimedForFail = await conciergeTriagePlanStore.claimTransition(planId, plan.status, 'failed');
      if (!claimedForFail) {
        reply.status(409);
        return { error: 'Plan already processed by another request' };
      }
      reply.status(422);
      return { error: targetError };
    }

    // Atomic claim: current status → confirmed. Only the winner dispatches.
    // Supports both proposed → confirmed and failed → confirmed (retry).
    // Prevents double-dispatch on concurrent confirm clicks (cloud R1 P1 race fix).
    const claimed = await conciergeTriagePlanStore.claimTransition(planId, plan.status, 'confirmed');
    if (!claimed) {
      reply.status(409);
      return { error: 'Plan already confirmed or cancelled' };
    }
    log.info({ planId, intent: plan.intent }, 'TriagePlan confirmed');

    // Write selectedTargetCats AFTER claiming (cloud R2 P2 fix).
    // Before this fix, a losing concurrent request could overwrite targetCats
    // even though it would later get 409 from claimTransition.
    // Only persist client selection for ambiguous plans (with candidateCats).
    // Uniquely-resolved plans: server owns the target — ignore client echo.
    if (useClientSelection) {
      await conciergeTriagePlanStore.setTargetCats(planId, selectedTargetCats);
    }

    const result = await dispatchConfirmedTriagePlan({
      app,
      conciergeThreadService,
      conciergeTriagePlanStore,
      conciergeInvestigationJobStore,
      evidenceStore: opts.evidenceStore,
      plan: dispatchPlan,
      planId,
      userId,
    });
    if (result.statusCode) reply.status(result.statusCode);
    return result.body;
  });

  // POST /api/concierge/triage/:planId/cancel — 取消 TriagePlan（proposed → cancelled）
  app.post<{ Params: { planId: string } }>('/api/concierge/triage/:planId/cancel', async (request, reply) => {
    if (!conciergeTriagePlanStore) {
      reply.status(501);
      return { error: 'Triage not available' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { planId } = request.params;
    const plan = await conciergeTriagePlanStore.get(planId);
    if (!plan) {
      reply.status(404);
      return { error: 'Plan not found' };
    }
    if (plan.userId !== userId) {
      reply.status(403);
      return { error: 'Not your plan' };
    }
    // Fast-fail for obviously stale requests
    if (plan.status !== 'proposed') {
      reply.status(409);
      return { error: `Cannot cancel plan in status: ${plan.status}` };
    }

    // Atomic claim: proposed → cancelled (prevents race with concurrent confirm)
    const claimed = await conciergeTriagePlanStore.claimTransition(planId, 'proposed', 'cancelled');
    if (!claimed) {
      reply.status(409);
      return { error: 'Plan already confirmed or cancelled' };
    }
    log.info({ planId }, 'TriagePlan cancelled');

    return { planId, status: 'cancelled' };
  });

  // GET /api/concierge/investigation/:jobId — InvestigationJob 状态查询 (Phase B2)
  app.get<{ Params: { jobId: string } }>('/api/concierge/investigation/:jobId', async (request, reply) => {
    if (!conciergeInvestigationJobStore) {
      reply.status(501);
      return { error: 'Investigation not available' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { jobId } = request.params;
    const job = await conciergeInvestigationJobStore.get(jobId);
    if (!job) {
      reply.status(404);
      return { error: 'Investigation job not found' };
    }
    if (job.userId !== userId) {
      reply.status(403);
      return { error: 'Not your investigation job' };
    }

    // Deadline check: if job is past deadline and still active, auto-cancel (INV I3)
    if (isJobExpired(job)) {
      const cancelled = await conciergeInvestigationJobStore.claimTransition(job.id, job.status, 'cancelled');
      if (cancelled) {
        // Propagate cancellation to parent TriagePlan
        if (conciergeTriagePlanStore) {
          await conciergeTriagePlanStore.updateStatus(job.triagePlanId, 'cancelled');
        }
        log.info({ jobId: job.id }, 'InvestigationJob auto-cancelled (deadline expired)');
        const updated = await conciergeInvestigationJobStore.get(job.id);
        return { job: updated };
      }
    }

    return { job };
  });

  // POST /api/concierge/investigation/:jobId/cancel — 取消调查 (Phase B2)
  app.post<{ Params: { jobId: string } }>('/api/concierge/investigation/:jobId/cancel', async (request, reply) => {
    if (!conciergeInvestigationJobStore) {
      reply.status(501);
      return { error: 'Investigation not available' };
    }
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { jobId } = request.params;
    const job = await conciergeInvestigationJobStore.get(jobId);
    if (!job) {
      reply.status(404);
      return { error: 'Investigation job not found' };
    }
    if (job.userId !== userId) {
      reply.status(403);
      return { error: 'Not your investigation job' };
    }

    // Can only cancel active jobs (queued or running)
    if (job.status !== 'queued' && job.status !== 'running') {
      reply.status(409);
      return { error: `Cannot cancel investigation in status: ${job.status}` };
    }

    const claimed = await conciergeInvestigationJobStore.claimTransition(jobId, job.status, 'cancelled');
    if (!claimed) {
      reply.status(409);
      return { error: 'Investigation already completed or cancelled' };
    }
    // Propagate cancellation to parent TriagePlan
    if (conciergeTriagePlanStore) {
      await conciergeTriagePlanStore.updateStatus(job.triagePlanId, 'cancelled');
    }
    log.info({ jobId }, 'InvestigationJob cancelled by user');
    return { jobId, status: 'cancelled' };
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build relay content (INV-E2): original text + anchor list + routing credentials template.
 * Machine-assembled, model only produces anchor selection.
 */
function buildRelayContent(originalText: string, conciergeThreadId: string, targetCats: string[]): string {
  const targetHandles = targetCats.map((c) => `@${c}`).join(' ');
  // R-review P1 fix (R2): neutralize line-start @mentions in user text.
  // The a2a-mentions router strips markdown prefixes (> , - , * , 1. ) before
  // checking startsWith('@') — so `> @codex` still routes after prefix strip.
  // Fix: insert ZWNJ (‌) between `> ` and the line content. After the
  // router strips `> `, it sees `‌@codex` which does NOT startsWith('@'),
  // so routing is skipped. ZWNJ is zero-width — display is identical.
  const ZWNJ = '‌';
  const quotedText = originalText
    .split('\n')
    .map((line) => `> ${ZWNJ}${line}`)
    .join('\n');
  return [
    `${targetHandles}`,
    '',
    '---',
    '**前台猫转达的消息：**',
    '',
    quotedText,
    '',
    '---',
    `*完成后请回复到前台 thread (cross_post threadId: ${conciergeThreadId})*`,
  ].join('\n');
}
