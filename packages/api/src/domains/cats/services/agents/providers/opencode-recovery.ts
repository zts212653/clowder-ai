import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';

export const OPENCODE_DB_ENV = 'OPENCODE_DB';
export const OPENCODE_NO_TOOL_FINALIZER_AGENT = 'cat-cafe-no-tool-finalizer';
export const OPENCODE_NO_TOOL_PERMISSION = {
  '*': 'deny',
  read: 'deny',
  glob: 'deny',
  grep: 'deny',
  lsp: 'deny',
  skill: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  edit: 'deny',
  bash: 'deny',
  task: 'deny',
  question: 'deny',
} as const;

const MAX_OPENCODE_VISIBLE_TOOL_OUTPUT_CHARS = 4_000;
const DEFAULT_SAFE_TOOL_OUTPUT_CHARS = 1_000;
const OPENCODE_DB_FILE_PATTERN = /^opencode(?:[-_.][\w-]+)?\.db$/;

export interface OpenCodeToolTrace {
  toolName: string;
  status?: string;
  output?: unknown;
}

export interface OpenCodeMessageRef {
  sessionId?: string;
  messageId?: string;
}

export interface OpenCodeDbCandidate {
  path: string;
  source: 'override' | 'OPENCODE_DB' | 'xdg' | 'localappdata' | 'darwin' | 'default';
}

export interface OpenCodeDbResolutionOptions {
  overridePath?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface OpenCodeSilentRecoveryOptions extends OpenCodeDbResolutionOptions {
  sessionId?: string;
  messageId?: string;
}

export interface OpenCodeSilentRecoveryResult {
  text: string | null;
  source?: OpenCodeDbCandidate['source'];
  reason?: 'missing_ref' | 'missing_db' | 'schema_unavailable' | 'no_text';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncateForVisibleText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function stringifyForVisibleText(value: unknown, maxChars: number): string {
  if (value == null) return '';
  if (typeof value === 'string') return truncateForVisibleText(value, maxChars);
  const jsonText = JSON.stringify(value, null, 2);
  return truncateForVisibleText(typeof jsonText === 'string' ? jsonText : String(value), maxChars);
}

function redactGenericAbsolutePaths(value: string): string {
  return value
    .replace(/\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]+/g, '[redacted path]')
    .replace(
      /(^|[\s"'(=[{,:])\/(?:Users|home|var|private|opt|etc|mnt|workspace|tmp|usr|root|data|app|srv|projects)\/[^\s"'<>{}|]+/g,
      (_match, prefix: string) => `${prefix}[redacted path]`,
    );
}

function redactShortProviderSecrets(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted secret]');
}

export function projectSafeOpenCodeToolOutput(value: unknown, maxChars = DEFAULT_SAFE_TOOL_OUTPUT_CHARS): string {
  const raw = stringifyForVisibleText(value, MAX_OPENCODE_VISIBLE_TOOL_OUTPUT_CHARS);
  if (raw.trim().length === 0) return '';
  const sanitized = redactGenericAbsolutePaths(redactShortProviderSecrets(sanitizeCliStderr(raw)));
  return truncateForVisibleText(sanitized, maxChars);
}

export function extractOpenCodeToolTrace(event: unknown): OpenCodeToolTrace | null {
  if (!isRecord(event)) return null;
  if (event.type !== 'tool_use') return null;
  const part = isRecord(event.part) ? event.part : {};
  const state = isRecord(part.state) ? part.state : {};
  const toolName = typeof part.tool === 'string' && part.tool.length > 0 ? part.tool : 'unknown';
  const trace: OpenCodeToolTrace = { toolName };
  if (typeof state.status === 'string' && state.status.length > 0) {
    trace.status = state.status;
  }
  if ('output' in state) {
    trace.output = state.output;
  }
  return trace;
}

export function buildOpenCodePostToolFinalizerPrompt(trace: OpenCodeToolTrace | null): string {
  const toolName = trace ? trace.toolName : 'a tool';
  const outputText = projectSafeOpenCodeToolOutput(
    trace ? trace.output : undefined,
    MAX_OPENCODE_VISIBLE_TOOL_OUTPUT_CHARS,
  );
  return [
    'The previous OpenCode turn stopped immediately after a tool call and did not produce the final assistant text.',
    'Do not call any tools. Use only the existing session state and the sanitized latest tool result below to write the final answer to the user.',
    `Latest tool: ${toolName}${trace?.status ? ` (${trace.status})` : ''}.`,
    outputText.length > 0 ? `Latest tool output (sanitized):\n${outputText}` : 'No safe tool output was captured.',
    'If the available tool result is insufficient, state the limitation briefly instead of inventing details.',
  ].join('\n\n');
}

export function buildOpenCodePostToolFallbackText(trace: OpenCodeToolTrace | null, reason: string): string {
  const toolName = trace ? trace.toolName : 'a tool';
  const outputText = projectSafeOpenCodeToolOutput(trace ? trace.output : undefined);
  const lines = [
    `OpenCode stopped after running \`${toolName}\` but did not produce a final text response.`,
    `No-tool finalizer recovery did not produce text: ${reason}.`,
    trace?.status ? `Tool status: ${trace.status}.` : undefined,
    outputText.length > 0 ? `Latest tool output (sanitized):\n${outputText}` : 'No safe tool output was captured.',
    'This is a recovery message; review the sanitized tool output before treating the task as complete.',
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n\n');
}

export function extractOpenCodeMessageRef(event: unknown): OpenCodeMessageRef | null {
  if (!isRecord(event)) return null;
  if (event.type !== 'step_start') return null;
  const part = isRecord(event.part) ? event.part : {};
  const sessionId =
    typeof part.sessionID === 'string'
      ? part.sessionID
      : typeof event.sessionID === 'string'
        ? event.sessionID
        : undefined;
  const messageId =
    typeof part.messageID === 'string'
      ? part.messageID
      : typeof event.messageID === 'string'
        ? event.messageID
        : undefined;
  if (!sessionId && !messageId) return null;
  return { ...(sessionId ? { sessionId } : {}), ...(messageId ? { messageId } : {}) };
}

function extractOpenCodePartText(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.type !== 'text' || typeof parsed.text !== 'string') return null;
    const text = parsed.text;
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

function addCandidate(
  candidates: OpenCodeDbCandidate[],
  path: string | undefined,
  source: OpenCodeDbCandidate['source'],
) {
  if (!path) return;
  if (candidates.some((candidate) => candidate.path === path)) return;
  candidates.push({ path, source });
}

function addDbFilesFromDirectory(
  candidates: OpenCodeDbCandidate[],
  dir: string | undefined,
  source: OpenCodeDbCandidate['source'],
) {
  if (!dir || !existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir).sort()) {
      if (OPENCODE_DB_FILE_PATTERN.test(entry)) {
        addCandidate(candidates, join(dir, entry), source);
      }
    }
  } catch {
    return;
  }
}

export function resolveOpenCodeDbCandidates(options: OpenCodeDbResolutionOptions = {}): OpenCodeDbCandidate[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const runtimePlatform = options.platform ?? osPlatform();
  const candidates: OpenCodeDbCandidate[] = [];

  addCandidate(candidates, options.overridePath, 'override');
  addCandidate(candidates, env[OPENCODE_DB_ENV], 'OPENCODE_DB');

  const xdgOpenCodeDir = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'opencode') : undefined;
  addCandidate(candidates, xdgOpenCodeDir ? join(xdgOpenCodeDir, 'opencode.db') : undefined, 'xdg');
  addDbFilesFromDirectory(candidates, xdgOpenCodeDir, 'xdg');

