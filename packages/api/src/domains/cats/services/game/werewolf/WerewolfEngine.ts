/**
 * WerewolfEngine (F101 Tasks B2+B3)
 *
 * Extends GameEngine with werewolf-specific night/day resolution and win conditions.
 * Night: 同守同救, witch self-heal rules, hunter can-shoot, guard consecutive restriction.
 * Day: vote, PK, exile, hunter shoot, idiot reveal, speeches, last words.
 */

import { GameEngine } from '../GameEngine.js';

interface NightActions {
  kill?: { by: string; target: string };
  guard?: { by: string; target: string };
  heal?: { by: string; target: string };
  poison?: { by: string; target: string };
}

interface NightResult {
  deaths: string[];
  hunterCanShoot: boolean;
}

interface VoteResult {
  exiled: string | null;
  tied: boolean;
  pkCandidates: string[];
}

interface ExileResult {
  hunterCanShoot: boolean;
}

export class WerewolfEngine extends GameEngine {
  private nightActions: NightActions = {};
  private votes: Map<string, string> = new Map();

  /** Register a night action. Validates guard consecutive-night rule. */
  setNightAction(seatId: string, action: string, targetSeatId: string): void {
    const runtime = this.getRuntime();
    const seat = runtime.seats.find((s) => s.seatId === seatId);
    if (!seat) throw new Error(`Seat ${seatId} not found`);

    if (action === 'guard') {
      const lastTarget = seat.properties.lastGuardTarget;
      if (lastTarget === targetSeatId) {
        throw new Error(`Cannot guard same target on consecutive nights`);
      }
      this.nightActions.guard = { by: seatId, target: targetSeatId };
    } else if (action === 'kill') {
      this.nightActions.kill = { by: seatId, target: targetSeatId };
    } else if (action === 'heal') {
      this.nightActions.heal = { by: seatId, target: targetSeatId };
    } else if (action === 'poison') {
      this.nightActions.poison = { by: seatId, target: targetSeatId };
    }
  }

  /** Resolve all night actions. Returns deaths and hunter shoot eligibility. */
  resolveNight(): NightResult {
    const runtime = this.getRuntime();
    const deaths: string[] = [];
    let hunterCanShoot = false;

    const knifed = this.nightActions.kill?.target;
    const guarded = this.nightActions.guard?.target;
    const healed = this.nightActions.heal?.target;
    const poisoned = this.nightActions.poison?.target;

    // Resolve knife target
    if (knifed) {
      const isGuarded = guarded === knifed;
      const isHealed = healed === knifed;

      // Witch self-heal restriction: only allowed round 1
      const healValid = isHealed && this.isHealValid();

      if (isGuarded && healValid) {
        // 同守同救: guard + witch both save → target DIES
        deaths.push(knifed);
      } else if (isGuarded || healValid) {
        // Single save → target survives
      } else {
        // No protection → target dies
        deaths.push(knifed);
      }
    }

    // Witch poison: independent of knife, always kills
    if (poisoned && !deaths.includes(poisoned)) {
      deaths.push(poisoned);
    }
    // Poison can also double-kill if target was already knifed
    // (handled: knifed already in deaths, poison target different)

    // Hunter can-shoot: knifed = yes, poisoned = no
    const hunterSeat = runtime.seats.find((s) => s.role === 'hunter');
    if (hunterSeat && deaths.includes(hunterSeat.seatId)) {
      // Hunter can shoot only if killed by knife, not by poison
      hunterCanShoot = poisoned !== hunterSeat.seatId;
    }

    // Apply deaths to seats
    for (const seatId of deaths) {
      const seat = runtime.seats.find((s) => s.seatId === seatId);
      if (seat) seat.alive = false;
    }

    // Update guard's lastGuardTarget
    if (this.nightActions.guard) {
      const guardSeat = runtime.seats.find((s) => s.seatId === this.nightActions.guard?.by);
      if (guardSeat) {
        guardSeat.properties.lastGuardTarget = this.nightActions.guard.target;
      }
    }

    // Clear night actions for next round
    this.nightActions = {};

    return { deaths, hunterCanShoot };
  }

  // --- Day Phase Methods ---

  /** Cast a vote. Validates alive + not revealed idiot. */
  castVote(voterSeatId: string, targetSeatId: string): void {
    const runtime = this.getRuntime();
    const voter = runtime.seats.find((s) => s.seatId === voterSeatId);
    if (!voter) throw new Error(`Seat ${voterSeatId} not found`);
    if (!voter.alive) throw new Error(`${voterSeatId} is not alive, cannot vote`);
    if (voter.properties.idiotRevealed) {
      throw new Error(`${voterSeatId} is revealed idiot, cannot vote`);
    }
    this.votes.set(voterSeatId, targetSeatId);
  }

