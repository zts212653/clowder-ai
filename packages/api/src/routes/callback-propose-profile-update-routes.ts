/**
 * F231 Phase C Task3: cat-side propose-profile-update callback route.
 *
 * POST /api/callbacks/propose-profile-update
 *   Cat-auth. Pins the current primer as beforeContent + baseContentHash (the P1-2 optimistic
 *   lock base — approve re-reads and compares before writing). Creates a ProfileUpdateProposal
 *   (status=pending) and appends the confirmation card; does NOT write the primer. Idempotent
 *   via clientRequestId.
 *
 * targetPath is DERIVED from the authenticated cat (`relationship/{catId}-primer.md`), never
 * user-supplied — so a malicious afterContent can't escape the profile dir. INV-6: AC-C1 only
 * writes the per-cat primer; capsule is rejected at the schema layer.
 *
 * The companion approve/reject endpoints are user-authenticated and live in
 * profile-update-decision-routes.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateProposalId, type ProfileUpdateProposal } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  hashContent,
  InvalidPrimerPathError,
  resolvePrimerPath,
} from '../domains/cats/services/profile/writeProfileUpdate.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { buildProfileUpdateCardBlock } from './profile-update-card-block.js';

// Mirror callback-propose-thread recovery: marker persistence can fail after the
// card is appended, and retries may arrive after heavy thread traffic. A wide
// scan keeps the idempotent self-heal path from returning phantom retryable 503s.
const SELF_HEAL_SCAN_LIMIT = 10000;

const proposeSchema = z.object({
  afterContent: z.string().min(1).max(20000),
  rationale: z.string().trim().min(1).max(1000),
  signalKind: z.enum(['cat-declared', 'cvo-instructed']),
  sourceMessageId: z.string().min(1).optional(),
  // INV-6: AC-C1 writes the per-cat primer only. `capsule` is not in the union → 400.
  targetLayer: z.literal('primer').optional(),
  clientRequestId: z.string().min(1).max(200).optional(),
});

export interface ProposeProfileUpdateDeps {
  registry: InvocationRegistry;
  proposalStore: IProfileUpdateProposalStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  profileDir: string;
}

export function registerCallbackProposeProfileUpdateRoutes(app: FastifyInstance, deps: ProposeProfileUpdateDeps): void {
  const { registry, proposalStore, messageStore, socketManager, profileDir } = deps;

  app.post('/api/callbacks/propose-profile-update', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = proposeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { afterContent, rationale, signalKind, sourceMessageId, clientRequestId } = parsed.data;
    const invocationId = record.invocationId;

    if (!(await registry.isLatest(invocationId))) {
      return { status: 'stale_ignored' };
    }

    // Idempotency fast path: only short-circuit when the prior proposal is fully visible.
    if (clientRequestId) {
      const cached = await proposalStore.getDedupProposalId(record.userId, clientRequestId);
      if (cached) {
        return visibleDedupResponse(proposalStore, messageStore, cached, reply);
      }
    }

    // targetPath is derived from the authenticated cat (per-cat primer) — never user-supplied.
    const targetPath = join('relationship', `${record.catId}-primer.md`);
    let fullPath: string;
    try {
      fullPath = resolvePrimerPath(profileDir, targetPath, record.catId);
    } catch (err) {
      reply.status(400);
      return { error: err instanceof InvalidPrimerPathError ? err.message : 'invalid primer path' };
    }
    // Pin the current primer state as the optimistic-lock base (P1-2).
    const beforeContent = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
    const baseContentHash = hashContent(beforeContent);

    // Reserve dedup BEFORE create so a concurrent retry's loser creates nothing.
    const proposalId = generateProposalId();
    let reservedDedup = false;
    if (clientRequestId) {
      const winningId = await proposalStore.reserveDedup(record.userId, clientRequestId, proposalId);
      if (winningId !== proposalId) {
        return visibleDedupResponse(proposalStore, messageStore, winningId, reply);
      }
      reservedDedup = true;
    }

    let proposal: ProfileUpdateProposal;
    try {
      proposal = await proposalStore.create({
        proposalId,
        sourceThreadId: record.threadId,
        sourceInvocationId: invocationId,
        sourceCatId: record.catId,
        targetLayer: 'primer',
        targetPath,
        beforeContent,
        baseContentHash,
        afterContent,
        rationale,
        signalProvenance: {
          kind: signalKind,
          sourceThreadId: record.threadId,
          ...(sourceMessageId ? { sourceMessageId } : {}),
        },
        createdBy: record.userId,
      });
    } catch (err) {
      if (reservedDedup && clientRequestId) {
        try {
          await proposalStore.releaseDedup(record.userId, clientRequestId, proposalId);
        } catch {
          // best-effort cleanup; surface the original error
        }
      }
      throw err;
    }

    // Append the confirmation card — the ONLY approval entry point. If this fails, delete the
    // proposal + release dedup so a retry can re-create a visible card (no phantom proposal).
    const cardBlock = buildProfileUpdateCardBlock(proposal);
    let stored: StoredMessage;
    try {
      stored = await messageStore.append({
        userId: record.userId,
        catId: record.catId,
        content: `提议更新 ${record.catId} 的关系档案（primer）`,
        mentions: [],
        timestamp: Date.now(),
        threadId: record.threadId,
        extra: { rich: { v: 1 as const, blocks: [cardBlock] } },
      });
    } catch (err) {
      try {
        await proposalStore.delete(proposal.proposalId);
      } catch {
        // best-effort cleanup
      }
      if (reservedDedup && clientRequestId) {
        try {
          await proposalStore.releaseDedup(record.userId, clientRequestId, proposal.proposalId);
        } catch {
          // best-effort cleanup
        }
      }
      throw err;
    }

    const warnings: string[] = [];
    try {
      await proposalStore.setCardMessageId(proposal.proposalId, stored.id);
    } catch (err) {
      warnings.push(`setCardMessageId failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    socketManager.broadcastToRoom(`thread:${record.threadId}`, 'connector_message', {
      threadId: record.threadId,
      message: {
        id: stored.id,
        type: 'cat',
        catId: record.catId,
        content: stored.content,
        timestamp: stored.timestamp,
        extra: stored.extra,
      },
    });
    socketManager.emitToUser(record.userId, 'profile_update_proposal_created', proposal);

    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: stored.id,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

async function visibleDedupResponse(
  proposalStore: IProfileUpdateProposalStore,
  messageStore: IMessageStore,
  proposalId: string,
  reply: FastifyReply,
): Promise<Record<string, unknown>> {
  const proposal = await proposalStore.get(proposalId);
  if (proposal?.cardMessageId) {
    return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
  }
  if (proposal && !proposal.cardMessageId) {
    const recoveredId = await findProfileUpdateCardMessage(messageStore, proposal.sourceThreadId, proposal.proposalId);
    if (recoveredId) {
      try {
        await proposalStore.setCardMessageId(proposal.proposalId, recoveredId);
      } catch {
        // Best-effort marker repair; the card is visible, so this request can still answer.
      }
      return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
    }
  }
  reply.status(503);
  reply.header('retry-after', '1');
  return {
    proposalId,
    error: proposal
      ? 'Profile update proposal in-flight (card not visible yet); retry shortly'
      : 'Profile update proposal reservation in-flight (card not visible yet); retry shortly',
    status: 'retryable',
    retryable: true,
  };
}

async function findProfileUpdateCardMessage(
  messageStore: IMessageStore,
  threadId: string,
  proposalId: string,
): Promise<string | null> {
  try {
    const messages = await messageStore.getByThread(threadId, SELF_HEAL_SCAN_LIMIT);
    const target = `profile-update-${proposalId}`;
    for (const msg of messages) {
      const blocks = msg.extra?.rich?.blocks ?? [];
      for (const block of blocks) {
        if (block.id === target) return msg.id;
      }
    }
  } catch {
    // Self-heal is best-effort; retryable 503 is safer than returning phantom success.
  }
  return null;
}
