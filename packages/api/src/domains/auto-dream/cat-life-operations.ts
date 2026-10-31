import { CAT_LIFE_COST_BANDS, catLifeSettingsInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { AutoDreamStoreContext } from './store-context.js';
import {
  AutoDreamStoreError,
  type CatLifeConfigRecord,
  type CatLifeDerivedValue,
  type CatLifePreviewDecisionResult,
  type CatLifePreviewRecord,
  type CreateCatLifePreviewInput,
} from './store-types.js';

type DbRow = Record<string, unknown>;

const derivedSchema = z
  .object({
    cronExpression: z.string().trim().min(1).max(200),
    nextWakeAt: z.number().int().nonnegative().nullable(),
    weeklyWakeCount: z.number().int().min(0).max(7),
    costBand: z.enum(CAT_LIFE_COST_BANDS),
    costNotice: z.string().trim().min(1).max(500),
  })
  .strict();

export function getCatLifeConfig(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
): CatLifeConfigRecord | null {
  const row = context.db
    .prepare('SELECT * FROM cat_life_configs WHERE owner_user_id = ? AND cat_id = ?')
    .get(ownerUserId, catId) as DbRow | undefined;
  return row ? rowToConfig(row) : null;
}

export function listCatLifeConfigs(context: AutoDreamStoreContext, ownerUserId: string): CatLifeConfigRecord[] {
  const rows = context.db
    .prepare('SELECT * FROM cat_life_configs WHERE owner_user_id = ? ORDER BY created_at, cat_id')
    .all(ownerUserId) as DbRow[];
  return rows.map(rowToConfig);
}

export function getCatLifePreview(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  previewId: string,
): CatLifePreviewRecord {
  return requirePreview(context, ownerUserId, previewId);
}

export function createCatLifePreview(
  context: AutoDreamStoreContext,
  input: CreateCatLifePreviewInput,
): CatLifePreviewRecord {
  const settings = catLifeSettingsInputSchema.safeParse(input.settings);
  const derived = derivedSchema.safeParse(input.derived);
  if (!settings.success || !derived.success) {
    const details = !settings.success
      ? settings.error.message
      : derived.success
        ? 'unknown error'
        : derived.error.message;
    throw new AutoDreamStoreError('INVALID_CAT_LIFE_SETTINGS', `invalid cat life preview: ${details}`, 400);
  }
  for (const [field, value] of [
    ['ownerUserId', input.ownerUserId],
    ['catId', input.catId],
    ['bedroomThreadId', input.bedroomThreadId],
    ['projectionTaskId', input.projectionTaskId],
  ] as const) {
    if (!value.trim()) {
      throw new AutoDreamStoreError('INVALID_CAT_LIFE_SETTINGS', `${field} is required`, 400);
    }
  }
  const now = context.now();
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
    throw new AutoDreamStoreError('INVALID_CAT_LIFE_SETTINGS', 'expiresAt must be in the future', 400);
  }
  const previewId = context.idFactory('lifepreview_');
  context.db
    .prepare(
      `INSERT INTO cat_life_previews (
         preview_id, owner_user_id, cat_id, settings_json, derived_json,
         bedroom_thread_id, projection_task_id, status, expires_at,
         decision_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'rendered', ?, NULL, ?, ?)`,
    )
    .run(
      previewId,
      input.ownerUserId,
      input.catId,
      JSON.stringify(settings.data),
      JSON.stringify(derived.data),
      input.bedroomThreadId,
      input.projectionTaskId,
      input.expiresAt,
      now,
      now,
    );
  return requirePreview(context, input.ownerUserId, previewId);
}

