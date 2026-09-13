/** Shared ZCode ACP adapter types and 0.16.3 protocol helpers. */

import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type TurnFailure = { code?: string; message?: string };

export type TurnEvent = {
  delta?: string;
  terminal?: 'completed' | 'failed' | 'cancelled';
  failure?: TurnFailure;
};

export function flattenAcpPrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  const parts: string[] = [];
  for (const block of prompt) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

export function zcodeLaunchPlan(bin: string): { command: string; args: string[] } {
  const args = ['app-server', '--surface', 'terminal', '--mode', 'yolo'];
  if (bin.endsWith('.cjs') || bin.endsWith('.js') || bin.endsWith('.mjs')) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  return { command: bin, args };
}

type TurnPayload = {
  kind?: string;
  delta?: string;
  resultType?: string;
  error?: { type?: string; code?: string; message?: string };
  turnPhase?: string;
};

export function parseTurnEvent(msg: JsonRpc, sessionId: string): TurnEvent | undefined {
  if (msg.method !== 'session/event') return undefined;
  const params = (msg.params ?? {}) as { type?: string; payload?: TurnPayload; sessionId?: string };
  if (params.sessionId && params.sessionId !== sessionId) return undefined;
  const payload = params.payload ?? {};
  if (params.type === 'model.streaming' && payload.kind === 'text_delta' && payload.delta) {
    return { delta: payload.delta };
  }
  if (params.type === 'turn.completed' || params.type === 'turn.terminal') {
    if (payload.resultType === 'cancelled') return { terminal: 'cancelled' };
    if (payload.resultType && payload.resultType !== 'success') {
      return { terminal: 'failed', failure: { code: payload.resultType } };
    }
    return { terminal: 'completed' };
  }
  if (params.type === 'turn.failed') {
    const nested = payload.error;
    return {
      terminal: 'failed',
      failure: {
        code: nested?.code ?? nested?.type,
        message: nested?.message,
      },
    };
  }
  return undefined;
}

const CREDENTIAL_KEY = 'ANTHROPIC_API_KEY|ZCODE_API_KEY|x-api-key|api[_-]?key|access[_-]?token|secret|authorization';

const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`"(?:${CREDENTIAL_KEY})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`, 'gi'),
  new RegExp(`'(?:${CREDENTIAL_KEY})'\\s*:\\s*'(?:\\\\.|[^'\\\\])*'`, 'gi'),
  new RegExp(`\\b(?:${CREDENTIAL_KEY})\\s*[:=]\\s*["']?[^\\s"']+`, 'gi'),
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]+\b/gi,
];

export function sanitizeZcodeFailureText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  out = out.replace(/\b(ANTHROPIC_API_KEY|ZCODE_API_KEY)\b/g, '[redacted-env]');
  out = out.replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted]');
  return out.slice(0, 400);
}

export const ZCODE_STDERR_LINE_MAX = 4096;

/** Line-buffered stderr redaction so credentials split across pipe chunks cannot leak. */
export class ZcodeStderrRedactor {
  private buf = '';
  /** After an oversize logical line, ignore remaining fragments until newline. */
  private dropping = false;

  push(chunk: string): string[] {
    const lines: string[] = [];
    let data = this.buf + chunk;
    this.buf = '';
    let offset = 0;
    while (offset < data.length) {
      if (this.dropping) {
        const nl = data.indexOf('\n', offset);
        if (nl < 0) return lines.filter((line) => line.trim());
        offset = nl + 1;
        this.dropping = false;
        continue;
      }
      const nl = data.indexOf('\n', offset);
      if (nl >= 0) {
        lines.push(sanitizeZcodeFailureText(data.slice(offset, nl)));
        offset = nl + 1;
        continue;
      }
      const tail = data.slice(offset);
      if (tail.length > ZCODE_STDERR_LINE_MAX) {
        lines.push('[redacted-truncated]');
        this.dropping = true;
      } else {
        this.buf = tail;
      }
      break;
    }
    return lines.filter((line) => line.trim());
  }

  flush(): string | undefined {
    if (this.dropping) {
      this.dropping = false;
      this.buf = '';
      return undefined;
    }
    if (!this.buf) return undefined;
    const leftover = this.buf;
    this.buf = '';
    if (leftover.length > ZCODE_STDERR_LINE_MAX) return '[redacted-truncated]';
    const out = sanitizeZcodeFailureText(leftover).trim();
    return out || undefined;
  }
}

