/**
 * F162 Phase B: Lark/Feishu CLI Executor.
 *
 * Thin wrapper around `lark-cli` (Go binary distributed via @larksuite/cli npm).
 * Unlike wecom-cli (single-JSON-blob args), lark-cli uses cobra-style flags:
 *   lark-cli <domain> <+command> [--flag value ...]
 *
 * Responses come back as raw JSON with the shape:
 *   success: { ok: true,  identity, data: {...} }
 *   failure: { ok: false, identity, error: { type, code, message, hint } }
 *
 * The CLI exits 0 in both cases — success is determined by the `ok` field.
 *
 * ADR-029 Decision 1: CliExecutor is the execution backend for LarkActionService.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type { LarkBaseResponse, LarkCliErrorDetail } from './lark-types.js';

const execFileAsync = promisify(execFile);

/** Default timeout for lark-cli commands (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Flag value type: strings, numbers, booleans accepted */
export type LarkFlagValue = string | number | boolean;

/** Thrown when lark-cli returns ok: false */
export class LarkApiError extends Error {
  public readonly code: number;
  public readonly type: string;
  public readonly hint?: string;

  constructor(
    error: LarkCliErrorDetail,
    public readonly domain: string,
    public readonly command: string,
  ) {
    super(`Lark API error [${error.code} ${error.type}]: ${error.message} (${domain} ${command})`);
    this.name = 'LarkApiError';
    this.code = error.code;
    this.type = error.type;
    this.hint = error.hint;
  }
}

/** Thrown when lark-cli itself fails (not installed, timeout, crash, auth missing) */
export class LarkCliUnavailableError extends Error {
  public readonly reason?: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'LarkCliUnavailableError';
    this.reason = reason;
  }
}

/**
 * Thrown when lark-cli responds but the stdout does not conform to the expected
 * `{ok, identity, data|error}` envelope (non-JSON, truncated, protocol drift).
 *
 * Distinct from `LarkCliUnavailableError`: the CLI was reachable and returned output,
 * but the output cannot be interpreted. Surfacing this as a protocol error (→ 500)
 * prevents misdiagnosis as "CLI not installed" (→ 503) and preserves the raw payload
 * for debugging vendor shape changes.
 */
export class LarkCliProtocolError extends Error {
  public readonly reason?: unknown;
  public readonly rawOutput?: string;

  constructor(message: string, reason?: unknown, rawOutput?: string) {
    super(message);
    this.name = 'LarkCliProtocolError';
    this.reason = reason;
    this.rawOutput = rawOutput;
  }
}

export class LarkCliExecutor {
  private available: boolean | null = null;
  private readonly log: FastifyBaseLogger;
  private readonly timeoutMs: number;

  constructor(log: FastifyBaseLogger, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  /** Check if lark-cli is available. Result is cached after first check. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const { stdout } = await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
      this.log.info({ version: stdout.trim() }, '[LarkCli] lark-cli detected');
      this.available = true;
    } catch {
      this.log.warn('[LarkCli] lark-cli not found — enterprise actions will be unavailable');
      this.available = false;
    }
    return this.available;
  }

  /**
   * Execute a lark-cli command and parse JSON response.
   *
   * @param domain    - Top-level command (docs, task, calendar, base, im, ...)
   * @param command   - Subcommand (often prefixed with +, e.g. +create)
   * @param flags     - Flag map; values are stringified. `--flag value` for each entry.
   * @returns Parsed response with ok: true guaranteed
   * @throws LarkApiError if ok: false
   * @throws LarkCliUnavailableError if CLI is missing or crashes
   */
  async exec<T extends LarkBaseResponse>(
    domain: string,
    command: string,
    flags: Record<string, LarkFlagValue | undefined> = {},
  ): Promise<T> {
    const available = await this.isAvailable();
    if (!available) {
      throw new LarkCliUnavailableError('lark-cli is not installed or not configured');
    }

    const args: string[] = [domain, command];
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean') {
        if (value) args.push(`--${key}`);
        continue;
      }
      args.push(`--${key}`, String(value));
    }

    this.log.info({ domain, command, flags: Object.keys(flags) }, '[LarkCli] exec');

    try {
      const { stdout, stderr } = await execFileAsync('lark-cli', args, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (stderr.trim()) {
        this.log.debug({ domain, command, stderr: stderr.trim() }, '[LarkCli] stderr');
      }

      const parsed = this.parseOutput<T>(stdout.trim());

      if (parsed.ok === false) {
        const errorDetail = parsed.error ?? {
          type: 'unknown',
          code: -1,
          message: 'lark-cli reported ok:false without error detail',
        };
        throw new LarkApiError(errorDetail, domain, command);
      }

      this.log.info({ domain, command }, '[LarkCli] success');
      return parsed;
    } catch (err) {
      if (err instanceof LarkApiError) throw err;
      if (err instanceof LarkCliProtocolError) throw err;

      const error = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
      if (error.killed) {
        throw new LarkCliUnavailableError(`lark-cli timed out after ${this.timeoutMs}ms`, err);
      }
      if (error.code === 'ENOENT') {
        this.available = false;
        throw new LarkCliUnavailableError('lark-cli binary not found', err);
      }

      const detail = error.stderr ? `: ${error.stderr.trim().slice(0, 500)}` : '';
      throw new LarkCliUnavailableError(`lark-cli execution failed: ${error.message}${detail}`, err);
    }
  }

  /**
   * Parse lark-cli stdout. Accepts the `{ok, identity, data|error}` envelope.
   * Some commands may emit pure data (no envelope); treat absence of `ok` as
   * success and synthesize the envelope.
   */
  private parseOutput<T>(raw: string): T {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new LarkCliProtocolError(`lark-cli returned non-JSON stdout (${raw.length} chars)`, err, raw.slice(0, 500));
    }
    if (typeof parsed.ok !== 'boolean') {
      return { ok: true, data: parsed } as unknown as T;
    }
    return parsed as T;
  }

  /** Reset cached availability (for testing) */
  _resetCache(): void {
    this.available = null;
  }
}
