import type { ProactiveIntent } from '@cat-cafe/shared';
import { getCatLifeConfig } from './cat-life-operations.js';
import type { OwnedSeedRecord, PrivateSeedDecisionResult } from './private-seed-contract.js';
import { decidePrivateSeed } from './private-seed-operations.js';
import type {
  ProactiveIntentRecord,
  ProactiveSettlementState,
  ProactiveVisibilityBlock,
  ProactiveVisitRecord,
} from './proactive-relationship-contract.js';
import { householdLocalDateAt, quietHoursActiveAt } from './proactive-time.js';
import type { AutoDreamStoreContext } from './store-context.js';
import { insertAutoDreamEvent } from './store-context.js';
import { rowToOwnedSeed, rowToProactiveIntent, rowToProactiveVisit } from './store-rows.js';
import {
  AutoDreamStoreError,
  type CatLifeConfigRecord,
  type InvocationPrincipal,
  type SettlePresentLoopValue,
} from './store-types.js';

type DbRow = Record<string, unknown>;

export interface ProactiveSettlementIds {
  seedId?: string;
  intentId?: string;
  visitId?: string;
  visibilityBlock?: ProactiveVisibilityBlock;
}

export function settleProactiveRelationship(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  input: SettlePresentLoopValue,
): ProactiveSettlementIds {
  if (!input.seedDecision && !input.intent) return {};
  const config = requireProactiveHome(context, principal);
  const seedDecision = decideSettlementSeed(context, principal, input);
  if (!input.intent) return { seedId: seedDecision?.seed?.seedId };

  const seed = resolveIntentSeed(context, principal, input.intent, seedDecision);
  const now = context.now();
  const intent = recordIntent(context, principal, input.runId, seed.seedId, input.intent, now);
  if (input.intent.kind === 'silence') return { seedId: seed.seedId, intentId: intent.intentId };

  return reserveVisibleIntent(context, principal, config, input.runId, seed.seedId, intent, input.intent, now);
}

function requireProactiveHome(context: AutoDreamStoreContext, principal: InvocationPrincipal): CatLifeConfigRecord {
  const config = getCatLifeConfig(context, principal.userId, principal.catId);
  if (!config) throw new AutoDreamStoreError('CAT_NOT_FOUND', 'cat life config not found', 404);
  if (!config.enabled) throw new AutoDreamStoreError('CAT_DISABLED', 'cat life config is disabled', 409);
  if (principal.threadId !== config.bedroomThreadId) {
    throw new AutoDreamStoreError(
      'PROACTIVE_HOME_MISMATCH',
      'proactive relationship work must settle from the configured stable home thread',
      409,
    );
  }
  return config;
}

function decideSettlementSeed(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  input: SettlePresentLoopValue,
): PrivateSeedDecisionResult | null {
  if (!input.seedDecision) return null;
  const result = decidePrivateSeed(context, principal, { runId: input.runId, decision: input.seedDecision });
  insertAutoDreamEvent(context, principal.userId, principal.catId, input.runId, 'private_seed_decided', {
    cueId: result.cue?.cueId,
    seedId: result.seed?.seedId,
    decisionKind: input.seedDecision.kind,
    outcome: result.seed ? 'owned' : result.cue?.status,
  });
  return result;
}

function resolveIntentSeed(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  intent: ProactiveIntent,
  seedDecision: PrivateSeedDecisionResult | null,
): OwnedSeedRecord {
  const seed =
    intent.seedRef.kind === 'decision'
      ? seedDecision?.seed
      : requireAvailableSeed(context, principal.userId, principal.catId, intent.seedRef.seedId);
  if (!seed) {
    throw new AutoDreamStoreError(
      'INVALID_PROACTIVE_INTENT',
      'proactive intent requires an owned seed from this settlement',
      409,
    );
  }
  return seed;
}

