/**
 * F260: Shared entity nudge state — single lifecycle owner for both
 * route-serial and route-parallel strategies.
 *
 * Both strategies share cooldown, event, and F282 receipt instances so a
 * route-mode change cannot reset operational suppression.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type Database from 'better-sqlite3';
import { EntityNudgeCooldown } from './EntityNudgeCooldown.js';
import { EntityNudgeEventStore } from './EntityNudgeEventStore.js';
import { ProactiveCandidateNudgeReceiptStore } from './ProactiveCandidateNudgeReceiptStore.js';

let _cooldown: EntityNudgeCooldown | undefined;
let _eventStore: EntityNudgeEventStore | undefined;
let _proactiveReceiptStore: ProactiveCandidateNudgeReceiptStore | undefined;

/**
 * Shared EntityNudgeCooldown singleton — cooldown records are continuous
 * across serial/parallel route strategies.
 */
export function sharedNudgeCooldown(): EntityNudgeCooldown {
  if (!_cooldown) _cooldown = new EntityNudgeCooldown();
  return _cooldown;
}

/**
 * Shared EntityNudgeEventStore singleton — AC-B5 outcome tracking
 * is continuous across serial/parallel route strategies.
 * Records delivered/suppressed events for queryable outcome analysis.
 */
export function sharedEventStore(db: Database.Database): EntityNudgeEventStore {
  if (!_eventStore) _eventStore = new EntityNudgeEventStore(db);
  return _eventStore;
}

export function sharedProactiveCandidateNudgeReceiptStore(db: Database.Database): ProactiveCandidateNudgeReceiptStore {
  if (!_proactiveReceiptStore) _proactiveReceiptStore = new ProactiveCandidateNudgeReceiptStore(db);
  return _proactiveReceiptStore;
}

/** Reset shared state — test-only. */
export function _resetSharedNudgeState(): void {
  _cooldown = undefined;
  _eventStore = undefined;
  _proactiveReceiptStore = undefined;
}
