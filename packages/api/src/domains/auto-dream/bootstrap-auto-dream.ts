import type { FastifyInstance } from 'fastify';
import type { DynamicTaskStore } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskRunnerV2 } from '../../infrastructure/scheduler/TaskRunnerV2.js';
import { createPresentLoopTemplate } from '../../infrastructure/scheduler/templates/present-loop.js';
import type { TaskTemplate } from '../../infrastructure/scheduler/templates/types.js';
import { registerAutoDreamRoutes } from '../../routes/auto-dream.js';
import {
  type CallbackAutoDreamRouteDependencies,
  callbackAutoDreamRoutes,
} from '../../routes/callback-auto-dream-routes.js';
import { resolveCatTarget } from '../cats/services/agents/routing/cat-target-resolver.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { IEvidenceStore } from '../memory/interfaces.js';
import type { LibraryCatalog } from '../memory/LibraryCatalog.js';
import { type AutoDreamServices, createAutoDreamServices } from './AutoDreamServices.js';
import { CatLifeSettingsService } from './CatLifeSettingsService.js';
import { PresentLoopService } from './PresentLoopService.js';
import {
  type ProactiveCanonicalMessageBroadcaster,
  ProactiveRelationshipService,
} from './ProactiveRelationshipService.js';
import { DEFAULT_AWAKENED_LEASE_MS } from './store-config.js';

interface TemplateRegistrar {
  register(template: TaskTemplate): void;
  get(templateId: string): TaskTemplate | null;
}

export interface BootstrapAutoDreamOptions {
  app: FastifyInstance;
  dataDir: string;
  ownerUserId: string;
  catalog: LibraryCatalog;
  collectionStores: Map<string, IEvidenceStore>;
  registry: CallbackAutoDreamRouteDependencies['registry'];
  agentKeyRegistry?: CallbackAutoDreamRouteDependencies['agentKeyRegistry'];
  templateRegistry: TemplateRegistrar;
  dynamicTaskStore: DynamicTaskStore;
  taskRunner: Pick<TaskRunnerV2, 'registerDynamic' | 'unregister'>;
  threadStore: Pick<
    IThreadStore,
    'get' | 'ensureThread' | 'restore' | 'indexForUser' | 'addParticipants' | 'updatePreferredCats' | 'updateSystemKind'
  >;
  messageStore: Pick<IMessageStore, 'append' | 'getById' | 'getByIdempotencyKey' | 'getByThread'>;
  proactiveBroadcaster: ProactiveCanonicalMessageBroadcaster;
  awakenedLeaseMs?: number;
}

export interface BootstrapAutoDreamResult {
  services: AutoDreamServices;
  presentLoopService: PresentLoopService;
  proactiveRelationshipService: ProactiveRelationshipService;
  catLifeSettingsService: CatLifeSettingsService;
  startupProactiveReconciliation: { reconciled: number; failed: number };
  startupLifeReconciliation: { reconciled: number; disabledOrphans: number; failed: number };
}

export async function bootstrapAutoDream(options: BootstrapAutoDreamOptions): Promise<BootstrapAutoDreamResult> {
  const ownerUserId = options.ownerUserId.trim();
  if (!ownerUserId) throw new Error('ownerUserId is required for auto-dream bootstrap');
  const services = await createAutoDreamServices({
    dataDir: options.dataDir,
    privateUserId: ownerUserId,
    catalog: options.catalog,
    collectionStores: options.collectionStores,
    awakenedLeaseMs: options.awakenedLeaseMs,
  });
  const proactiveRelationshipService = new ProactiveRelationshipService({
    store: services.store,
    messageStore: options.messageStore,
    broadcaster: options.proactiveBroadcaster,
  });
  const startupProactiveReconciliation = await proactiveRelationshipService.reconcilePending(ownerUserId);
  const presentLoopService = new PresentLoopService(
    services.store,
    services.projector,
    ownerUserId,
    proactiveRelationshipService,
  );
  options.templateRegistry.register(createPresentLoopTemplate({ service: presentLoopService }));
  const catLifeSettingsService = new CatLifeSettingsService({
    store: services.store,
    dynamicTaskStore: options.dynamicTaskStore,
    taskRunner: options.taskRunner,
    templateRegistry: options.templateRegistry,
    threadStore: options.threadStore,
    privateOwnerUserId: ownerUserId,
    resolveCatTarget,
  });
  const startupLifeReconciliation = await catLifeSettingsService.reconcileAll();

  registerAutoDreamRoutes(options.app, {
    store: services.store,
    settingsService: catLifeSettingsService,
    ownerUserId,
  });
  await options.app.register(callbackAutoDreamRoutes, {
    registry: options.registry,
    agentKeyRegistry: options.agentKeyRegistry,
    service: presentLoopService,
    settingsService: catLifeSettingsService,
    store: services.store,
  });
  options.app.addHook('onClose', async () => services.close());

  return {
    services,
    presentLoopService,
    proactiveRelationshipService,
    catLifeSettingsService,
    startupProactiveReconciliation,
    startupLifeReconciliation,
  };
}

export function resolvePresentLoopLeaseMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_AWAKENED_LEASE_MS;
  const parsed = Number(raw);
  const leaseMs = Math.trunc(parsed);
  if (!Number.isFinite(parsed) || leaseMs <= 0) {
    throw new Error('CAT_CAFE_F255_AWAKENED_LEASE_MS must be a positive finite number');
  }
  return leaseMs;
}
