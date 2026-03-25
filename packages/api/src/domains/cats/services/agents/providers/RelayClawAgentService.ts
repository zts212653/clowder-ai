/**
 * RelayClaw Agent Service
 *
 * Thin orchestration layer:
 * - optional sidecar bootstrap
 * - persistent WS connection
 * - request/response streaming
 */

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { CatId, RelayClawAgentConfig } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../../types.js';
import { appendLocalImagePathHints } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import { FrameQueue, RelayClawConnectionManager, type RelayClawConnectionFactory } from './relayclaw-connection.js';
import { buildCatCafeMcpRequestConfig } from './relayclaw-catcafe-mcp.js';
import {
  DefaultRelayClawSidecarController,
  isSidecarReady,
  type RelayClawSidecarController,
  type RelayClawSidecarControllerDeps,
} from './relayclaw-sidecar.js';
import { transformRelayClawChunk } from './relayclaw-event-transform.js';

export interface RelayClawAgentServiceOptions {
  catId?: CatId;
  config: RelayClawAgentConfig;
}

export interface RelayClawAgentServiceDeps {
  createConnection?: RelayClawConnectionFactory;
  createSidecarController?: (
    catId: CatId,
    config: RelayClawAgentConfig,
  ) => RelayClawSidecarController;
  sidecarDeps?: RelayClawSidecarControllerDeps;
}

function agentMsg(type: AgentMessage['type'], catId: CatId, content?: string): AgentMessage {
  return { type, catId, content, timestamp: Date.now() };
}

function buildRelayClawFilesPayload(
  contentBlocks: AgentServiceOptions['contentBlocks'],
  uploadDir?: string,
): Record<string, unknown> | undefined {
  const imagePaths = extractImagePaths(contentBlocks, uploadDir);
  if (imagePaths.length === 0) return undefined;
  return {
    uploaded: imagePaths.map((path, index) => ({
      type: 'image',
      name: basename(path) || `image-${index + 1}`,
      path,
    })),
  };
}

export class RelayClawAgentService implements AgentService {
  private readonly catId: CatId;
  private readonly config: RelayClawAgentConfig;
  private readonly requestQueues = new Map<string, FrameQueue>();
  private readonly connection;
  private readonly sidecar: RelayClawSidecarController;
  private resolvedUrl: string | null = null;

  constructor(options: RelayClawAgentServiceOptions, deps?: RelayClawAgentServiceDeps) {
    this.catId = options.catId ?? createCatId('relayclaw-agent');
    this.config = options.config;
    this.connection =
      deps?.createConnection?.(this.requestQueues) ?? new RelayClawConnectionManager({ requestQueues: this.requestQueues });
    this.sidecar =
      deps?.createSidecarController?.(this.catId, this.config) ??
      new DefaultRelayClawSidecarController(this.catId, this.config, deps?.sidecarDeps);
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const signal = buildSignal(this.config.timeoutMs ?? 180_000, options?.signal);
    yield agentMsg('session_init', this.catId);

    try {
      await this.ensureConnected(signal, options);
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: `jiuwenClaw connection failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
      return;
    }

    const requestId = randomUUID();
    const queue = new FrameQueue();
    this.requestQueues.set(requestId, queue);
    const onAbort = () => queue.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      this.connection.send(buildRequest(requestId, this.config.channelId ?? 'catcafe', prompt, options));
      yield* this.consumeFrames(queue, signal, options?.signal);
    } catch (err) {
      if (options?.signal?.aborted) {
        yield agentMsg('done', this.catId);
      } else {
        yield {
          type: 'error',
          catId: this.catId,
          error: `jiuwenClaw error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        };
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.requestQueues.delete(requestId);
    }
  }

  private async ensureConnected(signal?: AbortSignal, options?: AgentServiceOptions): Promise<void> {
    if (this.config.autoStart) {
      this.resolvedUrl = await this.sidecar.ensureStarted(options, signal);
    }
    const url = this.resolvedUrl ?? this.config.url;
    if (!url) throw new Error('jiuwenClaw WebSocket URL is not configured');
    await this.connection.ensureConnected(url, signal);
  }

  private async *consumeFrames(
    queue: FrameQueue,
    signal: AbortSignal,
    callerSignal?: AbortSignal,
  ): AsyncIterable<AgentMessage> {
    let sawError = false;
    let emittedText = false;

    while (!signal.aborted) {
      const frame = await queue.take();
      if (frame === null) break;

      const payload = frame.payload;
      const message = transformRelayClawChunk(frame, this.catId);
      if (message) {
        yield message;
        if (message.type === 'text' && message.content) emittedText = true;
        if (message.type === 'error') {
          sawError = true;
          break;
        }
      } else if (
        !emittedText &&
        payload?.event_type === 'chat.final' &&
        typeof payload.content === 'string' &&
        payload.content.length > 0
      ) {
        emittedText = true;
        yield agentMsg('text', this.catId, payload.content);
      }

      if (frame.is_complete === true || payload?.is_complete === true) break;
    }

    if (!sawError && signal.aborted && !callerSignal?.aborted) {
      sawError = true;
      yield {
        type: 'error',
        catId: this.catId,
        error: 'jiuwenClaw request timed out before completion',
        timestamp: Date.now(),
      };
    }

    if (!sawError) yield agentMsg('done', this.catId);
    else yield agentMsg('done', this.catId);
  }
}

function buildSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (callerSignal) signals.push(callerSignal);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function buildRequest(
  requestId: string,
  channelId: string,
  prompt: string,
  options?: AgentServiceOptions,
): Record<string, unknown> {
  const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
  return {
    request_id: requestId,
    channel_id: channelId,
    session_id: `${channelId}_${Date.now().toString(16)}_${randomUUID().slice(0, 12)}`,
    req_method: 'chat.send',
    params: {
      query: appendLocalImagePathHints(prompt, imagePaths),
      mode: 'agent',
      ...(options?.workingDirectory ? { project_dir: options.workingDirectory } : {}),
      ...(buildRelayClawFilesPayload(options?.contentBlocks, options?.uploadDir)
        ? { files: buildRelayClawFilesPayload(options?.contentBlocks, options?.uploadDir) }
        : {}),
      ...(buildCatCafeMcpRequestConfig(options) ? { cat_cafe_mcp: buildCatCafeMcpRequestConfig(options) } : {}),
    },
    is_stream: true,
    timestamp: Date.now() / 1000,
  };
}

export const __relayClawInternals = {
  isSidecarReady,
};
