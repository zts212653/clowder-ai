/**
 * A managed command reports its outcome through an exit code, which only has
 * room for "worked" and "did not work". Some commands finish correctly while
 * producing no verification evidence at all — the canonical gate's `targeted`
 * route is exactly that: classification completed, nothing was verified. Both
 * available renderings are wrong for it. `✅ 成功` invites a merge on evidence
 * that was never produced; `❌ 退出码 N` reads as a failure and sends the owner
 * off to debug something that did not break, or to rerun the full gate.
 *
 * So the command declares the state its exit code cannot express, as the final
 * line of the output the runner already captures. The declaration is
 * deliberately weak: it can only move a non-zero exit into a more precise
 * non-zero meaning. It can never turn a failure into a pass, it can never touch
 * a zero exit — a command must not be able to talk its way out of its own exit
 * code — and it only counts as the command's last word, so anything that keeps
 * running after declaring has withdrawn the claim.
 */

/** Marker a managed command prints to declare a terminal state its exit code cannot express. */
export const MANAGED_COMMAND_TERMINAL_DECLARATION_KEY = 'CAT_CAFE_MANAGED_TERMINAL_STATE';

/** Declared states the wake renderer understands. Unknown tokens are ignored, never guessed. */
export type ManagedCommandDeclaredTerminalState = 'unverified';

const DECLARED_TERMINAL_STATES = new Set<ManagedCommandDeclaredTerminalState>(['unverified']);
const DECLARATION_PATTERN = new RegExp(`^${MANAGED_COMMAND_TERMINAL_DECLARATION_KEY}=([a-z_]+)$`, 'u');

/**
 * The declaration describes how the command ended, so only its last word counts.
 * Matching it anywhere in the tail would let a chained command classify, declare,
 * and then genuinely fail — filing that failure as merely unverified. Trailing
 * blank lines are ignored because they carry no claim.
 */
function finalClaimLine(tailOutput: string): string | null {
  const lines = tailOutput.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Read a managed command's declared terminal state from its captured output.
 *
 * Returns null — meaning "render the ordinary exit-code label" — when the
 * command declared nothing, declared a state this renderer does not know, kept
 * producing output after its declaration, or exited zero. A zero exit is
 * already a complete statement and is never reinterpreted.
 */
export function readDeclaredManagedTerminalState(
  tailOutput: string | undefined,
  exitCode: number | null,
): ManagedCommandDeclaredTerminalState | null {
  if (typeof exitCode !== 'number' || exitCode === 0) return null;
  if (!tailOutput) return null;
  const finalLine = finalClaimLine(tailOutput);
  if (!finalLine) return null;
  const declared = DECLARATION_PATTERN.exec(finalLine)?.[1];
  if (!declared) return null;
  return DECLARED_TERMINAL_STATES.has(declared as ManagedCommandDeclaredTerminalState)
    ? (declared as ManagedCommandDeclaredTerminalState)
    : null;
}
