/**
 * LlmAIProvider (F101 Phase H3)
 *
 * Concrete AIProvider implementation that routes LLM calls to the correct
 * provider (Anthropic/OpenAI/Google) based on cat-config.json.
 *
 * Design decisions (from Phase H plan TD-H1):
 * - Lightweight HTTP API calls (not CLI spawn) — game is single-turn structured
 *   reasoning, not a full agent session.
 * - Each cat uses its own model via getCatModel(catId).
 * - 10s timeout per call; fallback to null on failure (caller handles fallback).
 */

import { catRegistry } from '@cat-cafe/shared';
import { resolveForClient } from '../../../../config/account-resolver.js';
import { getCatModel } from '../../../../config/cat-models.js';
import type { AIActionResponse, AIProvider } from '../game/werewolf/WerewolfAIPlayer.js';

const LLM_TIMEOUT_MS = 10_000;

interface LlmCallResult {
  text: string;
}

export class LlmAIProvider implements AIProvider {
  private readonly model: string;
  private readonly provider: string;

  constructor(catId: string) {
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
          // Unsupported providers (dare, antigravity, etc.) — fall through to Anthropic
          return await this.callAnthropic(prompt, controller.signal);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve API key via full account discovery chain (well-known → builtin_ → installer-). */
  private resolveApiKey(client: 'anthropic' | 'openai' | 'google' | 'kimi'): string | undefined {
    const profile = resolveForClient(process.cwd(), client);
    return profile?.apiKey;
  }

  private async callAnthropic(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const apiKey = this.resolveApiKey('anthropic');
    if (!apiKey) throw new Error('No Anthropic API key in credentials.json — run install-auth-config.mjs to configure');

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
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
    const apiKey = this.resolveApiKey('openai');
    if (!apiKey) throw new Error('No OpenAI API key in credentials.json — run install-auth-config.mjs to configure');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
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
    const apiKey = this.resolveApiKey('google');
    if (!apiKey) throw new Error('No Google API key in credentials.json — run install-auth-config.mjs to configure');

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 256 },
        }),
        signal,
      },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Google AI API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return { text: data.candidates[0]?.content.parts[0]?.text ?? '' };
  }

  private async callKimi(prompt: string, signal: AbortSignal): Promise<LlmCallResult> {
    const apiKey = this.resolveApiKey('kimi');
    if (!apiKey) throw new Error('No Kimi API key in credentials or MOONSHOT_API_KEY env');

    const resp = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
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
