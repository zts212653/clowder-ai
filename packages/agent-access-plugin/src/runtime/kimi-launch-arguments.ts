import type { AgentAccessKimiLaunch } from '@clowder-ai/agent-contract';

/**
 * Server-owned kimi CLI args: user `cliConfigArgs` must never supply these.
 * Two families, one rule — a user value here does not merely duplicate a flag,
 * it silently defeats a governance guarantee:
 *
 *  1. System prompt — `--agent-file` / `--agent` carry the compression-immune L0
 *     (mirrors Claude RESERVED_SYSTEM_PROMPT_FLAGS / Codex RESERVED_SYSTEM_CONFIG_KEYS).
 *  2. Session selection — `--session` / `-S` / `--continue` / `-c`. F274's fingerprint
 *     gate decides *which* session may be resumed; a user-supplied session is resumed
 *     without ever being fingerprint-verified, so the gate would validate session A
 *     while the CLI restores session B — no `l0_resume_fresh_start` notice, silently
 *     running a possibly stale L0. (@codex-terra REQUEST_CHANGES on clowder-ai#1323:
 *     dropping `--agent-file` on verified resume removed the CLI mutual-exclusion
 *     crash that had been shielding this path by accident, making it newly reachable.)
 *
 * Arity is not uniform, and getting it wrong eats unrelated user args: `--agent-file <p>`
 * requires a value, `--session [id]` takes an optional one, `--continue` takes none
 * (verified against kimi-code 0.34.0 `--help`).
 *
 * Threat model is config hygiene, not an adversary: these are the forms an operator
 * plausibly types in the member editor, including the attached-value spellings
 * (`--session=<id>`, `-S<id>`) that were confirmed to select a session on 0.34.0.
 * Exotic commander bundling (`-yS <id>`) is out of scope and un-witnessed.
 */
const RESERVED_VALUE_REQUIRED: ReadonlySet<string> = new Set(['--agent-file', '--agent']);
const RESERVED_VALUE_OPTIONAL: ReadonlySet<string> = new Set(['--session', '-S']);
const RESERVED_VALUE_NONE: ReadonlySet<string> = new Set(['--continue', '-c']);

/** Attached-value spellings: `--flag=value`, and the short `-S<value>` concatenation. */
const RESERVED_ATTACHED_VALUE = /^(?:--agent-file=|--agent=|--session=|-S=|-S(?=.))/;

export function stripReservedKimiSystemArgs(userParts: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < userParts.length; i++) {
    const part = userParts[i]!;
    if (RESERVED_VALUE_REQUIRED.has(part)) {
      i++; // value is mandatory — always consume it
      continue;
    }
    if (RESERVED_VALUE_OPTIONAL.has(part)) {
      // Optional value: consume the next token only when it is not itself a flag.
      const next = userParts[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;
      continue;
    }
    if (RESERVED_VALUE_NONE.has(part)) continue; // takes no value — consume nothing else
    if (RESERVED_ATTACHED_VALUE.test(part)) continue;
    out.push(part);
  }
  return out;
}

export function buildKimiLaunchArguments(input: AgentAccessKimiLaunch) {
  const args: string[] = ['--output-format', 'stream-json'];
  if (input.skillsDirectory) args.push('--skills-dir', input.skillsDirectory);
  const managedArgvFlags: string[] = [];
  if (input.resumeSessionId) args.push('--session', input.resumeSessionId);
  for (const dir of input.imageAccessDirs) args.push('--add-dir', dir);
  if (input.model) {
    args.push('--model', input.model);
  }
  if (input.agentFile) {
    args.push('--agent-file', input.agentFile);
    managedArgvFlags.push('--agent-file');
  }
  args.push('-p', input.prompt);

  // User-defined CLI args from the member editor (#567).
  // `--agent-file` / `--agent` are reserved (they carry the compression-immune
  // L0) and stripped from user parts before the dedup pass.
  const userParts = stripReservedKimiSystemArgs(input.cliConfigArgs?.flatMap((arg) => arg.trim().split(/\s+/)) ?? []);
  if (userParts.length > 0) {
    const accumulativeFlags = new Set(['--add-dir']);
    const userFlags = new Set(userParts.filter((p) => p.startsWith('-')));
    const deduped: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-') && userFlags.has(args[i]) && !accumulativeFlags.has(args[i])) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
        continue;
      }
      deduped.push(args[i]);
    }
    args.length = 0;
    args.push(...deduped, ...userParts);
  }

  return { args, managedArgvFlags };
}
