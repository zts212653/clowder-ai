/**
 * Slash command types — F142 Phase B
 * Unified command definition used by both web and connector surfaces.
 */

export type CommandSurface = 'web' | 'connector' | 'both';
export type CommandSource = 'core' | 'skill' | 'mcp';

export interface SlashCommandDefinition {
  /** The command string, e.g. '/help' */
  readonly name: string;
  /** Usage pattern, e.g. '/config set <key> <value>' */
  readonly usage: string;
  /** Human-readable description (≤200 chars, plain text) */
  readonly description: string;
  /** Grouping category for display */
  readonly category: string;
  /** Where this command is available */
  readonly surface: CommandSurface;
  /** Who registered it */
  readonly source: CommandSource;
  /** Multi-word subcommands, e.g. ['status', 'end'] for /game status */
  readonly subcommands?: readonly string[];
  /** Owning skill ID (only when source='skill') */
  readonly skillId?: string;
}

export interface ParsedCommand {
  /** Matched command name, e.g. '/signals' */
  readonly name: string;
  /** Matched subcommand, e.g. 'search' for '/signals search cats' */
  readonly subcommand?: string;
  /** Remaining text after command + subcommand */
  readonly args: string;
  /** Original input */
  readonly raw: string;
  /** The resolved definition (if found in registry) */
  readonly definition?: SlashCommandDefinition;
}
