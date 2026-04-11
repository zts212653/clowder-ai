/**
 * F076: Intent Card routes — CRUD + triage + risk detection
 * Extracted from external-projects.ts to stay under 350-line limit.
 */
import type { IntentCard, RiskSignal } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ExternalProjectStore } from '../domains/projects/external-project-store.js';
import type { IntentCardStore } from '../domains/projects/intent-card-store.js';
import { detectRisks } from '../domains/projects/risk-detection-service.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface IntentCardRoutesOptions {
  externalProjectStore: ExternalProjectStore;
  intentCardStore: IntentCardStore;
}

export const intentCardRoutes: FastifyPluginAsync<IntentCardRoutesOptions> = async (app, opts) => {
  const { externalProjectStore, intentCardStore } = opts;

  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  function requireOwnedProject(id: string, userId: string, reply: FastifyReply) {
    const project = externalProjectStore.getById(id);
    if (!project || project.userId !== userId) {
      void reply.status(404).send({ error: 'Project not found' });
      return null;
    }
    return project;
  }

  function getCardForProject(projectId: string, cardId: string): IntentCard | null {
    const card = intentCardStore.getById(cardId);
    if (!card || card.projectId !== projectId) return null;
    return card;
  }

  // --- Intent Card CRUD ---

  app.post('/api/external-projects/:projectId/intent-cards', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const body = request.body as Record<string, unknown>;
    const card = intentCardStore.create({
      projectId,
      actor: (body.actor as string) ?? '',
      contextTrigger: (body.contextTrigger as string) ?? '',
      goal: (body.goal as string) ?? '',
      objectState: (body.objectState as string) ?? '',
      successSignal: (body.successSignal as string) ?? '',
      nonGoal: (body.nonGoal as string) ?? '',
      sourceTag: (body.sourceTag as 'Q' | 'O' | 'D' | 'R' | 'A') ?? 'A',
      sourceDetail: (body.sourceDetail as string) ?? '',
      decisionOwner: (body.decisionOwner as string) ?? '',
      confidence: (body.confidence as 1 | 2 | 3) ?? 1,
      dependencyTags: (body.dependencyTags as string[]) ?? [],
      riskSignals: (body.riskSignals as IntentCard['riskSignals']) ?? [],
      originalText: (body.originalText as string) ?? '',
    });
    return reply.status(201).send({ card });
  });

  app.get('/api/external-projects/:projectId/intent-cards', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;
    const query = request.query as { bucket?: string };
    const cards = intentCardStore.listByProject(
      projectId,
      query.bucket as 'build_now' | 'clarify_first' | 'validate_first' | 'challenge' | 'later' | undefined,
    );
    return reply.send({ cards });
  });

  app.get('/api/external-projects/:projectId/intent-cards/:cardId', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, cardId } = request.params as { projectId: string; cardId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;
    const card = getCardForProject(projectId, cardId);
    if (!card) return reply.status(404).send({ error: 'Intent card not found' });
    return reply.send({ card });
  });

  app.patch('/api/external-projects/:projectId/intent-cards/:cardId', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, cardId } = request.params as { projectId: string; cardId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;
    if (!getCardForProject(projectId, cardId)) return reply.status(404).send({ error: 'Intent card not found' });
    const body = request.body as Partial<
      Pick<
        IntentCard,
        | 'actor'
        | 'contextTrigger'
        | 'goal'
        | 'objectState'
        | 'successSignal'
        | 'nonGoal'
        | 'sourceTag'
        | 'sourceDetail'
        | 'decisionOwner'
        | 'confidence'
        | 'dependencyTags'
        | 'riskSignals'
        | 'originalText'
      >
    >;
    const card = intentCardStore.update(cardId, body);
    if (!card) return reply.status(404).send({ error: 'Intent card not found' });
    return reply.send({ card });
  });

  app.post('/api/external-projects/:projectId/intent-cards/:cardId/triage', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, cardId } = request.params as { projectId: string; cardId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;
    if (!getCardForProject(projectId, cardId)) return reply.status(404).send({ error: 'Intent card not found' });
    const body = request.body as Record<string, unknown>;
    const card = intentCardStore.triage(cardId, {
      clarity: (body.clarity as 1 | 2 | 3) ?? 1,
      groundedness: (body.groundedness as 1 | 2 | 3) ?? 1,
      necessity: (body.necessity as 1 | 2 | 3) ?? 1,
      coupling: (body.coupling as 1 | 2 | 3) ?? 1,
      sizeBand: (body.sizeBand as 'S' | 'M' | 'L' | 'XL') ?? 'M',
    });
    if (!card) return reply.status(404).send({ error: 'Intent card not found' });
    return reply.send({ card });
  });

  app.delete('/api/external-projects/:projectId/intent-cards/:cardId', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, cardId } = request.params as { projectId: string; cardId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;
    if (!getCardForProject(projectId, cardId)) return reply.status(404).send({ error: 'Intent card not found' });
    intentCardStore.delete(cardId);
    return reply.status(204).send();
  });

  // --- Risk Detection ---

  app.post('/api/external-projects/:projectId/intent-cards/:cardId/detect-risks', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId, cardId } = request.params as { projectId: string; cardId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;
    const card = getCardForProject(projectId, cardId);
    if (!card) return reply.status(404).send({ error: 'Intent card not found' });

    const risks = detectRisks(card);
    // Also update card.riskSignals with detected signal names
    const signals: RiskSignal[] = risks.map((r) => r.signal);
    intentCardStore.update(cardId, { riskSignals: signals });

    return reply.send({ risks });
  });

  app.get('/api/external-projects/:projectId/risk-summary', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!requireOwnedProject(projectId, userId, reply)) return;

    const cards = intentCardStore.listByProject(projectId);
    const signalCounts: Record<string, number> = {};
    let cardsWithRisks = 0;
    for (const card of cards) {
      const risks = detectRisks(card);
      if (risks.length > 0) cardsWithRisks++;
      for (const r of risks) {
        signalCounts[r.signal] = (signalCounts[r.signal] ?? 0) + 1;
      }
    }

    return reply.send({
      signals: signalCounts,
      totalCards: cards.length,
      cardsWithRisks,
    });
  });
};
