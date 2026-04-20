/**
 * F162: WeChat Work CLI Executor.
 *
 * Thin wrapper around `wecom-cli` (Rust binary distributed via npm).
 * Handles JSON output parsing, timeout, error classification.
 * Modeled after PandocService's execFile pattern (not cli-spawn.ts — that's for
 * long-running agent processes with NDJSON streaming).
 *
 * ADR-029 Decision 1: CliExecutor is the execution backend for WeComActionService.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type { WeComBaseResponse } from './wecom-types.js';

const execFileAsync = promisify(execFile);

/** Default timeout for wecom-cli commands (30 seconds, matching upstream default) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Thrown when wecom-cli returns errcode !== 0 */
export class WeComApiError extends Error {
  constructor(
    public readonly errcode: number,
    public readonly errmsg: string,
    public readonly category: string,
    public readonly method: string,
  ) {
    super(`WeChat Work API error [${errcode}]: ${errmsg} (${category}.${method})`);
    this.name = 'WeComApiError';
  }
}

/** Thrown when wecom-cli itself fails (not installed, timeout, crash) */
export class WeComCliUnavailableError extends Error {
  public readonly reason?: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'WeComCliUnavailableError';
    this.reason = reason;
  }
}

export class WeComCliExecutor {
  private available: boolean | null = null;
  private readonly log: FastifyBaseLogger;
  private readonly timeoutMs: number;

  constructor(log: FastifyBaseLogger, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  /** Check if wecom-cli is available. Result is cached after first check. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const { stdout } = await execFileAsync('wecom-cli', ['--version'], { timeout: 5_000 });
      this.log.info({ version: stdout.trim() }, '[WeComCli] wecom-cli detected');
      this.available = true;
    } catch {
      this.log.warn('[WeComCli] wecom-cli not found — enterprise actions will be unavailable');
      this.available = false;
    }
    return this.available;
  }

  /**
   * Execute a wecom-cli command and parse JSON response.
   *
   * @param category - Command category (doc, todo, meeting, contact, etc.)
   * @param method - Method name (create_doc, create_todo, etc.)
   * @param params - JSON parameters to pass to the command
   * @returns Parsed response (with errcode === 0 guaranteed)
   * @throws WeComApiError if errcode !== 0
   * @throws WeComCliUnavailableError if CLI is missing or crashes
   */
  async exec<T extends WeComBaseResponse>(
    category: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const available = await this.isAvailable();
    if (!available) {
      throw new WeComCliUnavailableError('wecom-cli is not installed or not configured');
    }

    const jsonParams = JSON.stringify(params);
    const args = [category, method, jsonParams];
    this.log.info({ category, method, params }, '[WeComCli] exec');

    try {
      const { stdout, stderr } = await execFileAsync('wecom-cli', args, {
        timeout: this.timeoutMs,
        maxBuffer: 5 * 1024 * 1024, // 5MB for large responses (user lists)
      });

      if (stderr.trim()) {
        this.log.debug({ category, method, stderr: stderr.trim() }, '[WeComCli] stderr');
      }

      const parsed = this.unwrapOutput<T>(stdout.trim());

      if (parsed.errcode !== 0) {
        throw new WeComApiError(parsed.errcode, parsed.errmsg, category, method);
      }

      this.log.info({ category, method, errcode: parsed.errcode }, '[WeComCli] success');
      return parsed;
    } catch (err) {
      if (err instanceof WeComApiError) throw err;

      const error = err as NodeJS.ErrnoException & { killed?: boolean };
      if (error.killed) {
        throw new WeComCliUnavailableError(`wecom-cli timed out after ${this.timeoutMs}ms`, err);
      }
      if (error.code === 'ENOENT') {
        this.available = false;
        throw new WeComCliUnavailableError('wecom-cli binary not found', err);
      }

      throw new WeComCliUnavailableError(`wecom-cli execution failed: ${error.message}`, err);
    }
  }

  /**
   * Unwrap wecom-cli output. The CLI returns MCP-style content wrapper:
   * `{"content":[{"text":"{...actual JSON...}","type":"text"}],"isError":false}`
   * This method handles both wrapped and raw JSON formats.
   */
  private unwrapOutput<T>(raw: string): T {
    const outer = JSON.parse(raw) as Record<string, unknown>;

    // MCP content wrapper: extract text from content[0].text
    if (Array.isArray(outer.content) && outer.content.length > 0) {
      const first = outer.content[0] as { text?: string; type?: string };
      if (first.text && first.type === 'text') {
        return JSON.parse(first.text) as T;
      }
    }

    // Raw JSON (no wrapper) — return as-is
    return outer as T;
  }

  /** Reset cached availability (for testing) */
  _resetCache(): void {
    this.available = null;
  }
}
