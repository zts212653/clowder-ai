import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { getRoster } from '../config/cat-config-loader.js';
import {
  requireConnectorWriteNetworkGuard,
  requireConnectorWriteOwner,
} from '../config/connector-secret-write-guards.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { getEvalCatOverride, setEvalCatOverride } from '../infrastructure/harness-eval/domain/eval-domain-override.js';
import { loadDomains, loadEvalHubSummary } from '../infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { ensureEvalDomainThreads } from '../infrastructure/harness-eval/hub/eval-hub-thread-ensure.js';
import {
  handleGenerateNow,
  handleTriggerNow,
  type InvokeTriggerProvider,
} from '../infrastructure/harness-eval/manual-trigger/index.js';

export type {
  GenerateNowInput,
  GenerateNowSuccess,
  HandlerError,
  InvokeTriggerLike,
  InvokeTriggerOutcome,
  InvokeTriggerProvider,
  ManualTriggerDeps,
  TriggerNowInput,
  TriggerNowSuccess,
} from '../infrastructure/harness-eval/manual-trigger/index.js';
// Re-export handler types so existing test imports from this file keep working
// (cloud codex R5 P1: handlers split out to manual-trigger/ to keep this file
// under the 350-line hard limit per AGENTS.md).
export {
  handleGenerateNow,
  handleTriggerNow,
} from '../infrastructure/harness-eval/manual-trigger/index.js';

export interface EvalHubRoutesOptions {
  harnessFeedbackRoot: string;
  threadStore?: IThreadStore;
  redis?: Redis;
  /** F192 OQ-21: late-bound invokeTrigger for manual eval wake. */
  invokeTriggerProvider?: InvokeTriggerProvider;
  /** F192 OQ-21: message store for delivering invocation packet on manual trigger. */
  messageStore?: IMessageStore;
}

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