  /** Resolve votes → exile or tie. Clears vote map after resolution. */
  resolveVotes(): VoteResult {
    const tally = new Map<string, number>();
    for (const target of this.votes.values()) {
      tally.set(target, (tally.get(target) ?? 0) + 1);
    }
    this.votes.clear();

    if (tally.size === 0) return { exiled: null, tied: false, pkCandidates: [] };

    const maxVotes = Math.max(...tally.values());
    const topCandidates = [...tally.entries()].filter(([, count]) => count === maxVotes).map(([seatId]) => seatId);

    if (topCandidates.length !== 1) {
      return { exiled: null, tied: topCandidates.length > 1, pkCandidates: topCandidates };
    }

    const exiled = topCandidates[0]!;
    this.applyExile(exiled);
    return { exiled, tied: false, pkCandidates: [] };
  }

  /** PK round: re-vote among candidates. Tie = no exile (平票放过). */
  resolvePK(candidates: string[]): VoteResult {
    const tally = new Map<string, number>();
    for (const target of this.votes.values()) {
      if (candidates.includes(target)) {
        tally.set(target, (tally.get(target) ?? 0) + 1);
      }
    }
    this.votes.clear();

    if (tally.size === 0) return { exiled: null, tied: false, pkCandidates: [] };

    const maxVotes = Math.max(...tally.values());
    const topCandidates = [...tally.entries()].filter(([, count]) => count === maxVotes).map(([seatId]) => seatId);

    if (topCandidates.length !== 1) {
      return { exiled: null, tied: false, pkCandidates: [] };
    }

    const exiled = topCandidates[0]!;
    this.applyExile(exiled);
    return { exiled, tied: false, pkCandidates: [] };
  }

  /** Handle exile. Idiot survives but gets revealed. Returns hunter shoot eligibility. */
  resolveVoteExile(seatId: string): ExileResult {
    this.applyExile(seatId);
    const seat = this.getRuntime().seats.find((s) => s.seatId === seatId);
    return { hunterCanShoot: seat?.role === 'hunter' && !seat.alive };
  }

  /** Hunter shoots a target. Logs public event. */
  hunterShoot(hunterSeatId: string, targetSeatId: string): void {
    const runtime = this.getRuntime();
    const target = runtime.seats.find((s) => s.seatId === targetSeatId);
    if (!target) throw new Error(`Target ${targetSeatId} not found`);
    target.alive = false;

    this.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'hunter_shoot',
      scope: 'public',
      payload: { hunter: hunterSeatId, target: targetSeatId },
    });
  }

  /** Record last words as a public event. */
  recordLastWords(seatId: string, text: string): void {
    const runtime = this.getRuntime();
    this.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'last_words',
      scope: 'public',
      payload: { seatId, text },
    });
  }

  /** Record a speech during discussion as a public event. */
  recordSpeech(seatId: string, text: string): void {
    const runtime = this.getRuntime();
    this.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'speech',
      scope: 'public',
      payload: { seatId, text },
    });
  }

  /** Apply exile logic: idiot survives (revealed), others die. */
  private applyExile(seatId: string): void {
    const runtime = this.getRuntime();
    const seat = runtime.seats.find((s) => s.seatId === seatId);
    if (!seat) throw new Error(`Seat ${seatId} not found`);

    if (seat.role === 'idiot') {
      seat.properties.idiotRevealed = true;
    } else {
      seat.alive = false;
    }
  }

  /** Check win condition. Returns 'wolf', 'village', or null. */
  override checkWinCondition(): 'wolf' | 'village' | null {
    const runtime = this.getRuntime();
    const roles = runtime.definition.roles;

    const aliveSeats = runtime.seats.filter((s) => s.alive);

    const wolfRoles = new Set(roles.filter((r) => r.faction === 'wolf').map((r) => r.name));

    const aliveWolves = aliveSeats.filter((s) => wolfRoles.has(s.role));
    const aliveGood = aliveSeats.filter((s) => !wolfRoles.has(s.role));

    if (aliveWolves.length === 0) return 'village';
    if (aliveWolves.length >= aliveGood.length) return 'wolf';

    return null;
  }

  /** Check if witch heal is valid (self-heal only round 1) */
  private isHealValid(): boolean {
    const runtime = this.getRuntime();
    const healed = this.nightActions.heal?.target;
    const healerSeatId = this.nightActions.heal?.by;

    if (!healed || !healerSeatId) return false;

    // Self-heal only allowed on round 1
    if (healed === healerSeatId && runtime.round > 1) {
      return false;
    }

    return true;
  }
}
