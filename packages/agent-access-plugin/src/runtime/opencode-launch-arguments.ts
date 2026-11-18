/**
 * OpenCode native launch argument planning.
 *
 * Moved out of the Host's `OpenCodeAgentService` so the active Agent Access
 * package owns the CLI surface. The Host keeps everything that needs a process:
 * resolving the `opencode` binary, the `run --help` capability probe, credentials,
 * cwd and spawning. This module receives those probe results as plain values and
 * only arranges argv.
 *
 * The probe-derived inputs are deliberately parameters, not lookups — a plan is a
 * pure function of what the Host already established, so it stays testable and the
 * package never spawns anything.
 */

/** Auto-approval spellings a user may legitimately pick in the member editor. */
const AUTO_APPROVE_FLAG_ALIASES: ReadonlySet<string> = new Set([
  '--auto',
  '--dangerously-skip-permissions',
  '--yolo',
  '--no-auto',
  '--no-yolo',
  '--no-dangerously-skip-permissions',
]);

/** Flag name with any `=value` suffix stripped; `null` for positionals. */
function cliFlagName(part: string): string | null {
  if (!part.startsWith('-')) return null;
  const equalsIndex = part.indexOf('=');
  return equalsIndex > 0 ? part.slice(0, equalsIndex) : part;
}

/** Member-editor CLI args are shell-ish strings, one or more flags each. */
function splitUserCliArgs(cliConfigArgs?: readonly string[]): string[] {
  const parts: string[] = [];
  for (const arg of cliConfigArgs ?? []) parts.push(...arg.trim().split(/\s+/));
  return parts;
}

function userControlsAutoApprove(userFlags: ReadonlySet<string>): boolean {
  return Array.from(AUTO_APPROVE_FLAG_ALIASES).some((flag) => userFlags.has(flag));
}

export interface OpenCodeLaunchPlanInput {
  prompt: string;
  sessionId?: string;
  model?: string;
  readOnly?: boolean;
  cliConfigArgs?: readonly string[];
  /** Approval flag the Host probe found this installed CLI advertises. */
  approvalFlag?: string;
  /** Transport args the Host resolved (`--standalone` / `--server` family). */
  transportArgs?: readonly string[];
  /** Agent name for the read-only run; the Host owns this constant. */
  readOnlyAgent: string;
}

export function buildOpenCodeLaunchArguments(input: OpenCodeLaunchPlanInput) {
  const args: string[] = ['run', ...(input.transportArgs ?? [])];
  const managedArgvFlags: string[] = [];

  if (input.readOnly) {
    args.push('--pure', '--agent', input.readOnlyAgent);
    managedArgvFlags.push('--pure');
  }

  if (input.sessionId) args.push('--session', input.sessionId);
  if (input.model) args.push('-m', input.model);

  args.push('--format', 'json');
  if (input.approvalFlag) {
    args.push(input.approvalFlag);
    managedArgvFlags.push(input.approvalFlag);
  }

  // Member-editor args win on overlap with system-injected flags (#567): drop the
  // system copy and its value rather than emitting the flag twice.
  const userParts = splitUserCliArgs(input.cliConfigArgs);
  const userFlags = new Set(userParts.map(cliFlagName).filter((flag): flag is string => flag !== null));
  const userControlsApproval = userControlsAutoApprove(userFlags);
  const deduped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const part = args[i];
    if (part === undefined) continue;
    const flagName = cliFlagName(part);
    if (flagName !== null && (userFlags.has(flagName) || (flagName === input.approvalFlag && userControlsApproval))) {
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) i++;
      continue;
    }
    deduped.push(part);
  }

  // Keep user flags parseable, then end option parsing before the prompt: without
  // `--` a dash-prefixed prompt is read as an unknown flag and the CLI stops.
  deduped.push(...userParts, '--', input.prompt);

  return { args: deduped, managedArgvFlags };
}

export interface OpenCodeNoToolFinalizerPlanInput {
  prompt: string;
  model: string;
  finalizerAgent: string;
  sessionId?: string;
  transportArgs?: readonly string[];
}

/**
 * The second, tool-free run that recovers a final answer after the CLI stopped on
 * a tool call. Narrower than the main plan: no approval flag, no user args — it is
 * the Host's own continuation, so nothing here comes from the member editor.
 */
export function buildOpenCodeNoToolFinalizerArguments(input: OpenCodeNoToolFinalizerPlanInput) {
  const args: string[] = ['run', ...(input.transportArgs ?? []), '--pure', '--agent', input.finalizerAgent];
  if (input.sessionId) args.push('--session', input.sessionId);
  if (input.model) args.push('-m', input.model);
  args.push('--format', 'json', '--', input.prompt);

  return { args, managedArgvFlags: ['--pure', '--agent'] };
}
