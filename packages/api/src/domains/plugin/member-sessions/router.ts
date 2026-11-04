import { createCatId } from '@cat-cafe/shared';
import { type InvocationDeps, invokeSingleCat } from '../../cats/services/agents/invocation/invoke-single-cat.js';
import { toStoredToolEvent } from '../../cats/services/agents/routing/route-helpers.js';
import {
  createScopedMemberRouting,
  type ScopedMemberRouteInput,
} from '../../cats/services/agents/routing/scoped-member-routing.js';
import {
  commitLifecycleResponseFromAppendInput,
  type StoredToolEvent,
} from '../../cats/services/stores/ports/MessageStore.js';
import type { AgentMessage, ToolExecutionPolicy } from '../../cats/services/types.js';
import type { MemberCallbackIdentity } from './callback.js';
import type { MemberRuntimeFrame } from './runtime.js';
import type { createPluginMemberSessions } from './service.js';
import type { MemberSessionStore } from './store.js';
import type {
  MemberExecutionClaim,
  MemberSessionExecution,
  MemberSessionRecord,
  MemberSessionScope,
  MemberSessionServices,
  MemberThreadBinding,
} from './types.js';
import { digest, memberExecutionKey } from './validation.js';

export interface MemberRouterServices {
  readonly sessions: ReturnType<typeof createPluginMemberSessions>;
  readonly store: MemberSessionStore;
  /** The scope captured by the original execute admission, never today's activation. */
  executionScope(row: MemberSessionRecord, run: MemberSessionExecution): MemberSessionScope;
  executionSignal?(row: MemberSessionRecord, run: MemberSessionExecution): AbortSignal;
  acquire(row: MemberSessionRecord, scope: MemberSessionScope): Promise<MemberRuntimeFrame>;
  readonly memory: MemberSessionServices['resolveMemory'];
  readonly messaging: MemberSessionServices['messaging'];
  native(
    policy: ToolExecutionPolicy,
  ): Promise<NonNullable<import('../../cats/services/types.js').AgentServiceOptions['pluginNativeLaunch']>['server']>;
  invocationDeps(): InvocationDeps;
  registerCallback(claim: MemberExecutionClaim, assert: (caller: MemberCallbackIdentity) => Promise<void>): () => void;
  finishExecution?(claim: MemberExecutionClaim): void;
}

/** A protected route invokes the existing child kernel and commits its canonical
 * response. It does not load ordinary home context or route output mentions. */