  const localAppDataOpenCodeDir = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'opencode') : undefined;
  if (runtimePlatform === 'win32' || localAppDataOpenCodeDir) {
    addCandidate(
      candidates,
      localAppDataOpenCodeDir ? join(localAppDataOpenCodeDir, 'opencode.db') : undefined,
      'localappdata',
    );
    addDbFilesFromDirectory(candidates, localAppDataOpenCodeDir, 'localappdata');
  }

  if (runtimePlatform === 'darwin') {
    const darwinOpenCodeDir = join(homeDir, 'Library', 'Application Support', 'opencode');
    addCandidate(candidates, join(darwinOpenCodeDir, 'opencode.db'), 'darwin');
    addDbFilesFromDirectory(candidates, darwinOpenCodeDir, 'darwin');
  }

  const defaultOpenCodeDir = join(homeDir, '.local', 'share', 'opencode');
  addCandidate(candidates, join(defaultOpenCodeDir, 'opencode.db'), 'default');
  addDbFilesFromDirectory(candidates, defaultOpenCodeDir, 'default');

  return candidates;
}

export function recoverOpenCodeSilentCompletion(options: OpenCodeSilentRecoveryOptions): OpenCodeSilentRecoveryResult {
  if (!options.sessionId || !options.messageId) return { text: null, reason: 'missing_ref' };

  let sawExistingDb = false;
  let sawSchemaError = false;
  let schemaErrorSource: OpenCodeDbCandidate['source'] | undefined;
  for (const candidate of resolveOpenCodeDbCandidates(options)) {
    if (!existsSync(candidate.path)) continue;
    sawExistingDb = true;

    let db: Database.Database | undefined;
    try {
      db = new Database(candidate.path, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(
          `
          SELECT data
          FROM part
          WHERE session_id = ? AND message_id = ?
          ORDER BY time_created ASC
        `,
        )
        .all(options.sessionId, options.messageId) as Array<{ data: unknown }>;
      const text = rows
        .map((row) => (typeof row.data === 'string' ? extractOpenCodePartText(row.data) : null))
        .filter((partText): partText is string => partText !== null)
        .join('');
      if (text.trim().length > 0) return { text, source: candidate.source };
    } catch {
      sawSchemaError = true;
      schemaErrorSource = candidate.source;
    } finally {
      db?.close();
    }
  }

  if (!sawExistingDb) return { text: null, reason: 'missing_db' };
  if (sawSchemaError) return { text: null, source: schemaErrorSource, reason: 'schema_unavailable' };
  return { text: null, reason: 'no_text' };
}

export function identifierPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 8);
}

export class SessionSingleFlight {
  private readonly tails = new Map<string, Promise<void>>();

  async *run<T>(key: string | undefined, factory: () => AsyncIterable<T>): AsyncIterable<T> {
    const release = await this.acquire(key);
    try {
      yield* factory();
    } finally {
      release();
    }
  }

  private async acquire(key: string | undefined): Promise<() => void> {
    if (!key) return () => {};

    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}
