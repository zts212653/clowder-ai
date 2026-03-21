/**
 * Game Command Interceptor (F101)
 *
 * Parses `/game` chat commands and builds the input needed to start a game
 * via GameOrchestrator. This bridges the gap between chat messages and the
 * game lifecycle API.
 */

import type { Seat } from '@cat-cafe/shared';

/** Known game types that have engine implementations */
const KNOWN_GAME_TYPES = new Set(['werewolf']);

/** Subcommands that should NOT be treated as game-start commands */
const SUBCOMMANDS = new Set(['status', 'end']);

/** Valid human role values */
const VALID_HUMAN_ROLES = new Set(['player', 'god-view']);

/** Valid board preset player counts (ascending) */
const VALID_PLAYER_COUNTS: readonly number[] = [6, 7, 8, 9, 10, 12];

/** Clamp a number to the nearest valid preset player count */
function clampToPreset(n: number): number {
  if (n <= VALID_PLAYER_COUNTS[0]) return VALID_PLAYER_COUNTS[0];
  if (n >= VALID_PLAYER_COUNTS[VALID_PLAYER_COUNTS.length - 1])
    return VALID_PLAYER_COUNTS[VALID_PLAYER_COUNTS.length - 1];
  // Find nearest valid preset (prefer lower if equidistant)
  let best = VALID_PLAYER_COUNTS[0];
  for (const preset of VALID_PLAYER_COUNTS) {
    if (preset <= n) best = preset;
  }
  return best;
}

/**
 * Filter catIds to only include IDs present in the allowed whitelist.
 * Deduplicates to prevent same cat filling multiple seats.
 */
export function sanitizeCatIds(catIds: string[], allowedIds: readonly string[]): string[] {
  const allowed = new Set(allowedIds);
  const seen = new Set<string>();
  return catIds.filter((id) => {
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export interface ParsedGameCommand {
  gameType: string;
  humanRole: 'player' | 'god-view';
  voiceMode: boolean;
  /** Player count from lobby config; undefined = use default */
  playerCount?: number;
  /** Specific cat IDs from lobby config; undefined = use all cats */
  catIds?: string[];
}

/**
 * Parse a `/game` command from a chat message.
 * Returns null if the message is not a valid `/game` start command.
 *
 * Format: /game <type> <role> [<playerCount>] [<catIds>] [voice]
 * Examples:
 *   /game werewolf player
 *   /game werewolf player 9
 *   /game werewolf player 9 opus,sonnet,codex,gpt52,spark,gemini,gemini25,dare
 *   /game werewolf god-view 7 opus,sonnet,codex voice
 */
export function parseGameCommand(content: string): ParsedGameCommand | null {
  const trimmed = content.trim();
  if (!trimmed.toLowerCase().startsWith('/game ') && trimmed.toLowerCase() !== '/game') return null;

  const parts = trimmed.split(/\s+/);
  // Need at least: /game <type> <role>
  if (parts.length < 3) return null;

  const gameType = parts[1]!.toLowerCase();

  // Reject subcommands like /game status, /game end
  if (SUBCOMMANDS.has(gameType)) return null;

  // Reject unknown game types
  if (!KNOWN_GAME_TYPES.has(gameType)) return null;

  const humanRole = parts[2]!.toLowerCase();
  if (!VALID_HUMAN_ROLES.has(humanRole)) return null;

  // Parse remaining parts: [playerCount] [catIds] [voice]
  let playerCount: number | undefined;
  let catIds: string[] | undefined;
  let voiceMode = false;

  for (let i = 3; i < parts.length; i++) {
    const part = parts[i]!.toLowerCase();
    if (part === 'voice') {
      voiceMode = true;
    } else if (/^\d+$/.test(part)) {
      playerCount = clampToPreset(parseInt(part, 10));
    } else if (!catIds) {
      // First non-voice, non-digit token = catIds (single or comma-separated)
      catIds = part.split(',').filter(Boolean);
    }
  }

  return {
    gameType,
    humanRole: humanRole as 'player' | 'god-view',
    voiceMode,
    playerCount,
    catIds,
  };
}

interface BuildSeatsInput {
  humanRole: 'player' | 'god-view' | 'detective';
  userId: string;
  catIds: readonly string[];
  playerCount: number;
}

/**
 * Build seat assignments for a game.
 *
 * - player mode: P1 = human, P2..Pn = cats
 * - god-view / detective mode: all seats are cats (human observes)
 */
export function buildGameSeats(input: BuildSeatsInput): Seat[] {
  const { humanRole, userId, catIds, playerCount } = input;

  // Enforce minimum cat count — no seat duplication allowed
  const catSlotsNeeded = humanRole === 'player' ? playerCount - 1 : playerCount;
  if (catIds.length < catSlotsNeeded) {
    throw new Error(
      `Not enough cats: need ${catSlotsNeeded} but got ${catIds.length}. Each seat must have a unique actor.`,
    );
  }

  const seats: Seat[] = [];

  if (humanRole === 'player') {
    // P1 = human player
    seats.push({
      seatId: 'P1' as `P${number}`,
      actorType: 'human',
      actorId: userId,
      role: '',
      alive: true,
      properties: {},
    });
    // P2..Pn = AI cats (cycle if needed)
    for (let i = 1; i < playerCount; i++) {
      const catId = catIds[(i - 1) % catIds.length]!;
      seats.push({
        seatId: `P${i + 1}` as `P${number}`,
        actorType: 'cat',
        actorId: catId,
        role: '',
        alive: true,
        properties: {},
      });
    }
  } else {
    // god-view: all seats are cats
    for (let i = 0; i < playerCount; i++) {
      const catId = catIds[i % catIds.length]!;
      seats.push({
        seatId: `P${i + 1}` as `P${number}`,
        actorType: 'cat',
        actorId: catId,
        role: '',
        alive: true,
        properties: {},
      });
    }
  }

  return seats;
}
