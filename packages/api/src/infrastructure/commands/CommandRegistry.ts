/**
 * Unified command registry — F142 Phase B
 * Aggregates core + skill commands at startup. In-memory cache (AC-B5).
 * Core commands always take priority over skill commands (AC-B2).
 */
import type { CommandSurface, SlashCommandDefinition } from '@cat-cafe/shared';

export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommandDefinition>();

  constructor(coreCommands: readonly SlashCommandDefinition[]) {
    for (const cmd of coreCommands) {
      this.commands.set(cmd.name, cmd);
    }
  }

  /**
   * Register commands declared by a skill.
   * Conflicts with existing commands are rejected with a warning.
   */
  registerSkillCommands(
    skillId: string,
    commands: readonly SlashCommandDefinition[],
    log: { warn: (msg: string) => void },
  ): void {
    for (const cmd of commands) {
      // Check exact name conflict
      const existing = this.commands.get(cmd.name);
      if (existing) {
        const owner = existing.source === 'core' ? 'core command' : `skill "${existing.skillId}"`;
        log.warn(
          `[CommandRegistry] Skill "${skillId}" tried to register "${cmd.name}" but it conflicts with ${owner} — rejected`,
        );
        continue;
      }
      // Check semantic conflict: expanded subcommand forms vs existing flat names
      let hasSubConflict = false;
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          const expanded = `${cmd.name} ${sub}`;
          const existingFlat = this.commands.get(expanded);
          if (existingFlat) {
            const owner = existingFlat.source === 'core' ? 'core command' : `skill "${existingFlat.skillId}"`;
            log.warn(
              `[CommandRegistry] Skill "${skillId}" subcommand "${expanded}" conflicts with ${owner} — rejected`,
            );
            hasSubConflict = true;
          }
        }
      }
      if (hasSubConflict) continue;
      this.commands.set(cmd.name, { ...cmd, source: 'skill', skillId });
    }
  }

  /** Commands matching surface or 'both' */
  listBySurface(surface: CommandSurface): SlashCommandDefinition[] {
    return [...this.commands.values()].filter((cmd) => cmd.surface === surface || cmd.surface === 'both');
  }

  getAll(): SlashCommandDefinition[] {
    return [...this.commands.values()];
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  get(name: string): SlashCommandDefinition | undefined {
    return this.commands.get(name);
  }
}
