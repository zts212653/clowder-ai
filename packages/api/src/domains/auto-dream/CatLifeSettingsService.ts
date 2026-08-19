import type { CatId, CatLifeSettingsInput, CatRoutingError } from '@cat-cafe/shared';
import type { DynamicTaskDef, DynamicTaskStore } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskTemplate } from '../../infrastructure/scheduler/templates/types.js';
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import { AutoDreamStore, AutoDreamStoreError, type CatLifeConfigRecord } from './AutoDreamStore.js';
import { catLifeBedroomThreadId, catLifeProjectionTaskId, deriveCatLifeSchedule } from './cat-life-schedule.js';

const DEFAULT_PREVIEW_TTL_MS = 15 * 60_000;
const MANAGED_BY = 'f255-cat-life';

interface ProjectionTaskRunner {
  unregister(taskId: string): boolean;
  registerDynamic(task: TaskSpec_P1, dynamicDefId: string): void;
}

interface TemplateGetter {
  get(templateId: string): TaskTemplate | null;
}

export interface CatLifeSettingsServiceOptions {
  store: AutoDreamStore;
  dynamicTaskStore: Pick<DynamicTaskStore, 'getAll' | 'setEnabled' | 'upsert'>;
  taskRunner: ProjectionTaskRunner;
  templateRegistry: TemplateGetter;
  threadStore: Pick<
    IThreadStore,
    'get' | 'ensureThread' | 'restore' | 'indexForUser' | 'addParticipants' | 'updatePreferredCats' | 'updateSystemKind'
  >;
  privateOwnerUserId: string;
  resolveCatTarget: (mentionOrId: string) => { ok: CatId } | { error: CatRoutingError };
  now?: () => number;
  previewTtlMs?: number;
}

export interface PublicCatLifeConfig {
  catId: string;
  enabled: boolean;
  rhythm: CatLifeSettingsInput['rhythm'];
  wakeTime: string;
  timezone: string;
  quietHours?: CatLifeSettingsInput['quietHours'];
  nextWakeAt: number | null;
  weeklyWakeCount: number;
  costBand: 'low' | 'medium' | 'high';
  costNotice: string;
  projectionStatus: 'pending' | 'ready' | 'error';
  projectionError?: string;
  revision: number;
}

export interface PublicCatLifePreview {
  previewId: string;
  catId: string;
  settings: CatLifeSettingsInput;
  nextWakeAt: number | null;
  weeklyWakeCount: number;
  costBand: 'low' | 'medium' | 'high';
  costNotice: string;
  expiresAt: number;
}

export class CatLifeSettingsService {
  private readonly now: () => number;
  private readonly previewTtlMs: number;
  private readonly catOperationTails = new Map<string, Promise<void>>();

  constructor(private readonly options: CatLifeSettingsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    if (!Number.isFinite(this.previewTtlMs) || this.previewTtlMs <= 0) {
      throw new Error('previewTtlMs must be a positive finite number');
    }
  }

  acceptsOwner(ownerUserId: string): boolean {
    return ownerUserId === this.options.privateOwnerUserId;
  }

  async getConfig(ownerUserId: string, catId: string): Promise<PublicCatLifeConfig | null> {
    this.requireOwner(ownerUserId);
    const canonicalCatId = this.resolveCatId(catId, true);
    const config = await this.options.store.getCatLifeConfig(ownerUserId, canonicalCatId);
    return config ? toPublicConfig(config, this.now()) : null;
  }

  async preview(ownerUserId: string, catId: string, settings: CatLifeSettingsInput): Promise<PublicCatLifePreview> {
    this.requireOwner(ownerUserId);
    const canonicalCatId = this.resolveCatId(catId);
    let derived: ReturnType<typeof deriveCatLifeSchedule>;
    try {
      derived = deriveCatLifeSchedule(settings, this.now());
    } catch (error) {
      throw new AutoDreamStoreError(
        'INVALID_CAT_LIFE_SETTINGS',
        error instanceof Error ? error.message : String(error),
        400,
      );
    }
    const preview = await this.options.store.createCatLifePreview({
      ownerUserId,
      catId: canonicalCatId,
      settings,
      derived,
      bedroomThreadId: catLifeBedroomThreadId(ownerUserId, canonicalCatId),
      projectionTaskId: catLifeProjectionTaskId(ownerUserId, canonicalCatId),
      expiresAt: this.now() + this.previewTtlMs,
    });
    return {
      previewId: preview.previewId,
      catId: preview.catId,
      settings: preview.settings,
      nextWakeAt: preview.derived.nextWakeAt,
      weeklyWakeCount: preview.derived.weeklyWakeCount,
      costBand: preview.derived.costBand,
      costNotice: preview.derived.costNotice,
      expiresAt: preview.expiresAt,
    };
  }

