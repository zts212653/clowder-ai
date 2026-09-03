import type { CatConfig } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { AutomaticRoutingSignalService } from './AutomaticRoutingSignalService.js';
import { DossierCapabilityProfileRevisionSource } from './DossierCapabilityProfileRevisionSource.js';
import { F051QuotaRoutingSignalAdapter } from './F051QuotaRoutingSignalAdapter.js';
import { F153HealthRoutingSignalAdapter } from './F153HealthRoutingSignalAdapter.js';
import { RedisRoutingPreferenceStore } from './RedisRoutingPreferenceStore.js';
import { RedisRoutingSignalEventStore } from './RedisRoutingSignalEventStore.js';
import { RoutingContextPromptProjector } from './RoutingContextPromptProjector.js';
import { RoutingContextReadService } from './RoutingContextReadService.js';
import { RoutingContextResolver } from './RoutingContextResolver.js';
import { RuntimeRoutingDispatchPreflight } from './RoutingDispatchPreflightPort.js';
import { RoutingDispatchSignalAdapter } from './RoutingDispatchSignalAdapter.js';
import { RoutingPreflightService } from './RoutingPreflightService.js';
import { OpenTelemetryRoutingPreflightSink } from './RoutingPreflightTelemetry.js';
import {
  OpenTelemetryRoutingSignalObservationSink,
  RoutingSignalObservationTelemetry,
} from './RoutingSignalObservationTelemetry.js';
import { RuntimeRoutingCandidateCatalogSource } from './RuntimeRoutingCandidateCatalogSource.js';

export interface CreateRoutingContextRuntimeOptions {
  redis: RedisClient;
  projectRoot: string;
  getConfigs: () => Record<string, CatConfig>;
}

/** One production composition root shared by owner routes, prompt and dispatch consumers. */
export function createRoutingContextRuntime(options: CreateRoutingContextRuntimeOptions) {
  const signalStore = new RedisRoutingSignalEventStore(options.redis);
  const automaticSignalService = new AutomaticRoutingSignalService({ signalStore });
  const signalObservationTelemetry = new RoutingSignalObservationTelemetry({
    sink: new OpenTelemetryRoutingSignalObservationSink(),
  });
  const quotaSignalAdapter = new F051QuotaRoutingSignalAdapter({
    signalStore,
    automaticSignalService,
    telemetry: signalObservationTelemetry,
  });
  const healthSignalAdapter = new F153HealthRoutingSignalAdapter({
    signalStore,
    automaticSignalService,
    telemetry: signalObservationTelemetry,
  });
  const dispatchSignalAdapter = new RoutingDispatchSignalAdapter({
    signalStore,
    automaticSignalService,
    telemetry: signalObservationTelemetry,
  });
  const preferenceStore = new RedisRoutingPreferenceStore(options.redis);
  const catalogSource = new RuntimeRoutingCandidateCatalogSource({ getConfigs: options.getConfigs });
  const resolver = new RoutingContextResolver({
    signalStore,
    preferenceStore,
    profileRevisionSource: new DossierCapabilityProfileRevisionSource({ projectRoot: options.projectRoot }),
  });
  const readService = new RoutingContextReadService({ catalogSource, resolver });
  const promptProjector = new RoutingContextPromptProjector();
  const promptProjection = {
    async resolve(input: { ownerId: string; intent?: 'review' | 'architecture' }): Promise<string> {
      const readModel = await readService.read({
        ownerId: input.ownerId,
        observedAt: Date.now(),
        ...(input.intent ? { intent: input.intent } : {}),
      });
      return promptProjector.project(readModel);
    },
  };
  const preflightService = new RoutingPreflightService({
    resolver,
    telemetry: new OpenTelemetryRoutingPreflightSink(),
  });
  const dispatchPreflight = new RuntimeRoutingDispatchPreflight({ catalogSource, preflightService });
  return {
    signalStore,
    automaticSignalService,
    quotaSignalAdapter,
    healthSignalAdapter,
    dispatchSignalAdapter,
    signalObservationTelemetry,
    preferenceStore,
    catalogSource,
    resolver,
    readService,
    promptProjector,
    promptProjection,
    preflightService,
    dispatchPreflight,
  };
}

export type RoutingContextRuntime = ReturnType<typeof createRoutingContextRuntime>;
