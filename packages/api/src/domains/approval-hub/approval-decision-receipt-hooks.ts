import { APPROVAL_PRODUCER_IDS, approvalProducerMeta } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveUserId } from '../../utils/request-identity.js';
import type { ApprovalDecisionSubject } from './ApprovalDecisionReceiptOutbox.js';
import type { ApprovalDecisionReceiptService } from './ApprovalDecisionReceiptService.js';

/** Install before route registration; resolve the service after composition. */
export function installApprovalDecisionReceiptHooks(
  app: FastifyInstance,
  service: () => ApprovalDecisionReceiptService,
  recoveryIntervalMs = 60_000,
): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let recovery: Promise<boolean> | undefined;
  const subjects = new WeakMap<FastifyRequest, ApprovalDecisionSubject>();
  app.addHook('preHandler', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    // Match existing producer identity resolution without granting decision authority.
    // The producer route still owns authorization; the exact read checks ownership.
    const ownerUserId = resolveUserId(request);
    if (!ownerUserId) return;
    const subject = subjectForPath(request.url, ownerUserId);
    if (!subject) return;
    try {
      // Persist before the producer can commit. If this write is unavailable,
      // refuse this attempt instead of opening a commit-to-enqueue crash gap.
      service().prepare(subject);
      subjects.set(request, subject);
    } catch (error) {
      request.log.warn({ err: error, ...subject }, 'Approval receipt intent unavailable; decision not started');
      return reply.code(503).send({ error: 'approval_receipt_unavailable' });
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const subject = subjects.get(request);
    // Existing guards sometimes send errors before their async handler returns.
    // Do not suspend that send; reconcile committed error/retry cases below.
    if (subject && reply.statusCode < 400) {
      const complete = await service().deliver(subject);
      reply.header('x-approval-receipt-status', complete ? 'complete' : 'pending');
    }
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    const subject = subjects.get(request);
    if (subject && reply.statusCode >= 400) await service().deliver(subject);
  });
  app.addHook('onReady', async () => {
    await service().recover();
    timer = setInterval(() => {
      if (recovery) return;
      recovery = service()
        .recover()
        .finally(() => {
          recovery = undefined;
        });
    }, recoveryIntervalMs);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await recovery;
    await service().drain();
  });
}

function subjectForPath(url: string, ownerUserId: string): ApprovalDecisionSubject | undefined {
  const path = url.split('?')[0]!;
  for (const producerId of APPROVAL_PRODUCER_IDS) {
    const meta = approvalProducerMeta(producerId);
    const prefix = meta.decisionReceipt.routePrefix ?? meta.decisionEndpointBase;
    if (!prefix || !path.startsWith(`${prefix}/`)) continue;
    try {
      const id = decodeURIComponent(path.slice(prefix.length + 1).split('/')[0]!);
      if (id && id.length <= 200) return { ownerUserId, producerId, canonicalProposalId: id };
    } catch {
      /* The producer's own route validation rejects malformed paths. */
    }
  }
  return undefined;
}
