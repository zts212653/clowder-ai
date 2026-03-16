/**
 * GameStatsRecorder (F101 Task B10)
 *
 * Extracts per-player stats from a finished GameRuntime for leaderboard integration.
 * All game types (werewolf, future games) produce the same stats schema.
 */

import type { GameRuntime } from '@cat-cafe/shared';

export interface PlayerStats {
  actorId: string;
  actorType: string;
  role: string;
  faction: string;
  survived: boolean;
  won: boolean;
}

export interface GameStats {
  gameId: string;
  gameType: string;
  threadId: string;
  endedAt: number;
  winner: string;
  players: PlayerStats[];
}

export interface DetailedPlayerStats {
  seatId: string;
  actorId: string;
  actorType: string;
  role: string;
  faction: string;
  survived: boolean;
  won: boolean;
  killCount: number;
  savedCount: number;
  divineCount: number;
}

export interface DetailedGameStats {
  gameId: string;
  gameType: string;
  threadId: string;
  endedAt: number;
  winner: string;
  rounds: number;
  duration: number;
  mvpSeatId: string;
  mvpReason: string;
  players: DetailedPlayerStats[];
}

export class GameStatsRecorder {
  static extractStats(runtime: GameRuntime): GameStats {
    const winner = runtime.winner ?? 'unknown';
    const factionMap = new Map<string, string>();

    for (const roleDef of runtime.definition.roles) {
      factionMap.set(roleDef.name, roleDef.faction);
    }

    const players: PlayerStats[] = runtime.seats.map((seat) => {
      const faction = factionMap.get(seat.role) ?? 'unknown';
      const won = faction === winner;

      return {
        actorId: seat.actorId,
        actorType: seat.actorType,
        role: seat.role,
        faction,
        survived: seat.alive,
        won,
      };
    });

    return {
      gameId: runtime.gameId,
      gameType: runtime.gameType,
      threadId: runtime.threadId,
      endedAt: runtime.updatedAt,
      winner,
      players,
    };
  }

  /** Extract detailed per-player stats with action counts and MVP */
  static extractDetailedStats(runtime: GameRuntime): DetailedGameStats {
    const winner = runtime.winner ?? 'unknown';
    const factionMap = new Map<string, string>();
    for (const roleDef of runtime.definition.roles) {
      factionMap.set(roleDef.name, roleDef.faction);
    }

    // Count actions per seat from event log
    const killCounts = new Map<string, number>();
    const saveCounts = new Map<string, number>();
    const divineCounts = new Map<string, number>();

    for (const event of runtime.eventLog) {
      if (event.type !== 'player_action') continue;
      const payload = event.payload as { seatId?: string; action?: string };
      const seatId = payload.seatId;
      if (!seatId) continue;

      switch (payload.action) {
        case 'kill':
          killCounts.set(seatId, (killCounts.get(seatId) ?? 0) + 1);
          break;
        case 'heal':
          saveCounts.set(seatId, (saveCounts.get(seatId) ?? 0) + 1);
          break;
        case 'divine':
          divineCounts.set(seatId, (divineCounts.get(seatId) ?? 0) + 1);
          break;
      }
    }

    const players: DetailedPlayerStats[] = runtime.seats.map((seat) => {
      const faction = factionMap.get(seat.role) ?? 'unknown';
      return {
        seatId: seat.seatId,
        actorId: seat.actorId,
        actorType: seat.actorType,
        role: seat.role,
        faction,
        survived: seat.alive,
        won: faction === winner,
        killCount: killCounts.get(seat.seatId) ?? 0,
        savedCount: saveCounts.get(seat.seatId) ?? 0,
        divineCount: divineCounts.get(seat.seatId) ?? 0,
      };
    });

    // MVP: highest impact score on winning side
    const winningPlayers = players.filter((p) => p.won);
    let mvpSeatId = winningPlayers[0]?.seatId ?? players[0]?.seatId ?? 'P1';
    let mvpScore = -1;
    let mvpReason = '';

    for (const p of winningPlayers) {
      const score = p.killCount + p.savedCount * 2 + p.divineCount;
      if (score > mvpScore) {
        mvpScore = score;
        mvpSeatId = p.seatId;
        if (p.killCount > 0) mvpReason = `击杀 ${p.killCount} 人`;
        else if (p.savedCount > 0) mvpReason = `救治 ${p.savedCount} 人`;
        else if (p.divineCount > 0) mvpReason = `查验 ${p.divineCount} 人`;
        else mvpReason = '存活到最后';
      }
    }

    // If no winning player had actions, pick survived player
    if (mvpScore <= 0 && winningPlayers.length > 0) {
      const survivor = winningPlayers.find((p) => p.survived) ?? winningPlayers[0];
      if (survivor) {
        mvpSeatId = survivor.seatId;
        mvpReason = '存活到最后';
      }
    }

    return {
      gameId: runtime.gameId,
      gameType: runtime.gameType,
      threadId: runtime.threadId,
      endedAt: runtime.updatedAt,
      winner,
      rounds: runtime.round,
      duration: runtime.updatedAt - runtime.createdAt,
      mvpSeatId,
      mvpReason,
      players,
    };
  }
}
