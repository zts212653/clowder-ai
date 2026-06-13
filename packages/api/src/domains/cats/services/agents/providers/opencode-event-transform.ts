/**
 * opencode Event Transformer
 * opencode JSON event stream → Clowder AI AgentMessage 映射
 *
 * opencode `run --format json` NDJSON 事件格式:
 *   { type, timestamp, sessionID, part: { type, ... } }
 *
 * Event mapping:
 *   step_start  → session_init (first occurrence establishes session)
 *   text        → text (part.text)
 *   tool_use    → tool_use (part.tool, part.state.input)
 *   error       → error (error.data.message or error.name)
 *   step_finish → agent_loop + metadata.usage (telemetry-only). Lights up
 *                 invoke-single-cat's F8 token block + F24 contextHealth
 *                 path so handoff can fire BEFORE context fills.
 *                 Pre-clowder#915 this returned null → usage dropped →
 *                 contextHealth never produced → handoff never triggered →
 *                 opencode hung at context limit.
 *   Others      → null
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

interface OpenCodeEvent {
  type: string;
  timestamp: number;
  sessionID: string;
  part?: {
    type: string;
    text?: string;
    tool?: string;
    callID?: string;
    /** step_finish only: terminal reason — 'stop' = final answer (terminal),
     *  'tool-calls' = LLM called tools, more steps follow (non-terminal),
     *  'length'/'content-filter' = upstream halted mid-step (terminal). */
    reason?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
    };
    /** step_finish only: USD cost of this step from the upstream provider. */
    cost?: number;
    /** step_finish only: token counts for this step (per-API-call shape).
     *  Note: opencode CLI reports cached prompt tokens under tokens.cache.{read,write}
     *  SEPARATELY from tokens.input. The shared TokenUsage contract requires
     *  inputTokens to be the TOTAL prompt (fresh + cached), so consumers must
     *  sum input + cache.read + cache.write when emitting AgentMessage usage.
     *  (clowder#915 R4 cloud P1 #1). */
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: {
        read?: number;
        write?: number;
      };
    };
    [key: string]: unknown;
  };
  error?: {
    name?: string;
    data?: {
      message?: string;
      statusCode?: number;
      [key: string]: unknown;
    };
  };
}

function isOpenCodeEvent(event: unknown): event is OpenCodeEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return typeof e.type === 'string';
}

