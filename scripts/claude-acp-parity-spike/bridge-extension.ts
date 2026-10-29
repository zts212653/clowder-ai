import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { PromptRequest } from '@agentclientprotocol/sdk/unstable';
import type { HookCallbackMatcher, HookEvent, HookJSONOutput, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

export const INPUT_METHOD = '_clowder/spike/v1/input';
export const HOOK_METHOD = '_clowder/spike/v1/hook';
export const TERMINAL_EVENT = '_clowder/spike/v1/inputTerminal';
export interface ProofPeer {
  extRequest?(method: string, params: Record<string, unknown>): Promise<unknown>;
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}
export function auditSpawn(options: SpawnOptions) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const file = process.env.CLOWDER_SPIKE_PROCESS_TRACE;
  const log = (entry: Record<string, unknown>) => {
    if (file)
      appendFileSync(
        file,
        `${JSON.stringify({ t: Date.now(), pid: child.pid, executable: options.command, ...entry })}\n`,
      );
  };
  log({ event: 'spawn' });
  child.on('exit', (code, signal) => log({ event: 'exit', code, signal }));
  return child;
}
const runs = new Map<string, string>();
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function proofMeta(meta: unknown): Record<string, unknown> | undefined {
  return record(meta) && record(meta.clowderParity) ? meta.clowderParity : undefined;
}
export function inputIdentity(params: { _meta?: unknown }): ReturnType<typeof randomUUID> {
  const inputId = proofMeta(params._meta)?.inputId;
  if (inputId === undefined) return randomUUID();
  if (typeof inputId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inputId))
    throw new Error('Invalid proof input UUID');
  return inputId as ReturnType<typeof randomUUID>;
}
export function proofHooks(
  client: ProofPeer,
  sessionId: string,
  meta: unknown,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const proof = proofMeta(meta);
  if (!proof || typeof proof.runKey !== 'string') return {};
  runs.set(sessionId, proof.runKey);
  const callback: HookCallbackMatcher['hooks'][number] = async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'SessionStart' && input.source !== 'compact') return {};
    if (!client.extRequest) throw new Error('Bidirectional proof peer is required');
    try {
      const response = await client.extRequest(HOOK_METHOD, {
        sessionId,
        runKey: proof.runKey,
        hookCallId: randomUUID(),
        input,
      });
      if (!record(response)) throw new Error('Invalid hook response');
      if (input.hook_event_name === 'SessionStart' && typeof response.additionalContext === 'string') {
        return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: response.additionalContext } };
      }
      return {};
    } catch (error) {
      // Match the current Host callback: preserve failure as unproven and return {}.
      await client.extNotification('_clowder/spike/v1/hookFailure', {
        sessionId,
        hook: input.hook_event_name,
        message: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  };
  return { PreCompact: [{ hooks: [callback] }], SessionStart: [{ hooks: [callback] }] };
}
interface AgentForProof {
  sessions: Record<
    string,
    {
      queryClosed?: boolean;
      query: { interrupt(): Promise<unknown> };
      turnQueue?: Array<{ settled: boolean }>;
      sentUserUuids?: Set<string>;
    }
  >;
  startTurn(
    params: PromptRequest,
    events: {
      inserted(messageId: string): void;
      ended(outcome: unknown): void;
      failed(error: unknown): void;
    },
  ): Promise<void>;
}
export async function proofInput(agent: AgentForProof, peer: ProofPeer, raw: unknown) {
  if (
    !record(raw) ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.runKey !== 'string' ||
    !['append', 'steer'].includes(String(raw.mode)) ||
    !Array.isArray(raw.prompt)
  )
    throw new Error('Invalid proof input');
  const session = agent.sessions[raw.sessionId];
  if (!session || session.queryClosed || runs.get(raw.sessionId) !== raw.runKey) throw new Error('Stale proof binding');
  const params: PromptRequest = {
    sessionId: raw.sessionId,
    prompt: raw.prompt as PromptRequest['prompt'],
    _meta: { clowderParity: { inputId: raw.inputId } },
  };
  const inputId = inputIdentity(params);
  if (session.sentUserUuids?.has(inputId)) throw new Error('Duplicate proof input');
  if (raw.mode === 'steer') {
    if (!session.turnQueue?.some((turn) => !turn.settled)) throw new Error('No active proof turn');
    await session.query.interrupt();
  }
  await agent.startTurn(params, {
    inserted() {},
    ended(outcome) {
      void peer.extNotification(TERMINAL_EVENT, { inputId, outcome });
    },
    failed(error) {
      void peer.extNotification(TERMINAL_EVENT, { inputId, error: String(error) });
    },
  });
  return { accepted: true, inputId };
}
