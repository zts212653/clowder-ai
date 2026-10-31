/**
 * Unified slash command parser — F142 Phase B
 * Longest-match dispatch: subcommands checked before base command.
 */
import type { ParsedCommand, SlashCommandDefinition } from './types/command.js';

/**
 * Check if `input` matches `command` exactly or followed by whitespace.
 * Prevents '/helping' from matching '/help'.
 */
function isCommandMatch(input: string, command: string): boolean {
  if (!input.startsWith(command)) return false;
  if (input.length === command.length) return true;
  return /\s/.test(input.charAt(command.length));
}

/** A candidate match string with its source definition and optional subcommand. */
interface Candidate {
  readonly match: string;
  readonly def: SlashCommandDefinition;
  readonly sub?: string;
}

/**
 * Parse user input against a command registry.
 * Builds a candidate list from all names + subcommands, sorts by length
 * descending (longest first), and returns the first match.
 * Handles both "subcommands" field and flat multi-word names (CORE_COMMANDS).
 */
export function parseCommand(input: string, commands: readonly SlashCommandDefinition[]): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  // Build candidate list: expand subcommands + base names, sort longest first
  const candidates: Candidate[] = [];
  for (const def of commands) {
    if (def.subcommands) {
      for (const sub of def.subcommands) {
        candidates.push({ match: `${def.name} ${sub}`, def, sub });
      }
    }
    candidates.push({ match: def.name, def });
  }
  candidates.sort((a, b) => b.match.length - a.match.length);

  for (const c of candidates) {
    if (isCommandMatch(trimmed, c.match)) {
      return {
        name: c.sub ? c.def.name : c.match,
        subcommand: c.sub,
        args: trimmed.slice(c.match.length).trim(),
        raw: trimmed,
        definition: c.def,
      };
    }
  }

  return null;
}