export function decideCatLifePreview(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  previewId: string,
  decision: 'confirm' | 'cancel',
): CatLifePreviewDecisionResult {
  const preview = requirePreview(context, ownerUserId, previewId);
  if (preview.status === 'expired') throw previewExpired();
  if (preview.status === 'confirmed') {
    if (decision !== 'confirm') throw previewAlreadyDecided(preview.status);
    return {
      preview,
      config: getCatLifeConfig(context, ownerUserId, preview.catId),
      applied: false,
    };
  }
  if (preview.status === 'cancelled') {
    if (decision !== 'cancel') throw previewAlreadyDecided(preview.status);
    return { preview, config: null, applied: false };
  }

  const now = context.now();
  if (preview.expiresAt <= now) {
    context.db
      .prepare(
        `UPDATE cat_life_previews
         SET status = 'expired', decision_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND preview_id = ? AND status = 'rendered'`,
      )
      .run(now, now, ownerUserId, previewId);
    throw previewExpired();
  }

  if (decision === 'cancel') {
    context.db
      .prepare(
        `UPDATE cat_life_previews
         SET status = 'cancelled', decision_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND preview_id = ? AND status = 'rendered'`,
      )
      .run(now, now, ownerUserId, previewId);
    return { preview: requirePreview(context, ownerUserId, previewId), config: null, applied: true };
  }

  context.db.transaction(() => {
    const claimed = context.db
      .prepare(
        `UPDATE cat_life_previews
         SET status = 'confirmed', decision_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND preview_id = ? AND status = 'rendered'`,
      )
      .run(now, now, ownerUserId, previewId);
    if (claimed.changes !== 1) throw previewAlreadyDecided('terminal');
    context.db
      .prepare(
        `INSERT INTO cat_life_configs (
           owner_user_id, cat_id, enabled, settings_json, derived_json,
           bedroom_thread_id, projection_task_id, projection_status,
           projection_error, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 1, ?, ?)
         ON CONFLICT(owner_user_id, cat_id) DO UPDATE SET
           enabled = excluded.enabled,
           settings_json = excluded.settings_json,
           derived_json = excluded.derived_json,
           bedroom_thread_id = excluded.bedroom_thread_id,
           projection_task_id = excluded.projection_task_id,
           projection_status = 'pending',
           projection_error = NULL,
           revision = cat_life_configs.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        ownerUserId,
        preview.catId,
        preview.settings.enabled ? 1 : 0,
        JSON.stringify(preview.settings),
        JSON.stringify(preview.derived),
        preview.bedroomThreadId,
        preview.projectionTaskId,
        now,
        now,
      );
  })();

  return {
    preview: requirePreview(context, ownerUserId, previewId),
    config: getCatLifeConfig(context, ownerUserId, preview.catId),
    applied: true,
  };
}

export function markCatLifeProjection(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  result: { status: 'ready'; error?: never } | { status: 'error'; error: string },
): CatLifeConfigRecord | null {
  context.db
    .prepare(
      `UPDATE cat_life_configs
       SET projection_status = ?, projection_error = ?, updated_at = ?
       WHERE owner_user_id = ? AND cat_id = ?`,
    )
    .run(
      result.status,
      result.status === 'error' ? result.error.slice(0, 2_000) : null,
      context.now(),
      ownerUserId,
      catId,
    );
  return getCatLifeConfig(context, ownerUserId, catId);
}

function requirePreview(context: AutoDreamStoreContext, ownerUserId: string, previewId: string): CatLifePreviewRecord {
  const row = context.db
    .prepare('SELECT * FROM cat_life_previews WHERE owner_user_id = ? AND preview_id = ?')
    .get(ownerUserId, previewId) as DbRow | undefined;
  if (!row) throw new AutoDreamStoreError('PREVIEW_NOT_FOUND', 'cat life preview not found', 404);
  return rowToPreview(row);
}

function rowToConfig(row: DbRow): CatLifeConfigRecord {
  return {
    ownerUserId: readString(row.owner_user_id),
    catId: readString(row.cat_id),
    enabled: Number(row.enabled) === 1,
    settings: parseSettings(row.settings_json),
    derived: parseDerived(row.derived_json),
    bedroomThreadId: readString(row.bedroom_thread_id),
    projectionTaskId: readString(row.projection_task_id),
    projectionStatus: readString(row.projection_status) as CatLifeConfigRecord['projectionStatus'],
    projectionError: readOptionalString(row.projection_error),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToPreview(row: DbRow): CatLifePreviewRecord {
  return {
    previewId: readString(row.preview_id),
    ownerUserId: readString(row.owner_user_id),
    catId: readString(row.cat_id),
    settings: parseSettings(row.settings_json),
    derived: parseDerived(row.derived_json),
    bedroomThreadId: readString(row.bedroom_thread_id),
    projectionTaskId: readString(row.projection_task_id),
    status: readString(row.status) as CatLifePreviewRecord['status'],
    expiresAt: Number(row.expires_at),
    decisionAt: row.decision_at === null ? undefined : Number(row.decision_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function parseSettings(value: unknown): CatLifePreviewRecord['settings'] {
  const parsed = catLifeSettingsInputSchema.safeParse(parseJson(value));
  if (!parsed.success) throw new Error('cat_life settings_json is invalid');
  return parsed.data;
}

function parseDerived(value: unknown): CatLifeDerivedValue {
  const parsed = derivedSchema.safeParse(parseJson(value));
  if (!parsed.success) throw new Error('cat_life derived_json is invalid');
  return parsed.data;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function previewExpired(): AutoDreamStoreError {
  return new AutoDreamStoreError('PREVIEW_EXPIRED', 'cat life preview expired; render a new preview', 409);
}

function previewAlreadyDecided(status: string): AutoDreamStoreError {
  return new AutoDreamStoreError(
    'PREVIEW_ALREADY_DECIDED',
    `cat life preview is already ${status}; render a new preview`,
    409,
  );
}
