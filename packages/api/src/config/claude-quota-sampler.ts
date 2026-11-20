import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { ClaudeQuotaWindow } from '@cat-cafe/shared';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import type { RuntimeProviderProfile } from './account-resolver.js';
import { parseClaudeQuotaWindows } from './claude-quota-event.js';

const runFile = promisify(execFile);

export function parseClaudeQuotaSample(stdout: string) {
  let model: string | undefined;
  let success = false;
  const windows: Record<string, ClaudeQuotaWindow>[] = [];
  for (const line of stdout.split('\n')) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      const message = event.message as { model?: unknown } | undefined;
      if (typeof message?.model === 'string') model = message.model;
    }
    if (event.type === 'result') success = event.subtype === 'success' && event.is_error !== true;
    if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info as { unifiedWindows?: unknown } | undefined;
      const parsed = parseClaudeQuotaWindows(info?.unifiedWindows);
      if (parsed) windows.push(parsed);
    }
  }
  if (!success || !model || !windows.length) throw new Error('claude_quota_reading_unavailable');
  return { model, windows };
}

/** A fresh process with no tools, hooks, MCP or session persistence. Tokens travel only in its environment. */
export async function sampleClaudeQuota(profile: RuntimeProviderProfile, requestedModel: 'haiku' | 'fable') {
  const command = resolveCliCommand('claude');
  if (!command) throw new Error('claude_quota_cli_unavailable');
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USER',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      // Use the host's network route while leaving provider and auth overrides out.
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
  const token = profile.claude ? profile.envVars?.CLAUDE_CODE_OAUTH_TOKEN : process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  Object.assign(env, {
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  let stdout: string;
  try {
    ({ stdout } = await runFile(
      command,
      [
        '--safe-mode',
        '-p',
        '--no-session-persistence',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        requestedModel,
        '--tools',
        '',
        '--system-prompt',
        'Reply only OK.',
        'Reply only OK.',
      ],
      { cwd: tmpdir(), env, encoding: 'utf8', timeout: 45000, maxBuffer: 1048576 },
    ));
  } catch {
    // execFile errors may retain private stdout/stderr. Only this stable code may escape.
    throw new Error('claude_quota_cli_failed');
  }
  return parseClaudeQuotaSample(stdout);
}
