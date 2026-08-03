/**
 * F203 Phase J — kimi-code native L0 channel.
 *
 * kimi-code (new `kimi` CLI, ≠ legacy `kimi-cli`) exposes a native system-prompt
 * channel in print mode: `--agent-file <path>` loads a Markdown agent definition
 * whose body IS the system prompt (verified against CLI 0.29.1). The channel is
 * gated on the v2 engine via `KIMI_CODE_EXPERIMENTAL_FLAG=1`.
 *
 * The body starts with `${base_prompt}` so the CLI's built-in prompt skeleton
 * (environment, workspace instructions, skills injection) stays in effect; the
 * compiled per-cat L0 and the route layer's pack-only systemPrompt are appended
 * after it. Both travel the system role instead of the user-message
 * `<system_instructions>` prepend used by the legacy path, making
 * identity/家规 compression-immune like Claude `--system-prompt-file` and
 * Codex `-c developer_instructions`.
 *
 * Known semantic difference (verified 2026-07-25): the agent prompt is frozen
 * at the session's first bind — resumed sessions keep the L0 compiled at
 * session creation; updates land on the next fresh session.
 *
 * The agent `name` must stay stable per cat: kimi-code binds the agent at the
 * session's first bind and rejects re-binding a different name on resume.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCliCommand } from '../../../../../utils/cli-resolve.js';

/** Env flag selecting the kimi-code v2 engine (required for --agent-file under -p). */
export const KIMI_V2_ENGINE_ENV_KEY = 'KIMI_CODE_EXPERIMENTAL_FLAG';

/**
 * Whether the native `--agent-file` L0 channel is usable on this machine:
 * only the new kimi-code CLI (`kimi`) supports it; the legacy `kimi-cli`
 * (preferred by resolution order when both exist) has no native channel.
 * Shared by KimiAgentService.injectsL0Natively() and the F237 compiled-preview
 * route so both agree on whether kimi cats inject L0 natively *here*.
 */
export function isKimiNativeL0ChannelAvailable(): boolean {
  return resolveCliCommand('kimi-cli') === null && resolveCliCommand('kimi') !== null;
}

export interface KimiL0AgentFileOptions {
  catId: string;
  /** Compiled per-cat L0 (identity / 家规 / roster). */
  l0: string;
  /** Route-layer pack-only systemPrompt (appended after the L0). */
  packSystemPrompt?: string | undefined;
}

function toKebabCase(value: string): string {
  const kebab = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return kebab || 'cat';
}

export function buildKimiL0AgentFileContent(options: KimiL0AgentFileOptions): string {
  const sections = [
    '---',
    `name: cat-cafe-l0-${toKebabCase(options.catId)}`,
    `description: Clowder AI managed L0 identity prompt for ${options.catId} (generated, do not edit)`,
    '---',
    '',
    '${base_prompt}',
    '',
    options.l0.trim(),
  ];
  const pack = options.packSystemPrompt?.trim();
  if (pack) {
    sections.push('', '---', '', pack);
  }
  return `${sections.join('\n')}\n`;
}

/** Write the agent definition into a fresh mkdtemp dir; caller cleans up via removeKimiL0AgentFileDir. */
export function writeKimiL0AgentFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-kimi-l0-'));
  const path = join(dir, 'agent.md');
  writeFileSync(path, content, 'utf8');
  return path;
}

export function removeKimiL0AgentFileDir(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * `--agent-file` / `--agent` select the session's system prompt — they carry
 * the compression-immune L0, so user cliConfigArgs must not override them
 * (mirrors Claude RESERVED_SYSTEM_PROMPT_FLAGS / Codex RESERVED_SYSTEM_CONFIG_KEYS).
 */
const RESERVED_KIMI_SYSTEM_ARGS: ReadonlySet<string> = new Set(['--agent-file', '--agent']);

export function stripReservedKimiSystemArgs(userParts: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < userParts.length; i++) {
    const part = userParts[i]!;
    if (RESERVED_KIMI_SYSTEM_ARGS.has(part)) {
      i++; // also skip the flag's value
      continue;
    }
    if (part.startsWith('--agent-file=') || part.startsWith('--agent=')) continue;
    out.push(part);
  }
  return out;
}