  async decide(ownerUserId: string, previewId: string, decision: 'confirm' | 'cancel') {
    this.requireOwner(ownerUserId);
    const preview = await this.options.store.getCatLifePreview(ownerUserId, previewId);
    return this.serializeCatOperation(ownerUserId, preview.catId, async () => {
      const decided = await this.options.store.decideCatLifePreview(ownerUserId, previewId, decision);
      if (!decided.config) return { status: decided.preview.status, config: null };
      const reconciled = await this.reconcileConfig(decided.config);
      return { status: decided.preview.status, config: toPublicConfig(reconciled, this.now()) };
    });
  }

  async reconcileAll(): Promise<{ reconciled: number; disabledOrphans: number; failed: number }> {
    const ownerUserId = this.options.privateOwnerUserId;
    const configs = await this.options.store.listCatLifeConfigs(ownerUserId);
    let reconciled = 0;
    let failed = 0;
    for (const listedConfig of configs) {
      try {
        const didReconcile = await this.serializeCatOperation(ownerUserId, listedConfig.catId, async () => {
          const currentConfig = await this.options.store.getCatLifeConfig(ownerUserId, listedConfig.catId);
          if (!currentConfig) return false;
          await this.reconcileConfig(currentConfig);
          return true;
        });
        if (didReconcile) reconciled++;
      } catch {
        failed++;
      }
    }

    const knownIds = new Set(configs.map((config) => config.projectionTaskId));
    let disabledOrphans = 0;
    for (const def of this.options.dynamicTaskStore.getAll()) {
      if (!isOwnerPresentLoop(def, ownerUserId) || knownIds.has(def.id) || !def.enabled) continue;
      this.options.dynamicTaskStore.setEnabled(def.id, false);
      this.options.taskRunner.unregister(def.id);
      disabledOrphans++;
    }
    return { reconciled, disabledOrphans, failed };
  }

  private async reconcileConfig(config: CatLifeConfigRecord): Promise<CatLifeConfigRecord> {
    try {
      this.disableProjection(config.projectionTaskId);
      for (const def of this.options.dynamicTaskStore.getAll()) {
        if (!def.enabled) continue;
        if (!isSamePresentLoopIdentity(def, config.ownerUserId, config.catId)) continue;
        this.disableProjection(def.id);
      }

      const canonicalCatId = this.resolveCatId(config.catId);
      if (canonicalCatId !== config.catId) {
        throw new AutoDreamStoreError(
          'CAT_NOT_FOUND',
          `cat life config must use canonical cat id "${canonicalCatId}" instead of "${config.catId}"`,
          400,
        );
      }

      await this.ensureBedroom(config);
      const def = buildProjectionDef(config);
      this.options.dynamicTaskStore.upsert(def);
      this.options.taskRunner.unregister(def.id);
      if (def.enabled) {
        const template = this.options.templateRegistry.get(def.templateId);
        if (!template) throw new Error('present-loop template is unavailable');
        const spec = template.createSpec(def.id, {
          trigger: def.trigger,
          params: def.params,
          deliveryThreadId: def.deliveryThreadId,
        });
        spec.display = def.display;
        this.options.taskRunner.registerDynamic(spec, def.id);
      }
      const ready = await this.options.store.markCatLifeProjectionReady(config.ownerUserId, config.catId);
      if (!ready) throw new Error('cat life config disappeared during reconciliation');
      return ready;
    } catch (error) {
      this.disableProjection(config.projectionTaskId);
      const message = error instanceof Error ? error.message : String(error);
      await this.options.store.markCatLifeProjectionError(config.ownerUserId, config.catId, message);
      throw error;
    }
  }

  private disableProjection(taskId: string): void {
    this.options.dynamicTaskStore.setEnabled(taskId, false);
    this.options.taskRunner.unregister(taskId);
  }

