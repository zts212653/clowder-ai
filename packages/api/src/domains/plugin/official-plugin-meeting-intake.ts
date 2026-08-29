import {
  createFeishuMeetingCatchUpService,
  createFileMeetingIntakeStateStore,
  createLarkCliFeishuPollingGateway,
  type LarkCliFeishuPollingGateway,
  type MeetingIntakeState,
  meetingIntakeStatePath,
} from '@clowder-ai/feishu-meeting-intake';
import type { PluginInstanceRecord } from './host-inventory/types.js';
import type { OfficialPluginCatalogEntry } from './official-catalog.js';
import {
  OfficialMeetingIntakeError,
  type OfficialMeetingIntakeProjection,
  type OfficialMeetingIntakeWarning,
  type OfficialPluginMeetingIntakePort,
} from './official-plugin-meeting-intake-port.js';

const FEISHU_MEETING_INTAKE_CATALOG_ID = 'feishu-meeting-intake';
const DEFAULT_STALE_AFTER_MS = 2 * 60_000;
const RECOVERY_TIMEOUT_MS = 2 * 60_000;

const PREVIEW_CHANGED_MESSAGES = new Set([
  'Feishu catch-up preview changed',
  'Feishu catch-up candidate count changed',
  'Feishu catch-up scanner changed the frozen boundary',
]);

export interface OfficialPluginMeetingIntakeServiceOptions {
  readonly homeDirectory: string;
  readonly now?: () => number;
  readonly staleAfterMs?: number;
  readonly createGateway?: (instance: PluginInstanceRecord) => LarkCliFeishuPollingGateway;
}

function warning(
  state: MeetingIntakeState,
  instance: PluginInstanceRecord,
  now: number,
  staleAfterMs: number,
): OfficialMeetingIntakeWarning | undefined {
  const catchUp = state.catchUp;
  if (catchUp.status === 'backlog') {
    return {
      code: 'CATCH_UP_BACKLOG',
      message: `缺口候选至少 ${catchUp.candidateCountAtLeast} 条，超过自动补抓边界，需要主人处理。`,
      action: 'needs-owner',
    };
  }
  if (catchUp.status === 'previewed') {
    return {
      code: 'CATCH_UP_REQUIRED',
      message: `已预览到 ${catchUp.candidateCount} 条候选，请选择仅恢复以后或同时补抓。`,
      action: 'resolve-catch-up',
    };
  }
  if (catchUp.status === 'needs-owner') {
    return {
      code: 'CATCH_UP_REQUIRED',
      message: '检测到飞书会议纪要接收缺口，请先预览数量再选择恢复方式。',
      action: 'preview-catch-up',
    };
  }
  if (state.pending.length > 0) {
    return {
      code: 'PUBLISH_PENDING',
      message: `${state.pending.length} 条会议纪要已观测但尚未交付，请修复接收服务。`,
      action: 'repair',
    };
  }
  if (state.cursor !== null && state.health.lastSuccessfulObservationAt === null) {
    return {
      code: 'OBSERVATION_UNKNOWN',
      message: '飞书会议纪要同步曾运行，但还没有新的成功观测；请先检查并预览缺口。',
      action: 'preview-catch-up',
    };
  }
  const lastObservation = state.health.lastSuccessfulObservationAt;
  const basis = lastObservation ?? instance.updatedAt;
  if (instance.activationState === 'enabled' && now - basis > staleAfterMs) {
    return {
      code: 'OBSERVATION_STALE',
      message: '飞书会议纪要同步已超过 2 分钟没有成功观测，请检查并预览缺口。',
      action: 'preview-catch-up',
    };
  }
  if (instance.activationState === 'disabled' && lastObservation !== null && now - lastObservation > staleAfterMs) {
    return {
      code: 'OBSERVATION_STALE',
      message: '飞书会议纪要同步停用后存在时间缺口，请先检查并预览再恢复。',
      action: 'preview-catch-up',
    };
  }
  return undefined;
}

function isPreviewChanged(error: unknown): boolean {
  return error instanceof Error && PREVIEW_CHANGED_MESSAGES.has(error.message);
}

