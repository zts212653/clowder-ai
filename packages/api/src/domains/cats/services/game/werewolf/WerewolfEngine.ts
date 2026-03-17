/**
 * WerewolfEngine (F101 Tasks B2+B3)
 *
 * Extends GameEngine with werewolf-specific night/day resolution and win conditions.
 * Night: 同守同救, witch self-heal rules, hunter can-shoot, guard consecutive restriction.
 * Day: vote, PK, exile, hunter shoot, idiot reveal, speeches, last words.
 */

import type { Ballot, Resolution } from '@cat-cafe/shared';

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
  private nightBallots: Map<string, Ballot> = new Map();
  private dayBallots: Map<string, Ballot> = new Map();
  private votes: Map<string, string> = new Map();

  /** Submit a wolf kill ballot (multi-wolf independent voting). */
  submitNightBallot(wolfSeatId: string, targetSeatId: string): void {
    const existing = this.nightBallots.get(wolfSeatId);
    const revision = existing ? existing.revision + 1 : 1;
    this.nightBallots.set(wolfSeatId, {
      voterSeat: wolfSeatId,
      choice: targetSeatId,
      revision,
      locked: false,
      source: 'llm',
      submittedAt: Date.now(),
    });
  }

  /** Resolve wolf kill ballots by majority. Tie → no_kill. Clears ballots after. */
  resolveNightBallots(): Resolution {
    const tally = new Map<string, number>();
    for (const ballot of this.nightBallots.values()) {
      if (ballot.choice) {
        tally.set(ballot.choice, (tally.get(ballot.choice) ?? 0) + 1);
      }
    }
    this.nightBallots.clear();

    if (tally.size === 0) {
      return { winningChoice: null, tiePolicy: 'no_kill', revoteCount: 0, fallbackApplied: false };
    }

    const maxVotes = Math.max(...tally.values());
    const topCandidates = [...tally.entries()].filter(([, count]) => count === maxVotes).map(([seatId]) => seatId);

    if (topCandidates.length !== 1) {
      // Tie → no_kill (KD-25)
      return { winningChoice: null, tiePolicy: 'no_kill', revoteCount: 0, fallbackApplied: false };
    }

    return {
      winningChoice: topCandidates[0]!,
      tiePolicy: 'no_kill',
      revoteCount: 0,
      fallbackApplied: false,
    };
  }

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

    // Multi-wolf ballot takes priority; fallback to legacy setNightAction kill
    let knifed: string | undefined;
    if (this.nightBallots.size > 0) {
      const ballotResult = this.resolveNightBallots();
      knifed = ballotResult.winningChoice ?? undefined;
    } else {
      knifed = this.nightActions.kill?.target;
    }
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

  /** Legacy: Cast a vote (simple Map-based). Use castDayVote for ballot-based. */
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

  /** Ballot-based day vote with revision tracking (Phase F). */
  castDayVote(voterSeatId: string, targetSeatId: string): void {
    const runtime = this.getRuntime();
    const voter = runtime.seats.find((s) => s.seatId === voterSeatId);
    if (!voter) throw new Error(`Seat ${voterSeatId} not found`);
    if (!voter.alive) throw new Error(`${voterSeatId} is not alive, cannot vote`);
    if (voter.properties.idiotRevealed) {
      throw new Error(`${voterSeatId} is revealed idiot, cannot vote`);
    }

    const existing = this.dayBallots.get(voterSeatId);
    if (existing?.locked) {
      throw new Error(`${voterSeatId} vote is locked, cannot change`);
    }

    const revision = existing ? existing.revision + 1 : 1;
    this.dayBallots.set(voterSeatId, {
      voterSeat: voterSeatId,
      choice: targetSeatId,
      revision,
      locked: false,
      source: voter.actorType === 'human' ? 'player' : 'llm',
      submittedAt: Date.now(),
    });

    // Log ballot.updated event (KD-26: 实名公开)
    this.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'ballot.updated',
      scope: 'public',
      payload: { voterSeat: voterSeatId, choice: targetSeatId, revision },
      revealPolicy: 'live',
    });
  }

  /** Feed a day ballot without emitting events (for resolution reconstruction) */
  feedDayBallotSilent(voterSeatId: string, targetSeatId: string): void {
    this.dayBallots.set(voterSeatId, {
      voterSeat: voterSeatId,
      choice: targetSeatId,
      revision: 1,
      locked: false,
      source: 'llm',
      submittedAt: Date.now(),
    });
  }

  /** Get day ballot for a seat */
  getDayBallot(seatId: string): Ballot | undefined {
    return this.dayBallots.get(seatId);
  }

  /** Lock a day vote — prevents further changes */
  lockDayVote(voterSeatId: string): void {
    const ballot = this.dayBallots.get(voterSeatId);
    if (!ballot) throw new Error(`${voterSeatId} has no ballot to lock`);
    ballot.locked = true;

    const runtime = this.getRuntime();
    this.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'ballot.locked',
      scope: 'public',
      payload: { voterSeat: voterSeatId, choice: ballot.choice },
    });
  }

  /** Check if all alive non-revealed-idiot seats have locked ballots */
  allDayVotesLocked(): boolean {
    const runtime = this.getRuntime();
    const eligibleSeats = runtime.seats.filter((s) => s.alive && !s.properties.idiotRevealed);
    return eligibleSeats.every((s) => {
      const ballot = this.dayBallots.get(s.seatId);
      return ballot?.locked === true;
    });
  }

  /** Resolve ballot-based day votes → exile or tie */
  resolveDayVotes(): VoteResult {
    const tally = new Map<string, number>();
    for (const ballot of this.dayBallots.values()) {
      if (ballot.choice) {
        tally.set(ballot.choice, (tally.get(ballot.choice) ?? 0) + 1);
      }
    }
    this.dayBallots.clear();

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

  /** Legacy: Resolve votes → exile or tie. Clears vote map after resolution. */
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