  private async ensureBedroom(config: CatLifeConfigRecord): Promise<void> {
    const existing = await this.options.threadStore.get(config.bedroomThreadId);
    if (existing?.deletedAt) await this.options.threadStore.restore(config.bedroomThreadId);
    await this.options.threadStore.ensureThread(config.bedroomThreadId, `${config.catId} 的卧室`);
    await this.options.threadStore.updateSystemKind(config.bedroomThreadId, 'cat_bedroom');
    await this.options.threadStore.indexForUser(config.bedroomThreadId, config.ownerUserId);
    await this.options.threadStore.addParticipants(config.bedroomThreadId, [config.catId as CatId]);
    await this.options.threadStore.updatePreferredCats(config.bedroomThreadId, [config.catId as CatId]);
  }

  private async serializeCatOperation<T>(ownerUserId: string, catId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${ownerUserId}\0${catId}`;
    const previous = this.catOperationTails.get(key) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.catOperationTails.set(key, settled);
    try {
      return await current;
    } finally {
      if (this.catOperationTails.get(key) === settled) this.catOperationTails.delete(key);
    }
  }

  private requireOwner(ownerUserId: string): void {
    if (!this.acceptsOwner(ownerUserId)) {
      throw new AutoDreamStoreError('OWNER_NOT_CONFIGURED', 'owner is not configured for cat life settings', 403);
    }
  }

  private resolveCatId(mentionOrId: string, allowDisabled = false): CatId {
    const result = this.options.resolveCatTarget(mentionOrId);
    if ('ok' in result) return result.ok;
    if (result.error.kind === 'cat_disabled') {
      if (allowDisabled) return result.error.catId;
      throw new AutoDreamStoreError(
        'CAT_DISABLED',
        `cat "${result.error.displayName}" (${result.error.catId}) is disabled`,
        400,
      );
    }
    if (result.error.kind === 'cat_not_found') {
      throw new AutoDreamStoreError('CAT_NOT_FOUND', `cat "${result.error.mention}" was not found`, 400);
    }
    throw new AutoDreamStoreError('CAT_NOT_FOUND', `cat target "${mentionOrId}" is unavailable`, 400);
  }
}

function buildProjectionDef(config: CatLifeConfigRecord): DynamicTaskDef {
  return {
    id: config.projectionTaskId,
    templateId: 'present-loop',
    trigger: {
      type: 'cron',
      expression: config.derived.cronExpression,
      timezone: config.settings.timezone,
    },
    params: {
      targetCatId: config.catId,
      triggerUserId: config.ownerUserId,
      managedBy: MANAGED_BY,
      projectionKey: `${config.ownerUserId}:${config.catId}:present-loop`,
    },
    display: {
      label: `${config.catId} 的私人时间`,
      category: 'system',
      description: '作息由猫的家管理；安静和发呆都是完整结果',
      subjectKind: 'thread',
    },
    deliveryThreadId: config.bedroomThreadId,
    enabled: config.enabled,
    createdBy: MANAGED_BY,
    createdAt: new Date(config.createdAt).toISOString(),
  };
}

function isOwnerPresentLoop(def: DynamicTaskDef, ownerUserId: string): boolean {
  return def.templateId === 'present-loop' && def.params.triggerUserId === ownerUserId;
}

function isSamePresentLoopIdentity(def: DynamicTaskDef, ownerUserId: string, catId: string): boolean {
  return isOwnerPresentLoop(def, ownerUserId) && def.params.targetCatId === catId;
}

function toPublicConfig(config: CatLifeConfigRecord, now: number): PublicCatLifeConfig {
  const currentNextWakeAt = deriveCatLifeSchedule({ ...config.settings, enabled: config.enabled }, now).nextWakeAt;
  return {
    catId: config.catId,
    enabled: config.enabled,
    rhythm: config.settings.rhythm,
    wakeTime: config.settings.wakeTime,
    timezone: config.settings.timezone,
    ...(config.settings.quietHours ? { quietHours: config.settings.quietHours } : {}),
    nextWakeAt: currentNextWakeAt,
    weeklyWakeCount: config.derived.weeklyWakeCount,
    costBand: config.derived.costBand,
    costNotice: config.derived.costNotice,
    projectionStatus: config.projectionStatus,
    ...(config.projectionError ? { projectionError: config.projectionError } : {}),
    revision: config.revision,
  };
}
