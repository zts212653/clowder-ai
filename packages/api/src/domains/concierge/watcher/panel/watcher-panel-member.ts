import {
  catRegistry,
  type SessionRecord,
  type TurnExecutionRecord,
  type WatcherPanelMemberEntry,
  type WatcherPanelRound,
} from '@cat-cafe/shared';
import { resolveByAccountRef } from '../../../../config/account-resolver.js';
import { captureCodexLaunchPolicy } from '../../../../config/codex-cli.js';
import { resolveActiveProjectRoot } from '../../../../utils/active-project-root.js';
import type { InvocationRegistry } from '../../../cats/services/agents/invocation/InvocationRegistry.js';
import { classifyResumeFailure } from '../../../cats/services/agents/invocation/invoke-helpers.js';
import { assertToolExecutionPolicySupported } from '../../../cats/services/agents/invocation/tool-execution-policy.js';
import { captureInvocationL0Input } from '../../../cats/services/agents/providers/l0-input-capture.js';
import { watcherPanelSessionChainKey } from '../../../cats/services/session/session-scope.js';
import type { TranscriptWriter } from '../../../cats/services/session/TranscriptWriter.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../../cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import type { AgentService } from '../../../cats/services/types.js';
import { watcherProviderLaunch } from '../watcher-authority.js';
import { watcherPanelContext } from './watcher-panel-context.js';
import { watcherPanelTerminalOutcome } from './watcher-panel-outcomes.js';
import { watcherPanelToolPolicy } from './watcher-panel-policy.js';
import { type WatcherPanelGuidance, watcherPanelPrompt } from './watcher-panel-prompt.js';

export interface WatcherPanelMemberOwners {
  registry: InvocationRegistry;
  executions: ITurnExecutionStore;
  sessions: ISessionChainStore;
  messages: IMessageStore;
  threads: IThreadStore;
  transcript: TranscriptWriter;
  apiUrl: string;
  service(catId: string): AgentService | undefined;
}

export interface WatcherPanelMemberInput {
  round: Pick<WatcherPanelRound, 'roundId' | 'userId' | 'threadId' | 'workerCatId' | 'quiet'> & { cutoffAt: number };
  source: TurnExecutionRecord;
  cutoff: StoredMessage;
  threadTitle?: string;
  catId: string;
  accountRef?: string;
  guidance: WatcherPanelGuidance;
  /** This member's last completed look at the thread (ledger) and the replies settled since then. */
  previous?: { cutoffAt: number; settledReplyIds: readonly string[]; sessionId: string };
  /** The callback principal exists; the nudge route can now find this member's ledger entry. */
  onAdmitted?(invocationId: string): void;
  signal: AbortSignal;
}

/** `quiet` means the turn finished; whether the member spoke is what the nudge route recorded meanwhile. */
export type WatcherPanelMemberResult = Pick<
  WatcherPanelMemberEntry,
  'invocationId' | 'sessionId' | 'failure' | 'actions' | 'context' | 'executionStatus'
> & { status: 'quiet' | 'failed' | 'interrupted' };

const fail = (failure: string, extra: Partial<WatcherPanelMemberResult> = {}): WatcherPanelMemberResult => ({
  ...extra,
  status: 'failed',
  failure: failure.slice(0, 500),
});

/** Proposals, desk deliveries and memory writes are counted from successful tool results, not self-report. */
const ACTION_TOOLS: Record<string, keyof NonNullable<WatcherPanelMemberEntry['actions']>> = {
  cat_cafe_offer_suggestion: 'proposed',
  cat_cafe_bring_to_desk: 'broughtToDesk',
  cat_cafe_remember: 'remembered',
};

function actionOf(toolName: string | undefined) {
  const name = toolName ? /cat_cafe_[a-z0-9_]+/u.exec(toolName)?.[0] : undefined;
  return name ? ACTION_TOOLS[name] : undefined;
}

