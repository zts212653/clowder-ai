/**
 * CatAgent Native Provider — F159 Phase C: Minimal Provider
 *
 * Calls Anthropic Messages API directly (no CLI subprocess).
 * Uses raw fetch — no @anthropic-ai/sdk dependency.
 *
 * Security: credentials via account-binding fail-closed (B1),
 * event mapping via catagent-event-bridge (B4).
 * AC-C4: No tools sent to API — tool surface deferred to Phase D.
 */

import type { CatConfig, CatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../../types.js';
import { resolveApiCredentials } from './catagent-credentials.js';
import { mapAnthropicError, mapAnthropicResponse } from './catagent-event-bridge.js';

const log = createModuleLogger('catagent');

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 4096;

interface CatAgentServiceOptions {
  catId: CatId;
  projectRoot: string;
  catConfig: CatConfig | null;
}

export class CatAgentService implements AgentService {
  readonly catId: CatId;
  private readonly projectRoot: string;
  private readonly catConfig: CatConfig | null;

  constructor(options: CatAgentServiceOptions) {
    this.catId = options.catId;
    this.projectRoot = options.projectRoot;
    this.catConfig = options.catConfig;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const now = Date.now();

    // 0. Resolve model (graceful failure — no throw)
    let model: string;
    try {
      model = getCatModel(this.catId as string);
    } catch {
      log.error(`[${this.catId}] Model resolution failed — no model configured`);
      yield* emitError('Model resolution failed — no configured model', this.catId, 'unknown', now);
      return;
    }

    // 1. Resolve credentials (B1 — fail-closed)
    const credentials = resolveApiCredentials(this.projectRoot, this.catId as string, this.catConfig);
    if (!credentials) {
      log.error(`[${this.catId}] Credential resolution failed — cannot invoke`);
      yield* emitError('Credential resolution failed — no bound account', this.catId, model, now);
      return;
    }

    // 2. Generate session ID (ephemeral, per-invocation)
    const sessionId = `catagent-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const metadata: MessageMetadata = { provider: 'catagent', model, sessionId };

    // 3. Emit session_init
    yield { type: 'session_init', catId: this.catId, sessionId, metadata, timestamp: now };

    // 4. Call Anthropic API and yield response events
    yield* this.callApi(prompt, model, metadata, credentials, options);
  }

  private async *callApi(
    prompt: string,
    model: string,
    metadata: MessageMetadata,
    credentials: { apiKey: string; baseURL?: string },
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage> {
    const baseUrl = credentials.baseURL ?? DEFAULT_BASE_URL;
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;

    const body = JSON.stringify({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
      ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
      // AC-C4: No tools — tool surface deferred to Phase D
    });

    log.info(`[${this.catId}] Invoking Anthropic API: model=${model}, prompt=${prompt.length} chars`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': credentials.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body,
        signal: options?.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        log.warn(`[${this.catId}] API error ${response.status}: ${errText.slice(0, 200)}`);
        for (const msg of mapAnthropicError(
          { status: response.status, message: errText },
          this.catId,
          'catagent',
          model,
        )) {
          yield { ...msg, metadata: { ...metadata, ...msg.metadata } };
        }
        return;
      }

      const result = (await response.json()) as Parameters<typeof mapAnthropicResponse>[0];
      for (const msg of mapAnthropicResponse(result, this.catId, 'catagent')) {
        yield { ...msg, metadata: { ...metadata, ...msg.metadata } };
      }
    } catch (err: unknown) {
      // AC-C3: AbortSignal cancellation — emit error + done, never dangle
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.info(`[${this.catId}] Request aborted`);
        yield {
          type: 'error',
          catId: this.catId,
          error: 'Request aborted',
          metadata,
          timestamp: Date.now(),
        };
        yield {
          type: 'done',
          catId: this.catId,
          metadata: { ...metadata, usage: { inputTokens: 0, outputTokens: 0 } },
          timestamp: Date.now(),
        };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[${this.catId}] Unexpected error: ${message}`);
      for (const msg of mapAnthropicError({ status: 0, message }, this.catId, 'catagent', model)) {
        yield { ...msg, metadata: { ...metadata, ...msg.metadata } };
      }
    }
  }
}

/** Emit error + done pair — convenience for pre-API failures */
function emitError(message: string, catId: CatId, model: string, timestamp: number): AgentMessage[] {
  const metadata: MessageMetadata = { provider: 'catagent', model };
  return [
    { type: 'error', catId, error: message, metadata, timestamp },
    { type: 'done', catId, metadata: { ...metadata, usage: { inputTokens: 0, outputTokens: 0 } }, timestamp },
  ];
}