export const evalHubRoutes: FastifyPluginAsync<EvalHubRoutesOptions> = async (app, opts) => {
  app.get('/api/eval-hub/summary', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    try {
      const summary = loadEvalHubSummary({ harnessFeedbackRoot: opts.harnessFeedbackRoot });

      // OQ-20: Apply Redis evalCat overrides to domain summaries
      if (opts.redis) {
        for (const domain of summary.domains) {
          const override = await getEvalCatOverride(opts.redis, domain.domainId);
          if (override) {
            domain.evalCatId = override.catId;
            domain.evalCatHandle = override.handle;
          }
        }
      }

      // F192 livefix: Ensure domain system threads exist for ALL registered domains,
      // not just those with verdicts. Best-effort: thread store failures must not
      // block the read-only summary response.
      if (opts.threadStore) {
        try {
          const allDomains = summary.domains.map((d) => ({
            domainId: d.domainId,
            systemThreadId: d.systemThreadId,
            displayName: d.displayName,
          }));
          await ensureEvalDomainThreads(opts.threadStore, allDomains, userId);
        } catch (threadErr) {
          request.log.warn({ err: threadErr }, 'eval-hub: thread ensure failed (best-effort, continuing)');
        }
      }

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Eval Hub summary unavailable', detail: message });
    }
  });

  // OQ-20: List available cats for the eval cat selector
  app.get('/api/eval-hub/available-cats', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    const roster = getRoster();
    const cats = Object.entries(roster)
      .filter(([, entry]) => entry.available !== false)
      .map(([catId, entry]) => ({ catId, handle: `@${catId}`, family: entry.family }));
    return { cats };
  });

  // OQ-20: Edit eval cat assignment per domain
  app.patch('/api/eval-domains/:domainId/eval-cat', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    if (!opts.redis) {
      return reply.status(503).send({ error: 'Redis not available for eval domain overrides' });
    }

    const { domainId } = request.params as { domainId: string };
    const body = request.body as { catId?: string } | null;
    if (!body?.catId) {
      return reply.status(400).send({ error: 'catId is required' });
    }

    const registeredDomains = loadDomains(opts.harnessFeedbackRoot);
    if (!registeredDomains.has(domainId as Parameters<typeof registeredDomains.has>[0])) {
      return reply.status(400).send({
        error: `Domain '${domainId}' not found in eval domain registry`,
      });
    }

    const roster = getRoster();
    const rosterEntry = roster[body.catId];
    if (!rosterEntry) {
      const available = Object.keys(roster).join(', ');
      return reply.status(400).send({
        error: `Cat '${body.catId}' not found in roster. Available: ${available}`,
      });
    }

    if (rosterEntry.available === false) {
      return reply.status(400).send({
        error: `Cat '${body.catId}' is not available (available=false in roster)`,
      });
    }

    const override = await setEvalCatOverride(opts.redis, domainId, {
      catId: body.catId,
      handle: `@${body.catId}`,
      model: rosterEntry.family,
    });

    return { ok: true, domainId, evalCat: override };
  });

  // F192 OQ-21: Manual eval trigger (true wake via late-bound invokeTrigger).
  // Replaces abandoned PR #2091. Handler in manual-trigger/trigger-now.ts.
  app.post('/api/eval-domains/:domainId/trigger-now', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    // Cloud codex R9 P1: trigger-now wakes eval cats — LLM cost + thread state
    // mutation. Without these guards, an exposed instance lets any remote
    // client spam cat invocations (DoS + cost attack). Mirror generate-now's
    // network + owner gate chain so both manual surfaces have symmetric
    // privilege requirements.
    const networkError = requireConnectorWriteNetworkGuard(request);
    if (networkError) {
      return reply.status(networkError.status).send({ error: networkError.error });
    }

    const ownerError = requireConnectorWriteOwner(userId);
    if (ownerError) {
      return reply.status(ownerError.status).send({ error: ownerError.error });
    }

    const { domainId } = request.params as { domainId: string };
    const result = await handleTriggerNow(
      {
        harnessFeedbackRoot: opts.harnessFeedbackRoot,
        invokeTriggerProvider: opts.invokeTriggerProvider,
        messageStore: opts.messageStore,
        threadStore: opts.threadStore,
        redis: opts.redis,
      },
      { domainId, userId },
    );

    if ('error' in result) {
      return reply.status(result.status).send({ error: result.error, detail: result.detail });
    }
    return result;
  });

  // F192 OQ-21: Manual generate-now (eval:a2a only in v1; others return 501).
  // Handler in manual-trigger/generate-now.ts.
  app.post('/api/eval-domains/:domainId/generate-now', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    // Cloud codex R8 P1 (network): single-user mode (no DEFAULT_OWNER_USER_ID)
    // makes requireConnectorWriteOwner() a no-op, and /api/session mints
    // default-user for any client. Without this guard, an exposed non-loopback
    // instance would let any remote client dirty docs/harness-feedback/.
    // Match push.ts / config-secrets.ts ordering: network guard first.
    const networkError = requireConnectorWriteNetworkGuard(request);
    if (networkError) {
      return reply.status(networkError.status).send({ error: networkError.error });
    }

    // Cloud codex R7 P1: this endpoint writes verdict + bundle files under
    // docs/harness-feedback/. GET /api/session mints a `default-user` session
    // without proving ownership — same as other repo-mutating surfaces
    // (push.ts, config-secrets.ts, connector-hub.ts), require owner privilege
    // before dirtying the working tree.
    const ownerError = requireConnectorWriteOwner(userId);
    if (ownerError) {
      return reply.status(ownerError.status).send({ error: ownerError.error });
    }

    const { domainId } = request.params as { domainId: string };
    // Cloud codex R4 P2: body is user-supplied JSON; validate field types at
    // route layer (defense in depth — handler also re-validates so direct test
    // calls remain protected).
    const body = (request.body ?? {}) as Record<string, unknown>;
    for (const field of ['verdictId', 'snapshotName', 'attributionName'] as const) {
      const v = body[field];
      if (v !== undefined && typeof v !== 'string') {
        return reply.status(400).send({
          error: `${field} must be a string if provided (got ${typeof v})`,
        });
      }
    }

    const result = await handleGenerateNow(
      { harnessFeedbackRoot: opts.harnessFeedbackRoot },
      {
        domainId,
        userId,
        verdictId: body.verdictId as string | undefined,
        snapshotName: body.snapshotName as string | undefined,
        attributionName: body.attributionName as string | undefined,
      },
    );

    if ('error' in result) {
      return reply.status(result.status).send({ error: result.error, detail: result.detail });
    }
    return result;
  });
};
