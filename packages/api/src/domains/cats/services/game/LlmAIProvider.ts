/**
 * LlmAIProvider (F101 Phase H3)
 *
 * Concrete AIProvider implementation that routes LLM calls to the correct
 * provider (Anthropic/OpenAI/Google) based on the resolved runtime cat config.
 *
 * Design decisions (from Phase H plan TD-H1):
 * - Lightweight HTTP API calls (not CLI spawn) — game is single-turn structured
 *   reasoning, not a full agent session.
 * - Each cat uses its own model via getCatModel(catId).
 * - 10s timeout per call; fallback to null on failure (caller handles fallback).
 */

import { catRegistry } from '@cat-cafe/shared';
import {
  type BuiltinAccountClient,
  builtinAccountIdForClient,
  resolveByAccountRef,
  resolveForClient,
} from '../../../../config/account-resolver.js';
import { resolveBoundAccountRefForCat } from '../../../../config/cat-account-binding.js';
import { getCatModel } from '../../../../config/cat-models.js';
import { assertProviderCredentialDestination } from '../../../../config/provider-credential-policy.js';
import { buildProviderEndpoint } from '../../../../config/provider-endpoint.js';
import { resolveActiveProjectRoot } from '../../../../utils/active-project-root.js';
import type { AIActionResponse, AIProvider } from '../game/werewolf/WerewolfAIPlayer.js';

const LLM_TIMEOUT_MS = 10_000;

interface LlmCallResult {
  text: string;
}

export class LlmAIProvider implements AIProvider {
  private readonly model: string;
  private readonly provider: string;
  private readonly catId: string;

  constructor(catId: string) {
    this.catId = catId;
    this.model = getCatModel(catId);
    const entry = catRegistry.tryGet(catId);
    this.provider = entry?.config.clientId ?? 'anthropic';
  }

  async generateAction(prompt: string, _schema: Record<string, unknown>): Promise<AIActionResponse> {
    const result = await this.callLlm(prompt);
    return this.parseActionResponse(result.text);
  }

  async generateSpeech(prompt: string): Promise<string> {
    const result = await this.callLlm(prompt);
    return result.text.trim();
  }

  private async callLlm(prompt: string): Promise<LlmCallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      switch (this.provider) {
        case 'anthropic':
          return await this.callAnthropic(prompt, controller.signal);
        case 'openai':
          return await this.callOpenAI(prompt, controller.signal);
        case 'google':
          return await this.callGoogle(prompt, controller.signal);
        case 'kimi':
          return await this.callKimi(prompt, controller.signal);
        default:
          throw new Error(`Unsupported game provider: ${this.provider}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Keep deterministic builtin fallback, and authorize the same destination that fetch receives. */
  private resolveRequest(client: Exclude<BuiltinAccountClient, 'opencode'>): { apiKey: string; url: string } {
    const root = resolveActiveProjectRoot(process.cwd());
    const entry = catRegistry.tryGet(this.catId);
    const accountRef = entry ? resolveBoundAccountRefForCat(root, this.catId, entry.config) : undefined;
    const builtinRef = builtinAccountIdForClient(client);
    const profile = accountRef
      ? resolveForClient(root, client, accountRef)
      : builtinRef
        ? resolveByAccountRef(root, builtinRef)
        : null;
    if (!profile?.apiKey) throw new Error(`No ${client} API key in the selected account`);
    const url = buildProviderEndpoint({
      protocol: client,
      baseUrl: profile.baseUrl,
      model: this.model,
      ...(client === 'google' ? { apiKey: profile.apiKey } : {}),
    });
    assertProviderCredentialDestination(profile, client, url);
    return { apiKey: profile.apiKey, url };
  }

  private async callAnthropic(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { apiKey, url } = this.resolveRequest('anthropic');

    const resp = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Anthropic API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { content: Array<{ text: string }> };
    return { text: data.content[0]?.text ?? '' };
  }

  private async callOpenAI(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { apiKey, url } = this.resolveRequest('openai');

    const resp = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`OpenAI API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return { text: data.choices[0]?.message.content ?? '' };
  }

  private async callGoogle(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { url } = this.resolveRequest('google');

    const resp = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 256 },
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Google AI API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return { text: data.candidates[0]?.content.parts[0]?.text ?? '' };
  }

  private async callKimi(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const { apiKey, url } = this.resolveRequest('kimi');

    const resp = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Kimi API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return { text: data.choices[0]?.message.content ?? '' };
  }

  /** Parse LLM text response into structured action. Tolerates markdown wrapping. */
  private parseActionResponse(text: string): AIActionResponse {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```(?:json)?\n?/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      return {
        actionName: String(parsed.actionName ?? ''),
        targetSeat: parsed.targetSeat ? String(parsed.targetSeat) : undefined,
      };
    } catch {
      // Fallback: try to extract targetSeat from natural language
      const match = cleaned.match(/P\d+/);
      return {
        actionName: '',
        targetSeat: match ? match[0] : undefined,
      };
    }
  }
}
