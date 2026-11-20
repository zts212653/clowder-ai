import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentServiceOptions } from '../../types.js';

/** Host-owned bytes from the last successful request generation; never an HTTP input. */
export interface ClaudeCacheRetentionReplay {
  readonly sourceInvocationId: string;
  readonly nativeSystemPrompt: string;
  readonly appendSystemPrompt?: string;
  /** Host re-reads the live window at SDK dispatch, after asynchronous launch preparation. */
  readonly assertSendCurrent?: () => Promise<void>;
}

export function validateClaudeCacheRetentionReplay(
  options?: AgentServiceOptions,
): ClaudeCacheRetentionReplay | undefined {
  const replay = options?.cacheRetentionReplay;
  if (!replay) return undefined;
  const callback = options.callbackEnv;
  if (
    !options.sessionId ||
    !replay.nativeSystemPrompt ||
    !replay.sourceInvocationId ||
    !options.invocationId ||
    callback?.CAT_CAFE_INVOCATION_ID !== options.invocationId ||
    !callback.CAT_CAFE_CALLBACK_TOKEN ||
    replay.sourceInvocationId === options.invocationId ||
    options.toolExecutionPolicy?.mode !== 'callback_allowlist' ||
    options.toolExecutionPolicy.allowedCallbackRoutes.length !== 0
  )
    throw new Error('cache_retention_independent_denied_principal_required');
  return replay;
}

export function writeClaudeCacheRetentionL0(replay: ClaudeCacheRetentionReplay): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cat-cafe-l0-')), 'l0.md');
  writeFileSync(path, replay.nativeSystemPrompt, { encoding: 'utf8', mode: 0o600 });
  return path;
}

/** Preserve the original schema/model/effort flags while owning session and spend bounds. */
export function boundClaudeCacheRetentionArgs(args: string[], parentSessionId: string): void {
  const valued = new Set(['--resume', '--session-id', '--max-turns', '--max-budget-usd']);
  const boolean = new Set(['--fork-session', '--continue', '-c']);
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    const flag = value.split('=', 1)[0];
    if (boolean.has(flag)) continue;
    if (valued.has(flag)) {
      if (!value.includes('=')) i++;
      continue;
    }
    kept.push(value);
  }
  args.splice(
    0,
    args.length,
    ...kept,
    '--resume',
    parentSessionId,
    '--fork-session',
    '--max-turns',
    '1',
    '--max-budget-usd',
    // Native budgets are cumulative across resume/fork, including the inherited parent.
    // The manual Sonnet protocol separately caps the full experiment at 5 USD.
    '2',
  );
}

/** The CLI keeps its schemas; its tool runner receives a deny for every attempted tool. */
export function withClaudeCacheRetentionToolDenial(settings: string): string {
  const document = JSON.parse(settings) as Record<string, unknown>;
  const hooks = (document.hooks ?? {}) as Record<string, unknown>;
  const body = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Cache retention cannot execute tools.',
    },
  });
  const code = `process.stdout.write(${JSON.stringify(body)})`;
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const deny = {
    matcher: '*',
    hooks: [{ type: 'command', command: `${quote(process.execPath)} -e ${quote(code)}`, timeout: 3 }],
  };
  return JSON.stringify({
    ...document,
    disableAllHooks: false,
    hooks: { ...hooks, PreToolUse: [deny, ...(Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [])] },
  });
}

export function freezeClaudeCacheRetentionMemory(env: Record<string, string | null>): void {
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  // Adaptive thinking shares the output budget. A tiny cap can trigger several
  // native max-output continuations; bound spend with the native budget instead.
}