function recordIntent(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  seedId: string,
  input: ProactiveIntent,
  now: number,
): ProactiveIntentRecord {
  const intentId = context.idFactory('intent_');
  const silent = input.kind === 'silence';
  context.db
    .prepare(
      `INSERT INTO proactive_intents (
         intent_id, owner_user_id, cat_id, run_id, seed_id, status,
         visibility_kind, expression_kind, first_action_kind, first_action_summary,
         first_action_artifact_ref, visibility_block_reason, settled_at,
         created_by_invocation_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      intentId,
      principal.userId,
      principal.catId,
      runId,
      seedId,
      silent ? 'settled_silent' : 'ready',
      input.kind,
      input.expressionKind,
      input.firstAction.kind,
      input.firstAction.summary,
      input.firstAction.artifactRef ?? null,
      silent ? now : null,
      principal.invocationId,
      now,
      now,
    );
  insertAutoDreamEvent(context, principal.userId, principal.catId, runId, 'proactive_intent_recorded', {
    intentId,
    seedId,
    expressionKind: input.expressionKind,
    outcome: silent ? 'silent' : 'ready',
  });
  return requireProactiveIntent(context, principal.userId, principal.catId, intentId);
}

function reserveVisibleIntent(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  config: CatLifeConfigRecord,
  runId: string,
  seedId: string,
  intentRecord: ProactiveIntentRecord,
  input: Exclude<ProactiveIntent, { kind: 'silence' }>,
  now: number,
): ProactiveSettlementIds {
  const householdLocalDate = householdLocalDateAt(now, config.settings.timezone);
  if (quietHoursActiveAt(now, config.settings.timezone, config.settings.quietHours)) {
    blockIntent(context, principal, runId, intentRecord.intentId, 'quiet_hours', now);
    return { seedId, intentId: intentRecord.intentId, visibilityBlock: 'quiet_hours' };
  }

  const visit = reserveVisit(
    context,
    principal,
    runId,
    intentRecord.intentId,
    seedId,
    input,
    config.bedroomThreadId,
    householdLocalDate,
    now,
  );
  if (!visit) {
    blockIntent(context, principal, runId, intentRecord.intentId, 'budget_exhausted', now);
    return { seedId, intentId: intentRecord.intentId, visibilityBlock: 'budget_exhausted' };
  }
  return { seedId, intentId: intentRecord.intentId, visitId: visit.visitId };
}

export function loadProactiveSettlementState(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  runId: string,
): ProactiveSettlementState {
  const intentRow = context.db
    .prepare('SELECT * FROM proactive_intents WHERE owner_user_id = ? AND run_id = ?')
    .get(ownerUserId, runId) as DbRow | undefined;
  const seedRow = context.db
    .prepare('SELECT * FROM owned_seeds WHERE owner_user_id = ? AND source_run_id = ?')
    .get(ownerUserId, runId) as DbRow | undefined;
  const intent = intentRow ? rowToProactiveIntent(intentRow) : null;
  const seed = intent
    ? requireAvailableOrHistoricalSeed(context, intent.ownerUserId, intent.catId, intent.seedId)
    : seedRow
      ? rowToOwnedSeed(seedRow)
      : null;
  const visitRow = intent
    ? (context.db
        .prepare('SELECT * FROM proactive_visits WHERE owner_user_id = ? AND intent_id = ?')
        .get(ownerUserId, intent.intentId) as DbRow | undefined)
    : undefined;
  return {
    seed,
    intent,
    visit: visitRow ? rowToProactiveVisit(visitRow) : null,
    visibilityBlock: intent?.visibilityBlock ?? null,
  };
}

export function requireProactiveIntent(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  intentId: string,
): ProactiveIntentRecord {
  const row = context.db
    .prepare('SELECT * FROM proactive_intents WHERE owner_user_id = ? AND cat_id = ? AND intent_id = ?')
    .get(ownerUserId, catId, intentId) as DbRow | undefined;
  if (!row) throw proactiveIntentNotFound();
  return rowToProactiveIntent(row);
}

export function requireProactiveVisit(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  visitId: string,
): ProactiveVisitRecord {
  const row = context.db
    .prepare('SELECT * FROM proactive_visits WHERE owner_user_id = ? AND cat_id = ? AND visit_id = ?')
    .get(ownerUserId, catId, visitId) as DbRow | undefined;
  if (!row) throw new AutoDreamStoreError('PROACTIVE_VISIT_NOT_FOUND', 'proactive visit not found', 404);
  return rowToProactiveVisit(row);
}

function reserveVisit(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  intentId: string,
  seedId: string,
  intent: Exclude<ProactiveIntent, { kind: 'silence' }>,
  homeThreadId: string,
  householdLocalDate: string,
  now: number,
): ProactiveVisitRecord | null {
  context.db
    .prepare(
      `INSERT INTO foreground_visit_budget_days (owner_user_id, household_local_date, active_claims, updated_at)
       VALUES (?, ?, 0, ?) ON CONFLICT(owner_user_id, household_local_date) DO NOTHING`,
    )
    .run(principal.userId, householdLocalDate, now);
  const claimed = context.db
    .prepare(
      `UPDATE foreground_visit_budget_days
       SET active_claims = active_claims + 1, updated_at = ?
       WHERE owner_user_id = ? AND household_local_date = ? AND active_claims < ?`,
    )
    .run(now, principal.userId, householdLocalDate, context.foregroundVisitBudget);
  if (claimed.changes !== 1) return null;

  const visitId = context.idFactory('visit_');
  context.db
    .prepare(
      `INSERT INTO proactive_visits (
         visit_id, owner_user_id, cat_id, run_id, intent_id, seed_id,
         expression_kind, status, household_local_date, budget_claim_state,
         home_thread_id, pending_message_body, projected_surfaces_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, 'claimed', ?, ?, '[]', ?, ?)`,
    )
    .run(
      visitId,
      principal.userId,
      principal.catId,
      runId,
      intentId,
      seedId,
      intent.expressionKind,
      householdLocalDate,
      homeThreadId,
      intent.kind === 'message' ? intent.message.body : null,
      now,
      now,
    );
  context.db
    .prepare(
      `INSERT INTO foreground_visit_budget_claims (
         owner_user_id, household_local_date, visit_id, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'claimed', ?, ?)`,
    )
    .run(principal.userId, householdLocalDate, visitId, now, now);
  context.db
    .prepare(
      `UPDATE proactive_intents SET status = 'visit_reserved', visibility_block_reason = NULL, updated_at = ?
       WHERE owner_user_id = ? AND intent_id = ? AND status = 'ready'`,
    )
    .run(now, principal.userId, intentId);
  insertAutoDreamEvent(context, principal.userId, principal.catId, runId, 'proactive_visit_reserved', {
    intentId,
    visitId,
    seedId,
    expressionKind: intent.expressionKind,
    outcome: 'reserved',
  });
  return requireProactiveVisit(context, principal.userId, principal.catId, visitId);
}

function blockIntent(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  intentId: string,
  reason: ProactiveVisibilityBlock,
  now: number,
): void {
  context.db
    .prepare(
      `UPDATE proactive_intents SET visibility_block_reason = ?, updated_at = ?
       WHERE owner_user_id = ? AND intent_id = ? AND status = 'ready'`,
    )
    .run(reason, now, principal.userId, intentId);
  insertAutoDreamEvent(context, principal.userId, principal.catId, runId, 'proactive_visibility_blocked', {
    intentId,
    outcome: reason,
  });
}

function requireAvailableSeed(context: AutoDreamStoreContext, ownerUserId: string, catId: string, seedId: string) {
  const seed = requireAvailableOrHistoricalSeed(context, ownerUserId, catId, seedId);
  if (seed.status !== 'owned') {
    throw new AutoDreamStoreError('OWNED_SEED_NOT_AVAILABLE', 'owned seed is not available for a new intent', 409);
  }
  return seed;
}

function requireAvailableOrHistoricalSeed(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  seedId: string,
) {
  const row = context.db
    .prepare('SELECT * FROM owned_seeds WHERE owner_user_id = ? AND cat_id = ? AND seed_id = ?')
    .get(ownerUserId, catId, seedId) as DbRow | undefined;
  if (!row) throw new AutoDreamStoreError('OWNED_SEED_NOT_FOUND', 'owned seed not found', 404);
  return rowToOwnedSeed(row);
}

function proactiveIntentNotFound(): AutoDreamStoreError {
  return new AutoDreamStoreError('PROACTIVE_INTENT_NOT_FOUND', 'proactive intent not found', 404);
}