export class OfficialPluginMeetingIntakeService implements OfficialPluginMeetingIntakePort {
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly createGateway: (instance: PluginInstanceRecord) => LarkCliFeishuPollingGateway;

  constructor(private readonly options: OfficialPluginMeetingIntakeServiceOptions) {
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 1) {
      throw new TypeError('meeting intake stale SLA must be a positive integer');
    }
    this.createGateway =
      options.createGateway ??
      (() =>
        createLarkCliFeishuPollingGateway({
          homeDirectory: options.homeDirectory,
        }));
  }

  async project(
    entry: OfficialPluginCatalogEntry,
    instance: PluginInstanceRecord,
  ): Promise<OfficialMeetingIntakeProjection | undefined> {
    if (!this.supports(entry)) return undefined;
    const state = await this.store(instance).load();
    const projectedWarning = warning(state, instance, this.now(), this.staleAfterMs);
    return {
      ...state.health,
      pendingCount: state.pending.length,
      catchUp: structuredClone(state.catchUp),
      ...(projectedWarning === undefined ? {} : { warning: projectedWarning }),
    };
  }

  detect(entry: OfficialPluginCatalogEntry, instance: PluginInstanceRecord) {
    if (!this.supports(entry)) return Promise.resolve(undefined);
    return this.withService(instance, (service, signal) => service.detect(signal));
  }

  preview(entry: OfficialPluginCatalogEntry, instance: PluginInstanceRecord) {
    this.requireSupported(entry);
    return this.withService(instance, async (service, signal) => {
      const catchUp = await service.detect(signal);
      if (catchUp.status === 'idle') {
        throw new Error('Feishu catch-up does not have a previewable owner decision window');
      }
      return service.preview(signal);
    }).catch(async (error: unknown) => {
      if ((await this.store(instance).load()).catchUp.status === 'backlog') {
        throw new OfficialMeetingIntakeError(
          'CATCH_UP_BACKLOG',
          'Feishu catch-up exceeds the bounded page or candidate limit',
        );
      }
      throw error;
    });
  }

  resolve(
    entry: OfficialPluginCatalogEntry,
    instance: PluginInstanceRecord,
    decision: { readonly action: 'future-only' | 'replay'; readonly fingerprint: string },
  ): Promise<{ readonly action: 'future-only' | 'replay'; readonly candidateCount: number }> {
    this.requireSupported(entry);
    return this.withService(instance, async (service, signal) => {
      if (decision.action === 'future-only') return service.futureOnly(decision.fingerprint);
      return service.replay(decision.fingerprint, signal);
    }).catch(async (error: unknown) => {
      const catchUp = (await this.store(instance).load()).catchUp;
      if (catchUp.status === 'backlog') {
        throw new OfficialMeetingIntakeError(
          'CATCH_UP_BACKLOG',
          'Feishu catch-up exceeds the bounded page or candidate limit',
        );
      }
      if (isPreviewChanged(error) || (catchUp.status === 'previewed' && catchUp.fingerprint !== decision.fingerprint)) {
        throw new OfficialMeetingIntakeError(
          'CATCH_UP_PREVIEW_CHANGED',
          'Feishu catch-up candidates changed after preview; preview again before replay',
        );
      }
      throw error;
    });
  }

  private supports(entry: OfficialPluginCatalogEntry): boolean {
    return entry.catalogId === FEISHU_MEETING_INTAKE_CATALOG_ID;
  }

  private requireSupported(entry: OfficialPluginCatalogEntry): void {
    if (!this.supports(entry)) throw new Error('official plugin does not own meeting intake state');
  }

  private store(instance: PluginInstanceRecord) {
    return createFileMeetingIntakeStateStore(
      meetingIntakeStatePath(this.options.homeDirectory, instance.pluginInstanceId),
    );
  }

  private async withService<T>(
    instance: PluginInstanceRecord,
    operation: (service: ReturnType<typeof createFeishuMeetingCatchUpService>, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const gateway = this.createGateway(instance);
    const service = createFeishuMeetingCatchUpService({
      detector: gateway,
      scanner: gateway,
      store: this.store(instance),
      now: this.now,
    });
    try {
      return await operation(service, AbortSignal.timeout(RECOVERY_TIMEOUT_MS));
    } finally {
      await gateway.close();
    }
  }
}
