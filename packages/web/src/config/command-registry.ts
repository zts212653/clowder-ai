/**
 * Slash command registry — single source of truth for all chat commands.
 * Used by useChatCommands (dispatch) and HubCommandsTab (display).
 *
 * To add a new command:
 * 1. Add a CommandDefinition here
 * 2. Add the handler in useChatCommands.ts
 * That's it — the "命令速查" tab picks it up automatically.
 */

import { CORE_COMMANDS, type CommandSource, type CommandSurface } from '@cat-cafe/shared';

export type CommandCategory = 'general' | 'memory' | 'knowledge' | 'game' | 'task' | 'vote' | 'connector';

export interface CommandDefinition {
  /** The command string, e.g. '/help' */
  name: string;
  /** Usage pattern, e.g. '/config set <key> <value>' */
  usage: string;
  /** Human-readable description (Chinese) */
  description: string;
  /** Grouping category for display */
  category: CommandCategory;
  /** F142-B: where this command is available */
  surface: CommandSurface;
  /** F142-B: who registered it */
  source: CommandSource;
}

export const COMMAND_CATEGORIES: Record<CommandCategory, string> = {
  general: '通用',
  memory: '记忆',
  knowledge: '知识库',
  game: '游戏',
  task: '任务',
  vote: '投票',
  connector: '跨平台',
};

/** Core commands from shared — cast to web's CommandDefinition for UI consumption */
export const COMMANDS: CommandDefinition[] = CORE_COMMANDS as unknown as CommandDefinition[];
