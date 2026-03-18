/**
 * Werewolf Game Definition Factory (F101)
 *
 * Creates a complete GameDefinition for a given player count,
 * using presets for role distribution and the standard phase sequence.
 */

import type { ActionDefinition, GameDefinition, PhaseDefinition, RoleDefinition, WinCondition } from '@cat-cafe/shared';
import { WEREWOLF_ROLES } from './WerewolfRoles.js';

/** Role distribution for a specific player count */
export interface WerewolfPreset {
  roles: Record<string, number>;
}

/** Presets: role distribution per player count (aligned with NetEase standard) */
export const WEREWOLF_PRESETS: Record<number, WerewolfPreset> = {
  6: { roles: { wolf: 2, seer: 1, witch: 1, villager: 2 } },
  7: { roles: { wolf: 2, seer: 1, witch: 1, hunter: 1, villager: 2 } },
  8: { roles: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 } },
  9: { roles: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 3 } },
  10: { roles: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 4 } },
  12: { roles: { wolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 } },
};

/** Standard phase sequence — some may be skipped if role not present */
function buildPhases(): PhaseDefinition[] {
  return [
    // Night: single-actor phases — 60s each (LLM-ready headroom)
    { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 60000, autoAdvance: true },
    { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 60000, autoAdvance: true },
    { name: 'night_seer', type: 'night_action', actingRole: 'seer', timeoutMs: 60000, autoAdvance: true },
    { name: 'night_witch', type: 'night_action', actingRole: 'witch', timeoutMs: 60000, autoAdvance: true },
    // Resolve / announce: system-driven, keep short
    { name: 'night_resolve', type: 'resolve', timeoutMs: 5000, autoAdvance: true },
    { name: 'day_announce', type: 'announce', timeoutMs: 15000, autoAdvance: true },
    { name: 'day_last_words', type: 'announce', timeoutMs: 60000, autoAdvance: true },
    { name: 'day_hunter', type: 'night_action', actingRole: 'hunter', timeoutMs: 45000, autoAdvance: true },
    // Multi-actor phases: 铲屎官要求至少 3 分钟，7 人串行 LLM 可能需要更多
    { name: 'day_discuss', type: 'day_discuss', actingRole: '*', timeoutMs: 180000, autoAdvance: true },
    { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 120000, autoAdvance: true },
    { name: 'day_pk', type: 'day_discuss', actingRole: '*', timeoutMs: 120000, autoAdvance: true },
    { name: 'day_exile', type: 'resolve', timeoutMs: 5000, autoAdvance: true },
  ];
}

function buildActions(): ActionDefinition[] {
  return [
    { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
    { name: 'divine', allowedRole: 'seer', allowedPhase: 'night_seer', targetRequired: true, schema: {} },
    { name: 'guard', allowedRole: 'guard', allowedPhase: 'night_guard', targetRequired: true, schema: {} },
    { name: 'heal', allowedRole: 'witch', allowedPhase: 'night_witch', targetRequired: false, schema: {} },
    { name: 'poison', allowedRole: 'witch', allowedPhase: 'night_witch', targetRequired: true, schema: {} },
    { name: 'shoot', allowedRole: 'hunter', allowedPhase: 'day_hunter', targetRequired: true, schema: {} },
    { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
    { name: 'speak', allowedRole: '*', allowedPhase: 'day_discuss', targetRequired: false, schema: {} },
  ];
}

function buildWinConditions(): WinCondition[] {
  return [
    { faction: 'wolf', description: '存活狼人数 ≥ 存活好人数', check: 'wolf_majority' },
    { faction: 'village', description: '所有狼人死亡', check: 'all_wolves_dead' },
  ];
}

/** Create a full GameDefinition for a given player count */
export function createWerewolfDefinition(playerCount: number): GameDefinition {
  const preset = WEREWOLF_PRESETS[playerCount];
  if (!preset) {
    throw new Error(
      `No werewolf preset for ${playerCount} players. Available: ${Object.keys(WEREWOLF_PRESETS).join(', ')}`,
    );
  }

  const roles: RoleDefinition[] = [];
  for (const [roleName, count] of Object.entries(preset.roles)) {
    if (count <= 0) continue;
    const role = WEREWOLF_ROLES[roleName];
    if (!role) throw new Error(`Unknown role: ${roleName}`);
    const roleDef: RoleDefinition = {
      name: role.name,
      faction: role.faction,
      description: role.description,
    };
    if (role.nightActionPhase) roleDef.nightActionPhase = role.nightActionPhase;
    roles.push(roleDef);
  }

  return {
    gameType: 'werewolf',
    displayName: 'Werewolf',
    minPlayers: playerCount,
    maxPlayers: playerCount,
    roles,
    phases: buildPhases(),
    actions: buildActions(),
    winConditions: buildWinConditions(),
  };
}