export async function runWatcherPanelMember(
  owners: WatcherPanelMemberOwners,
  input: WatcherPanelMemberInput,
): Promise<WatcherPanelMemberResult> {
  const { round, source, catId } = input;
  const catConfig = catRegistry.tryGet(catId)?.config;
  if (!catConfig) return fail('watcher_panel_member_unsupported');
  const base = owners.service(catId);
  if (!base) return fail('watcher_panel_member_service_unavailable');
  const service = base.forInvocation?.() ?? base;
  if (service.watcherMemberCapability?.().supported !== true) return fail('watcher_panel_member_unsupported');
  let session: SessionRecord | undefined;
  let invocationId: string | undefined;
  let outcome: WatcherPanelMemberResult | undefined;
  try {
    const toolExecutionPolicy = watcherPanelToolPolicy();
    assertToolExecutionPolicySupported(service, toolExecutionPolicy);
    let accountSelection: { accountRef: string; authType: 'oauth' | 'api_key' } | undefined;
    if (input.accountRef) {
      const account = resolveByAccountRef(resolveActiveProjectRoot(process.cwd()), input.accountRef);
      if (!account) return fail(`watcher_panel_account_unavailable:${input.accountRef}`);
      accountSelection = { accountRef: input.accountRef, authType: account.authType };
    }
    session = await owners.sessions.getOrCreateActive({
      userId: round.userId,
      catId: catConfig.id,
      threadId: round.threadId,
      sessionPurpose: 'watcher',
      chainKey: watcherPanelSessionChainKey(round.userId, catId, round.threadId),
    });
    const resume = session.cliSessionId;
    const context = await watcherPanelContext({
      messages: owners.messages,
      userId: round.userId,
      threadId: round.threadId,
      cutoffAt: round.cutoffAt,
      ...(resume && input.previous?.sessionId === session.id
        ? { since: { at: input.previous.cutoffAt, settledReplyIds: input.previous.settledReplyIds } }
        : {}),
      signal: input.signal,
    });
    const contextFacts = {
      mode: context.mode,
      messageCount: context.messageCount,
      truncated: context.truncated,
      ...(context.firstMessageId ? { firstMessageId: context.firstMessageId } : {}),
    };
    const sourceAuth = await owners.registry.peekRecord(source.invocationId);
    // The read guard recognises observer reads by this exact parent, so a member's thread reads never
    // advance its own working delivery cursor or consume queued bodies addressed to it as a worker.
    const parentInvocationId = `watcher-panel:${round.roundId}:${catId}`;
    const auth = await owners.registry.create(
      round.userId,
      catConfig.id,
      round.threadId,
      parentInvocationId,
      undefined,
      toolExecutionPolicy,
      input.cutoff.id,
      sourceAuth?.ownerAuthProvenance ?? 'unknown',
    );
    invocationId = auth.invocationId;
    input.onAdmitted?.(invocationId);
    const created = await owners.executions.createRunning({
      invocationId,
      parentInvocationId,
      userId: round.userId,
      threadId: round.threadId,
      catId: catConfig.id,
      executionKind: 'watcher',
      outputFence: 'open',
      startedAt: Date.now(),
      providerLifecycleTracked: true,
      causal: {
        watcherSourceInvocationId: source.invocationId,
        watcherPanelRoundId: round.roundId,
        triggerMessageId: input.cutoff.id,
      },
    });
    if (created.outcome !== 'created') throw new Error('watcher_panel_execution_not_admitted');
    const scopeEnv: Record<string, string> = {
      CAT_CAFE_API_URL: owners.apiUrl,
      CAT_CAFE_EXECUTION_ID: parentInvocationId,
      CAT_CAFE_INVOCATION_ID: invocationId,
      CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
      CAT_CAFE_USER_ID: round.userId,
      CAT_CAFE_CAT_ID: catId,
      CAT_CAFE_THREAD_ID: round.threadId,
    };
    const { workspace, binding, callbackEnv, providerOptions } = await watcherProviderLaunch(
      owners.threads,
      catConfig.id,
      source,
      scopeEnv,
      input.signal,
      accountSelection,
      service,
    );
    const frozenL0Input = captureInvocationL0Input({ catId, catConfig, userId: round.userId });
    const prompt = watcherPanelPrompt({
      threadId: round.threadId,
      ...(input.threadTitle ? { threadTitle: input.threadTitle } : {}),
      workerCatId: round.workerCatId,
      cutoffMessageId: input.cutoff.id,
      cutoffAt: round.cutoffAt,
      context,
      ...(round.quiet ? { quiet: round.quiet } : {}),
      guidance: input.guidance,
    });
    await owners.executions.markProviderStarted(invocationId, Date.now());
    const actions = { proposed: 0, broughtToDesk: 0, remembered: 0 };
    const pending = new Map<string, keyof typeof actions>();
    for await (const message of service.invoke(prompt, {
      invocationId,
      hostSessionId: session.id,
      ...(resume ? { sessionId: resume } : {}),
      ...(resume && session.nativeSessionBinding ? { nativeSessionBinding: session.nativeSessionBinding } : {}),
      workingDirectory: workspace.workingDirectory,
      callbackEnv,
      frozenL0Input,
      accountEnv: binding.accountEnv,
      executionPreferences: binding.executionPreferences,
      ...providerOptions,
      ...(binding.resolvedAccount?.claude ? { claudeTokenAccount: true } : {}),
      ...(binding.resolvedAccount?.agy ? { agyAccount: binding.resolvedAccount.agy } : {}),
      toolExecutionPolicy,
      codexLaunchPolicy: { ...captureCodexLaunchPolicy(), sandboxMode: 'read-only', approvalPolicy: 'never' },
      ...(binding.codexAccountLaunch ? { codexAccountLaunch: binding.codexAccountLaunch } : {}),
      ...(binding.executionAccount ? { executionAccount: binding.executionAccount } : {}),
      signal: input.signal,
      auditContext: {
        invocationId,
        executionId: parentInvocationId,
        threadId: round.threadId,
        userId: round.userId,
        catId: catConfig.id,
      },
    })) {
      if (message.type === 'session_init' && message.sessionId && message.sessionId !== session.cliSessionId) {
        const bound = await owners.sessions.bindCliSessionIdIfUnbound(session.id, message.sessionId);
        if (!bound || bound.cliSessionId !== message.sessionId)
          throw new Error('watcher_panel_native_session_replaced');
        session = bound;
      }
      if (message.type === 'session_init' && message.nativeSessionBinding)
        session =
          (await owners.sessions.update(session.id, { nativeSessionBinding: message.nativeSessionBinding })) ?? session;
      await owners.transcript.appendDurableEvent(
        {
          sessionId: session.id,
          threadId: round.threadId,
          catId: session.catId,
          cliSessionId: session.cliSessionId,
          seq: session.seq,
        },
        message as unknown as Record<string, unknown>,
        invocationId,
      );
      if (message.type === 'error')
        throw new Error(message.error ?? message.content ?? 'watcher_panel_provider_failed');
      const action = message.type === 'tool_use' ? actionOf(message.toolName) : undefined;
      if (action && message.toolUseId) pending.set(message.toolUseId, action);
      if (message.type === 'tool_result' && message.toolUseId && message.toolResultStatus === 'ok') {
        const done = pending.get(message.toolUseId);
        if (done) actions[done]++;
        pending.delete(message.toolUseId);
      }
    }
    outcome = input.signal.aborted
      ? { status: 'interrupted', failure: 'watcher_panel_aborted', actions, context: contextFacts }
      : { status: 'quiet', actions, context: contextFacts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A vanished native history cannot be resumed; the next round starts this member fresh.
    if (session?.cliSessionId && classifyResumeFailure(message) === 'missing_session')
      await Promise.resolve(owners.sessions.update(session.id, { status: 'sealed' })).catch(() => undefined);
    outcome = input.signal.aborted ? { status: 'interrupted', failure: message.slice(0, 500) } : fail(message);
  } finally {
    if (invocationId) {
      const record = await settleWatcherPanelExecution(owners.executions, invocationId, outcome?.status);
      const terminal = record ? watcherPanelTerminalOutcome(record) : undefined;
      if (terminal)
        outcome = {
          ...outcome,
          ...terminal,
          ...(record?.status === 'failed' && outcome?.failure ? { failure: outcome.failure } : {}),
        };
    }
  }
  return {
    ...(outcome ?? fail('watcher_panel_missing_outcome')),
    ...(invocationId ? { invocationId } : {}),
    ...(session ? { sessionId: session.id } : {}),
  };
}

/** One terminal per member run; auth follows the canonical execution terminal. */
export async function settleWatcherPanelExecution(
  executions: ITurnExecutionStore,
  invocationId: string,
  status: WatcherPanelMemberResult['status'] | undefined,
): Promise<TurnExecutionRecord | undefined> {
  const now = Date.now();
  await Promise.resolve(executions.recordProviderTeardown(invocationId, now)).catch(() => undefined);
  const terminal = await executions.transitionTerminal(invocationId, {
    status: status === 'quiet' ? 'succeeded' : status === 'interrupted' ? 'canceled' : 'failed',
    endedAt: now,
    terminalReason: `watcher_panel_${status ?? 'failed'}`,
    providerTeardownAt: now,
  });
  if (terminal.record)
    await executions.markResponseSettled(
      invocationId,
      terminal.record.responseSettlement ?? { kind: 'no_response', reason: 'tool_only', settledAt: now },
    );
  return terminal.record ?? undefined;
}
