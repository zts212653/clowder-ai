/**
 * A2A Agent Service — F050 Phase 3
 *
 * Implements AgentService for remote agents speaking the A2A protocol.
 * Uses tasks/send (JSON-RPC 2.0 over HTTPS) for synchronous invocation.
 *
 * Phase 3 scope: tasks/send only. Streaming (tasks/sendSubscribe) is Phase 4.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { A2AAgentConfig, CatId } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import { runA2ATurn } from '@clowder-ai/agent-access/runtime/a2a-turn';
import { type AgentAccessA2ARunner, buildAgentAccessA2ARequest } from '@clowder-ai/agent-contract';
import type { AgentMessage, AgentService, AgentServiceOptions, PreparedProviderRequestV1 } from '../../types.js';

export interface A2AAgentServiceOptions {
  catId?: CatId;
  config: A2AAgentConfig;
  /** Inject custom fetch for testing */
  fetchFn?: typeof fetch;
  runTurn?: AgentAccessA2ARunner;
}

function agentMsg(type: AgentMessage['type'], catId: CatId, content?: string): AgentMessage {
  return { type, catId, content, ...(type === 'error' ? { error: content } : {}), timestamp: Date.now() };
}

export class A2AAgentService implements AgentService {
  contextCapability(): import('../../types.js').AgentContextCapability {
    return {
      provider: 'a2a',
      carrier: 'a2a',
      reportsRuntimeWindow: false,
      authoritativeUsage: false,
      usageTelemetry: 'unavailable',
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: false,
      reason: 'A2A does not expose the remote agent context state',
    };
  }
  private readonly catId: CatId;
  private readonly config: A2AAgentConfig;
  private readonly fetchFn: typeof fetch;
  private readonly runTurn: AgentAccessA2ARunner;

  constructor(options: A2AAgentServiceOptions) {
    this.catId = options.catId ?? createCatId('a2a-agent');
    this.config = options.config;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.runTurn = options.runTurn ?? runA2ATurn;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const taskId = randomUUID();

    const preparedRequest: PreparedProviderRequestV1 = Object.freeze({
      v: 1,
      message: Object.freeze({ body: prompt }),
      nativeInstructions: Object.freeze([]),
      runtime: Object.freeze({ provider: 'a2a', carrier: 'remote', protocol: 'json_rpc' }),
      tools: Object.freeze({ finalSurface: 'unsupported' as const }),
      providerNativeVisibility: 'unsupported' as const,
    });
    if (!('body' in preparedRequest.message)) throw new Error('a2a_prepared_message_not_exact');
    const turn = { catId: this.catId, taskId, prompt: preparedRequest.message.body };
    const approvedRequest = buildAgentAccessA2ARequest(turn);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    // The synchronous tasks/send response is the whole remote turn, not a
    // connection handshake. A local request deadline would race the member's
    // sole no-output timer and cannot prove the remote task was cancelled.
    const signal = options?.signal;

    yield agentMsg('session_init', this.catId);
    let dispatched = false;
    try {
      await options?.beforeProviderLaunch?.(preparedRequest);
      if (signal?.aborted) throw signal.reason ?? new Error('aborted before send');
      yield* await this.runTurn(turn, async (body) => {
        signal?.throwIfAborted();
        if (dispatched || !isDeepStrictEqual(JSON.parse(body), approvedRequest)) {
          throw new Error('A2A request does not match the admitted turn');
        }
        dispatched = true;
        options?.onRemoteExecutionDispatched?.({ kind: 'a2a_task', id: taskId });
        const response = await this.fetchFn(this.config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(approvedRequest),
          signal,
        });
        return {
          status: response.status,
          statusText: response.statusText,
          payload: response.ok ? await response.json() : undefined,
        };
      });
    } catch (err) {
      // Aborting fetch only ends our local wait. The remote task may still be
      // running; without an acknowledged tasks/cancel, never report success.
      const isCallerAbort = options?.signal?.aborted === true;
      if (isCallerAbort) {
        yield agentMsg(
          'error',
          this.catId,
          dispatched
            ? 'A2A local wait cancelled; remote task termination is unconfirmed'
            : 'A2A cancelled before remote dispatch',
        );
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        yield agentMsg('error', this.catId, `A2A connection error: ${errMsg}`);
      }
    }
  }
}