export function formatZcodeTurnFailure(failure: TurnFailure | undefined): string {
  const code = sanitizeZcodeFailureText(failure?.code?.trim() || 'turn.failed');
  const message = sanitizeZcodeFailureText(failure?.message?.trim() || 'ZCode turn failed');
  return `zcode ${code}: ${message}`;
}

export function extractZcodeFailure(error: unknown): TurnFailure {
  if (typeof error === 'string') return { message: error };
  if (error instanceof Error) return { code: error.name, message: error.message };
  if (!error || typeof error !== 'object') return { message: 'ZCode native error' };
  const rec = error as Record<string, unknown>;
  const nested = rec.error && typeof rec.error === 'object' ? (rec.error as Record<string, unknown>) : rec;
  const code = nested.code ?? nested.type;
  const message = nested.message;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
}

/**
 * Clean-home 0.16.3 uses `ZCODE_MODEL` as an env token (e.g. GLM-5.2).
 * Explicit `provider/model` or JSON `{providerId,modelId}` on session/create
 * needs a persisted provider config that Hub-owned empty homes do not have.
 */
export function readZcodeEnvModel(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.includes('/')) return undefined;
  return trimmed;
}

export function hasZcodeProviderCredential(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ZCODE_API_KEY?.trim());
}

export type ZcodeSpawnReadyResult = { ok: true; envModel: string } | { ok: false; error: Error };

export function diagnoseZcodeSpawnReady(env: NodeJS.ProcessEnv): ZcodeSpawnReadyResult {
  const envModel = readZcodeEnvModel(env.ZCODE_MODEL);
  if (!envModel) {
    return {
      ok: false,
      error: new Error(
        'ZCode ACP skipped: ZCODE_MODEL must be a clean-home env token such as GLM-5.2. Do not send native {providerId,modelId} on session/create; 0.16.3 rejects zai/glm-5.2 and needs persisted provider config for anthropic/GLM-5.2.',
      ),
    };
  }
  if (!hasZcodeProviderCredential(env)) {
    return {
      ok: false,
      error: new Error(
        'ZCode ACP skipped: no provider credential. Bind a Hub API-key account to @zcode, or export ANTHROPIC_API_KEY before starting Hub. Hub uses an isolated app-server home; do not write the user ~/.zcode.',
      ),
    };
  }
  return { ok: true, envModel };
}

export function resolveZcodeIsolatedHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CAT_CAFE_ZCODE_HOME?.trim();
  if (override) return override;
  const catCafeHome = env.CAT_CAFE_HOME?.trim();
  const root = catCafeHome || join(env.HOME?.trim() || homedir(), '.cat-cafe');
  return join(root, 'zcode', 'app-server-home');
}

export function ensureZcodeIsolatedHome(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    /* best-effort on platforms that ignore mode */
  }
  return home;
}

/**
 * ZCode's Anthropic SDK treats baseURL like `https://api.anthropic.com/v1`
 * and appends `/messages`. Claude-Code-style docs omit `/v1`; that 404s here.
 */
export function normalizeZcodeAnthropicBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const noSlash = trimmed.replace(/\/+$/, '');
  if (/\/v1$/i.test(noSlash)) return noSlash;
  if (/\/api\/anthropic$/i.test(noSlash)) return `${noSlash}/v1`;
  return noSlash;
}

export function zcodeAppServerEnv(parent: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  const anthropicBaseUrl = normalizeZcodeAnthropicBaseUrl(parent.ANTHROPIC_BASE_URL);
  return {
    ...parent,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    ...(anthropicBaseUrl ? { ANTHROPIC_BASE_URL: anthropicBaseUrl } : {}),
  };
}

export function zcodeWorkspace(cwd: string): { workspacePath: string; workspaceKey: string } {
  return { workspacePath: cwd, workspaceKey: cwd };
}

export function readZcodeSessionId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const rec = result as Record<string, unknown>;
  const session = rec.session;
  if (session && typeof session === 'object') {
    const sessionId = (session as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string' && sessionId.trim()) return sessionId;
  }
  return typeof rec.sessionId === 'string' && rec.sessionId.trim() ? rec.sessionId : undefined;
}
