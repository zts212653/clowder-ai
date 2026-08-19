import { type SeedDecision, seedDecisionSchema } from '@cat-cafe/shared';
import {
  type F255PendingCueInput,
  type F255PendingCueReceipt,
  f255PendingCueInputSchema,
  type OwnedSeedListOptions,
  type OwnedSeedRecord,
  type PrivateCueListOptions,
  type PrivateCueRecord,
  type PrivateSeedDecisionInput,
  type PrivateSeedDecisionResult,
} from './private-seed-contract.js';
import type { AutoDreamStoreContext } from './store-context.js';
import { hashValue, rowToOwnedSeed, rowToPrivateCue, stringValue } from './store-rows.js';
import { AutoDreamStoreError, type InvocationPrincipal } from './store-types.js';

type DbRow = Record<string, unknown>;

const CUE_STATUSES = new Set(['pending', 'adopted', 'rejected']);
const SEED_STATUSES = new Set(['owned', 'dormant', 'retired']);

export function ingestPendingCue(context: AutoDreamStoreContext, rawInput: F255PendingCueInput): F255PendingCueReceipt {
  const parsed = f255PendingCueInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidPrivateCue(parsed.error.message);
  const input = parsed.data;
  const inputHash = hashValue(input);

  return context.db.transaction(() => {
    const existing = context.db
      .prepare(
        `SELECT cue_id, input_hash FROM private_cues
         WHERE owner_user_id = ? AND producer = ? AND source_output_id = ?`,
      )
      .get(input.ownerUserId, input.producer, input.outputId) as DbRow | undefined;
    if (existing) {
      if (stringValue(existing.input_hash) !== inputHash) {
        throw new AutoDreamStoreError(
          'PRIVATE_CUE_CONFLICT',
          'pending cue outputId was reused with a conflicting payload',
          409,
        );
      }
      return { cueId: stringValue(existing.cue_id) };
    }

    const now = context.now();
    const cueId = context.idFactory('cue_');
    context.db
      .prepare(
        `INSERT INTO private_cues (
           cue_id, owner_user_id, cat_id, kind, normalized_claim, reason,
           source_ref_json, producer, source_output_id, source_created_at,
           input_hash, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'desire_cue', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        cueId,
        input.ownerUserId,
        input.catId,
        input.normalizedClaim,
        input.reason,
        JSON.stringify(input.sourceRef),
        input.producer,
        input.outputId,
        input.createdAt,
        inputHash,
        now,
        now,
      );
    return { cueId };
  })();
}

export function listPrivateCues(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  options: PrivateCueListOptions = {},
): PrivateCueRecord[] {
  if (options.status && !CUE_STATUSES.has(options.status)) throw invalidPrivateCue('invalid cue status');
  const limit = boundedLimit(options.limit);
  const rows = options.status
    ? (context.db
        .prepare(
          `SELECT * FROM private_cues
           WHERE owner_user_id = ? AND cat_id = ? AND status = ?
           ORDER BY created_at, cue_id LIMIT ?`,
        )
        .all(ownerUserId, catId, options.status, limit) as DbRow[])
    : (context.db
        .prepare(
          `SELECT * FROM private_cues
           WHERE owner_user_id = ? AND cat_id = ?
           ORDER BY created_at, cue_id LIMIT ?`,
        )
        .all(ownerUserId, catId, limit) as DbRow[]);
  return rows.map(rowToPrivateCue);
}

export function listOwnedSeeds(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  options: OwnedSeedListOptions = {},
): OwnedSeedRecord[] {
  if (options.status && !SEED_STATUSES.has(options.status)) throw invalidSeedDecision('invalid seed status');
  const limit = boundedLimit(options.limit);
  const rows = options.status
    ? (context.db
        .prepare(
          `SELECT * FROM owned_seeds
           WHERE owner_user_id = ? AND cat_id = ? AND status = ?
           ORDER BY created_at, seed_id LIMIT ?`,
        )
        .all(ownerUserId, catId, options.status, limit) as DbRow[])
    : (context.db
        .prepare(
          `SELECT * FROM owned_seeds
           WHERE owner_user_id = ? AND cat_id = ?
           ORDER BY created_at, seed_id LIMIT ?`,
        )
        .all(ownerUserId, catId, limit) as DbRow[]);
  return rows.map(rowToOwnedSeed);
}

export function decidePrivateSeed(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  rawInput: PrivateSeedDecisionInput,
): PrivateSeedDecisionResult {
  const runId = typeof rawInput.runId === 'string' ? rawInput.runId.trim() : '';
  const parsed = seedDecisionSchema.safeParse(rawInput.decision);
  if (!runId || !parsed.success) throw invalidSeedDecision(parsed.success ? 'runId is required' : parsed.error.message);

  return context.db.transaction(() => {
    requireLiveRun(context, principal, runId, parsed.data);
    return parsed.data.kind === 'originate'
      ? originateSeed(context, principal, runId, parsed.data)
      : decideCue(context, principal, runId, parsed.data);
  })();
}

function requireLiveRun(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  decision: SeedDecision,
): void {
  const row = context.db
    .prepare('SELECT owner_user_id, cat_id, thread_id, state FROM present_loop_runs WHERE run_id = ?')
    .get(runId) as DbRow | undefined;
  const matches =
    row &&
    stringValue(row.owner_user_id) === principal.userId &&
    stringValue(row.cat_id) === principal.catId &&
    stringValue(row.thread_id) === principal.threadId;
  if (!matches) {
    if (decision.kind !== 'originate') throw privateCueNotFound();
    throw invalidSeedDecision('matching live Present Loop run not found');
  }
  if (stringValue(row.state) !== 'awakened') throw invalidSeedDecision('Present Loop run is not live');
}

function decideCue(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  decision: Exclude<SeedDecision, { kind: 'originate' }>,
): PrivateSeedDecisionResult {
  const raw = context.db
    .prepare('SELECT * FROM private_cues WHERE owner_user_id = ? AND cat_id = ? AND cue_id = ?')
    .get(principal.userId, principal.catId, decision.cueId) as DbRow | undefined;
  if (!raw) throw privateCueNotFound();
  const cue = rowToPrivateCue(raw);
  if (cue.status !== 'pending') return replayCueDecision(context, cue, runId, decision);

  const now = context.now();
  if (decision.kind === 'reject') {
    context.db
      .prepare(
        `UPDATE private_cues
         SET status = 'rejected', decided_by_run_id = ?, decided_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND cat_id = ? AND cue_id = ? AND status = 'pending'`,
      )
      .run(runId, now, now, principal.userId, principal.catId, cue.cueId);
    return { cue: requireCue(context, principal.userId, principal.catId, cue.cueId), seed: null };
  }

  const claim = decision.kind === 'adopt' ? cue.normalizedClaim : decision.claim;
  const seed = createSeed(context, principal, runId, claim, cue.cueId, now);
  context.db
    .prepare(
      `UPDATE private_cues
       SET status = 'adopted', decided_by_run_id = ?, owned_seed_id = ?, decided_at = ?, updated_at = ?
       WHERE owner_user_id = ? AND cat_id = ? AND cue_id = ? AND status = 'pending'`,
    )
    .run(runId, seed.seedId, now, now, principal.userId, principal.catId, cue.cueId);
  return { cue: requireCue(context, principal.userId, principal.catId, cue.cueId), seed };
}

function originateSeed(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  decision: Extract<SeedDecision, { kind: 'originate' }>,
): PrivateSeedDecisionResult {
  const now = context.now();
  return { cue: null, seed: createSeed(context, principal, runId, decision.claim, undefined, now) };
}

function createSeed(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  claim: string,
  sourceCueId: string | undefined,
  now: number,
): OwnedSeedRecord {
  const existing = context.db
    .prepare('SELECT * FROM owned_seeds WHERE owner_user_id = ? AND source_run_id = ?')
    .get(principal.userId, runId) as DbRow | undefined;
  if (existing) {
    const seed = rowToOwnedSeed(existing);
    if (seed.claim === claim && seed.sourceCueId === sourceCueId) return seed;
    throw invalidSeedDecision('Present Loop run already created a different owned seed');
  }

  const seedId = context.idFactory('seed_');
  context.db
    .prepare(
      `INSERT INTO owned_seeds (
         seed_id, owner_user_id, cat_id, source_kind, source_cue_id, claim,
         status, source_run_id, created_by_invocation_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'owned', ?, ?, ?, ?)`,
    )
    .run(
      seedId,
      principal.userId,
      principal.catId,
      sourceCueId ? 'cue' : 'originated',
      sourceCueId ?? null,
      claim,
      runId,
      principal.invocationId,
      now,
      now,
    );
  return requireSeed(context, principal.userId, principal.catId, seedId);
}

function replayCueDecision(
  context: AutoDreamStoreContext,
  cue: PrivateCueRecord,
  runId: string,
  decision: Exclude<SeedDecision, { kind: 'originate' }>,
): PrivateSeedDecisionResult {
  if (cue.decidedByRunId !== runId) throw cueAlreadyDecided();
  if (decision.kind === 'reject' && cue.status === 'rejected') return { cue, seed: null };
  if (cue.status !== 'adopted' || !cue.ownedSeedId) throw cueAlreadyDecided();
  if (decision.kind === 'reject') throw cueAlreadyDecided();
  const seed = requireSeed(context, cue.ownerUserId, cue.catId, cue.ownedSeedId);
  const expectedClaim = decision.kind === 'adopt' ? cue.normalizedClaim : decision.claim;
  if (seed.claim !== expectedClaim) throw cueAlreadyDecided();
  return { cue, seed };
}

function requireCue(context: AutoDreamStoreContext, ownerUserId: string, catId: string, cueId: string) {
  const row = context.db
    .prepare('SELECT * FROM private_cues WHERE owner_user_id = ? AND cat_id = ? AND cue_id = ?')
    .get(ownerUserId, catId, cueId) as DbRow | undefined;
  if (!row) throw privateCueNotFound();
  return rowToPrivateCue(row);
}

function requireSeed(context: AutoDreamStoreContext, ownerUserId: string, catId: string, seedId: string) {
  const row = context.db
    .prepare('SELECT * FROM owned_seeds WHERE owner_user_id = ? AND cat_id = ? AND seed_id = ?')
    .get(ownerUserId, catId, seedId) as DbRow | undefined;
  if (!row) throw new AutoDreamStoreError('OWNED_SEED_NOT_FOUND', 'owned seed not found', 404);
  return rowToOwnedSeed(row);
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isInteger(limit) || limit < 1) throw invalidPrivateCue('limit must be a positive integer');
  return Math.min(limit, 50);
}

function invalidPrivateCue(details: string): AutoDreamStoreError {
  return new AutoDreamStoreError('INVALID_PRIVATE_CUE', `invalid private cue: ${details}`, 400);
}

function invalidSeedDecision(details: string): AutoDreamStoreError {
  return new AutoDreamStoreError('INVALID_SEED_DECISION', `invalid seed decision: ${details}`, 409);
}

function privateCueNotFound(): AutoDreamStoreError {
  return new AutoDreamStoreError('PRIVATE_CUE_NOT_FOUND', 'private cue not found', 404);
}

function cueAlreadyDecided(): AutoDreamStoreError {
  return new AutoDreamStoreError('PRIVATE_CUE_ALREADY_DECIDED', 'private cue already decided', 409);
}
