import { readFileSync } from 'node:fs';
import type { CliSpawnOptions } from '../../utils/cli-types.js';
import { contentRevision } from './message-query-protocol.js';

/** Qualification's final native launch boundary, after the shared carrier prepares full L0. */
export function prepareQualificationLaunch(
  original: CliSpawnOptions,
  model: string,
  trace?: (value: Record<string, unknown>) => void,
): CliSpawnOptions {
  const args = [...original.args];
  const switches = new Set(['-p', '--include-partial-messages', '--verbose', '--strict-mcp-config']);
  const values = new Map<string, string>();
  const valueFlags = new Set([
    '--model',
    '--effort',
    '--permission-mode',
    '--output-format',
    '--setting-sources',
    '--tools',
    '--system-prompt-file',
    '--append-system-prompt-file',
    '--settings',
  ]);
  const seen = new Set<string>();
  // This consumer accepts only the existing fresh, zero-tool print carrier.
  // Unknown aliases, equals syntax, duplicate flags and positional input fail closed.
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag) || (!switches.has(flag) && !valueFlags.has(flag)))
      throw new Error('Qualification launch mismatch');
    seen.add(flag);
    if (valueFlags.has(flag)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) throw new Error('Qualification launch mismatch');
      values.set(flag, value);
    }
  }
  const at = (flag: string) => values.get(flag);
  if (
    [...switches].some((flag) => !seen.has(flag)) ||
    !seen.has('--tools') ||
    at('--tools') !== '' ||
    at('--model') !== model ||
    at('--effort') !== 'low' ||
    at('--permission-mode') !== 'plan' ||
    at('--output-format') !== 'stream-json' ||
    at('--setting-sources') !== 'project,local,user' ||
    original.env?.CAT_CAFE_READONLY !== 'true'
  )
    throw new Error('Qualification launch mismatch');
  const instructions = ['--system-prompt-file', '--append-system-prompt-file'].map((flag) => {
    const path = at(flag);
    if (!path) throw new Error('Qualification full instructions unavailable');
    const body = readFileSync(path, 'utf8');
    if (!body.trim()) throw new Error('Qualification full instructions empty');
    return { decision: flag, chars: body.length, sha256: contentRevision(body) };
  });
  // dontAsk denies permission prompts; it grants no tools. Plan mode would inject
  // an unrelated Explore/write-a-plan workflow into this one JSON judgment.
  args[args.indexOf('--permission-mode') + 1] = 'dontAsk';
  trace?.({ phase: 'native-prepared', instructions, permissionMode: 'dontAsk', effort: 'low' });
  return {
    ...original,
    args: [...args, '--safe-mode'],
    // This closed JSON judgment has no human terminal title. The CLI's title
    // generator would add unrelated background inference to the bounded call.
    env: { ...original.env, CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' },
    bindExecutionOwner: false,
  };
}