export function transformOpenCodeEvent(event: unknown, catId: CatId | string): AgentMessage | null {
  if (!isOpenCodeEvent(event)) return null;

  const ts = typeof event.timestamp === 'number' ? event.timestamp : Date.now();

  switch (event.type) {
    case 'step_start':
      return {
        type: 'session_init',
        catId: catId as CatId,
        sessionId: event.sessionID,
        timestamp: ts,
      };

    case 'text': {
      const text = event.part?.text;
      if (typeof text !== 'string' || text.length === 0) return null;
      return {
        type: 'text',
        catId: catId as CatId,
        content: text,
        timestamp: ts,
      };
    }

    case 'tool_use': {
      const msg: AgentMessage = {
        type: 'tool_use',
        catId: catId as CatId,
        toolName: event.part?.tool ?? 'unknown',
        timestamp: ts,
      };
      if (event.part?.state?.input) {
        msg.toolInput = event.part.state.input;
      }
      return msg;
    }

    case 'error': {
      const errorMsg = event.error?.data?.message ?? event.error?.name ?? 'opencode error';
      return {
        type: 'error',
        catId: catId as CatId,
        error: errorMsg,
        timestamp: ts,
      };
    }

    case 'step_finish': {
      // clowder#915: surface token usage so invoke-single-cat's F8 token block
      // and F24 contextHealth path can compute fillRatio and trigger handoff
      // before context fills. Without this, opencode's session-chain machinery
      // sees zero usage signal and never seals → CLI hangs at context limit.
      //
      // 砚砚 R1 P1: don't set provider/model here — the transformer can't see
      // variant.defaultModel, and a `model: ''` here would break OTel
      // normalizeModel + getContextWindowFallback downstream. OpenCodeAgentService
      // merges this `usage` onto its own `metadata: { provider, model: effectiveModel }`
      // when yielding (see merge logic in OpenCodeAgentService.ts), so we emit a
      // partial metadata that the service layer completes.
      const tokens = event.part?.tokens;
      const freshInput = typeof tokens?.input === 'number' ? tokens.input : undefined;
      const cacheRead = typeof tokens?.cache?.read === 'number' ? tokens.cache.read : undefined;
      const cacheWrite = typeof tokens?.cache?.write === 'number' ? tokens.cache.write : undefined;
      const outputTokens = typeof tokens?.output === 'number' ? tokens.output : undefined;
      const totalTokens = typeof tokens?.total === 'number' ? tokens.total : undefined;
      const costUsd = typeof event.part?.cost === 'number' ? event.part.cost : undefined;

      // clowder#915 R4 cloud P1 #1: opencode CLI reports cached prompt tokens
      // (cache.read for resumed-context reuse, cache.write for first-time cache
      // population) SEPARATELY from tokens.input (fresh tokens this step).
      // The shared TokenUsage contract says inputTokens/lastTurnInputTokens
      // represent the TOTAL input including cached, and F24's context-fill
      // numerator reads lastTurnInputTokens. If we copied only tokens.input,
      // a long cached session (e.g. 671 fresh + 21k cached) would look like
      // 671 → fillRatio underflow → handoff never fires before context wall.
      const totalInputTokens =
        freshInput != null || cacheRead != null || cacheWrite != null
          ? (freshInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
          : undefined;

      // Defensive: opencode may emit step_finish without token data (cached responses,
      // pre-flight steps, etc.). With no telemetry there's nothing to surface; emit
      // nothing instead of an empty agent_loop marker.
      if (totalInputTokens == null && outputTokens == null && totalTokens == null) return null;

      // clowder#915 R4 cloud P1 #2: opencode CLI never emits contextWindowSize.
      // For models not in getContextWindowFallback's table (GLM-5.1, custom
      // providers), windowSize would be undefined and F24 silently skips. Attach
      // a conservative default so handoff is guaranteed to engage. The
      // helper's `usage.contextWindowSize ?? getContextWindowFallback(...)`
      // gating means a known-model lookup still takes precedence — this
      // default only kicks in when fallback would have returned undefined.
      // BUT: we ALSO set contextWindowSize unconditionally so unknown-model
      // runs (the production case for #915) always have a window.

      // clowder#915 R4 cloud P1 #3 (defer seal): handled in invoke-single-cat
      // by ALWAYS deferring opencode agent_loop seals to the `done` event,
      // regardless of step_finish.reason ('stop' vs 'tool-calls'). Since
      // `done` arrives after the CLI's final step, "defer to done" achieves
      // the same effect as "defer to terminal step" without the transformer
      // needing to leak step_finish.reason into TokenUsage shape.
      return {
        type: 'agent_loop',
        catId: catId as CatId,
        timestamp: ts,
        // Provider/model intentionally placeholders — OpenCodeAgentService overrides
        // them with effectiveModel + 'opencode' on yield. Only `usage` is the
        // transformer's contribution.
        metadata: {
          provider: 'opencode',
          model: '',
          usage: {
            ...(totalInputTokens != null
              ? { inputTokens: totalInputTokens, lastTurnInputTokens: totalInputTokens }
              : {}),
            ...(outputTokens != null ? { outputTokens } : {}),
            ...(totalTokens != null ? { totalTokens } : {}),
            // Skip zero-valued cache fields: 0 means "no cache activity this step",
            // emitting an explicit 0 is noise. Truthy check is enough (we already
            // confirmed type === 'number' above).
            ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheWrite ? { cacheCreationTokens: cacheWrite } : {}),
            ...(costUsd != null ? { costUsd } : {}),
            // clowder#915 R5 cloud P2: do NOT attach a default contextWindowSize
            // here. opencode-event-transform doesn't know whether the model is
            // known to getContextWindowFallback's table (e.g. claude-opus-4-6 has
            // a precise 200k entry). Unconditionally setting a default would
            // override the table because invoke-single-cat uses
            // `usage.contextWindowSize ?? getContextWindowFallback(model)` —
            // wrongly capping claude-opus-4-6 (default opencode breed model)
            // at the conservative default. The unknown-model fallback is now
            // applied in invoke-single-cat as a LAST resort, only after the
            // fallback table also returns undefined.
          },
        },
      };
    }

    default:
      return null;
  }
}