export function createMemberSessionRouter(deps: MemberRouterServices) {
  async function* invoke(input: ScopedMemberRouteInput, binding: MemberThreadBinding): AsyncGenerator<AgentMessage> {
    const row = (await deps.store.get(binding.sessionId))?.value;
    if (
      !row ||
      row.threadId !== input.threadId ||
      row.ownerUserId !== input.userId ||
      row.catId !== binding.catId ||
      row.pluginInstanceId !== binding.pluginInstanceId
    )
      throw new Error('member_route_binding_changed');
    const pending = Object.values(row.executions).filter((run) =>
      ['admitting', 'queued', 'running'].includes(run.phase),
    );
    if (pending.length !== 1) throw new Error('member_route_original_execution_unavailable');
    const run = pending[0];
    if (run.phase === 'running' || run.invocationId) throw new Error('member_route_original_child_unsettled');
    const scope = deps.executionScope(row, run);
    const admissionSignal = deps.executionSignal?.(row, run);
    const memberSignal = input.options.signalForCat?.(createCatId(row.catId)) ?? input.options.signal;
    const signal =
      admissionSignal && memberSignal
        ? AbortSignal.any([admissionSignal, memberSignal])
        : (admissionSignal ?? memberSignal);
    const grant = deps.sessions.hostGrantForInstance(scope);
    const executions = deps.sessions.hostExecutionsForInstance(scope);
    let claim: MemberExecutionClaim | undefined,
      claimed = false;
    const assertCurrent = async () => {
      await grant(row.sessionId, row.generation);
      if (claimed && claim) await executions.assertCurrent(claim);
    };
    await assertCurrent();
    const original = await deps.messaging.findSent(
      {
        threadId: row.threadId,
        idempotencyKey: memberExecutionKey({ ...run, sessionId: row.sessionId, generation: row.generation }),
      },
      scope,
    );
    if (
      !original ||
      original.messageId !== input.sourceMessageId ||
      original.threadId !== row.threadId ||
      original.content !== run.content ||
      original.deliveryStatus === 'canceled' ||
      original.routedCatIds.length !== 1 ||
      original.routedCatIds[0] !== row.catId
    )
      throw new Error('member_route_original_source_mismatch');
    await assertCurrent();
    const frame = await deps.acquire(row, scope);
    let removeCallback: (() => void) | undefined;
    const messages = deps.invocationDeps().messageStore,
      turns = deps.invocationDeps().turnExecutionStore;
    try {
      if (!messages || !turns || !input.options.onLifecycleInvocationStarted)
        throw new Error('member_route_canonical_lifecycle_unavailable');
      if (digest(frame.runtime) !== digest(row.runtime)) throw new Error('member_session_runtime_changed');
      const policy: ToolExecutionPolicy = {
        mode: 'plugin_native',
        pluginInstanceId: row.pluginInstanceId,
        contributionId: row.contributionId,
        memberSession: { sessionId: row.sessionId, generation: row.generation, executionId: run.executionId },
      };
      const server = await deps.native(policy);
      const memory = [];
      for (const ref of row.memory) {
        const resolved = await deps.memory(ref, { ...scope, catId: row.catId });
        memory.push(`[Approved personal memory ${ref.sourceRef} revision ${ref.revision}]\n${resolved.text}`);
      }
      const prompt = [...memory, `[Current local game event]\n${run.content}`].join('\n\n');
      await assertCurrent();
      const tools: StoredToolEvent[] = [];
      let content = '';
      try {
        for await (const event of invokeSingleCat(deps.invocationDeps(), {
          catId: createCatId(row.catId),
          service: frame.service,
          executionBinding: frame.binding,
          userId: row.ownerUserId,
          threadId: row.threadId,
          prompt,
          isLastCat: true,
          ownerAuthProvenance: input.options.ownerAuthProvenance ?? 'unknown',
          parentInvocationId: input.options.parentInvocationId,
          routeSpan: input.options.routeSpan,
          onAgentClientActiveRunReady: input.options.onAgentClientActiveRunReady,
          ...(input.options.stopMember
            ? {
                onMemberTimeout: (timeout) => {
                  input.options.stopMember!(row.catId, timeout.executionId);
                },
              }
            : {}),
          signal,
          toolExecutionPolicy: policy,
          scopedMemberLaunch: {
            server,
            sandbox: { kind: 'scoped-member', workspaceRoot: frame.binding.workspace.workingDirectory! },
            assertCurrent,
          },
          executionKind: 'ordinary',
          executionCausal: { triggerMessageId: original.messageId, coveredMessageIds: [original.messageId] },
          promptMessageIds: [original.messageId],
          onPromptMessagesExposed: input.options.onPromptMessagesExposed,
          onLifecycleInvocationStarted: async (child) => {
            const response = await input.options.onLifecycleInvocationStarted!(child);
            claim = {
              sessionId: row.sessionId,
              generation: row.generation,
              executionId: run.executionId,
              invocationId: child.invocationId,
              responseMessageId: response.responseMessageId,
            };
            await executions.claim(claim);
            claimed = true;
            removeCallback = deps.registerCallback(claim, deps.sessions.hostCallbackForInstance(scope));
            return response;
          },
        })) {
          if (event.type === 'text') content += event.content ?? '';
          const tool = toStoredToolEvent(event, claim?.invocationId);
          if (tool) tools.push(tool);
          yield { ...event, ...(claim ? { turnInvocationId: claim.invocationId } : {}) };
        }
      } finally {
        if (claim) {
          const turn = await turns.get(claim.invocationId);
          if (turn && turn.status !== 'running') {
            await commitLifecycleResponseFromAppendInput(
              messages,
              claim.responseMessageId,
              claim.invocationId,
              {
                status: turn.status === 'succeeded' ? 'completed' : turn.status,
                completedAt: turn.endedAt ?? Date.now(),
                reason: turn.terminalReason,
                expectedInputMessageIds: [original.messageId],
              },
              {
                userId: row.ownerUserId,
                threadId: row.threadId,
                from: { kind: 'agent', catId: createCatId(row.catId) },
                content,
                mentions: [],
                timestamp: turn.endedAt ?? Date.now(),
                toolEvents: tools,
                replyTo: original.messageId,
                extra: { stream: { invocationId: claim.invocationId, turnInvocationId: claim.invocationId } },
              },
            );
            await executions.settle(claim);
          }
        }
      }
    } finally {
      if (claim) deps.finishExecution?.(claim);
      removeCallback?.();
      await frame.release();
    }
  }
  return createScopedMemberRouting({ binding: (threadId) => deps.sessions.hostThreadBinding(threadId), invoke });
}
