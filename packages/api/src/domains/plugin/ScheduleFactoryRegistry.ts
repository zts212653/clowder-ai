/**
 * F202 Phase 2: Schedule Factory Registry — white-list map of factoryId → TaskSpec factory.
 *
 * Plugin schedule resources declare a `factoryId` in plugin.yaml.
 * At activation time, the PluginResourceActivator looks up the factory here
 * and calls `createTaskSpec()` to produce a TaskSpec_P1 for TaskRunnerV2.
 *
 * KD-3: No arbitrary script loading — only registered factories can create tasks.
 * Factory ownership is scoped by pluginId so one plugin cannot bind another
 * plugin's whitelisted factory under its own schedule task ID.
 */
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';

/** Dependencies injected into factory.createTaskSpec() */
export interface ScheduleFactoryDeps {
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  [key: string]: unknown;
}

/** A registered schedule factory — produces TaskSpec_P1 for a given instanceId */
export interface ScheduleFactory {
  /** Plugin that owns this factory and may reference it from plugin.yaml. */
  readonly pluginId: string;
  readonly factoryId: string;
  createTaskSpec(instanceId: string, deps: ScheduleFactoryDeps): TaskSpec_P1;
}

/**
 * Registry of schedule task factories.
 * Each plugin schedule resource references a factoryId; the registry maps it
 * to the factory that knows how to build the corresponding TaskSpec_P1.
 */
export class ScheduleFactoryRegistry {
  private readonly factories = new Map<string, ScheduleFactory>();

  /** Register a factory. Throws if factoryId is already registered. */
  register(factory: ScheduleFactory): void {
    if (!factory.pluginId) {
      throw new Error(`Schedule factory '${factory.factoryId}' must declare a pluginId`);
    }
    if (this.factories.has(factory.factoryId)) {
      throw new Error(`Schedule factory '${factory.factoryId}' already registered`);
    }
    this.factories.set(factory.factoryId, factory);
  }

  /** Look up a factory by ID. Returns null if not found. */
  get(factoryId: string): ScheduleFactory | null {
    return this.factories.get(factoryId) ?? null;
  }

  /** Look up a factory only when it belongs to the requesting plugin. */
  getForPlugin(factoryId: string, pluginId: string): ScheduleFactory | null {
    const factory = this.get(factoryId);
    if (!factory || factory.pluginId !== pluginId) return null;
    return factory;
  }

  /** Check whether a factory ID has been registered. */
  has(factoryId: string): boolean {
    return this.factories.has(factoryId);
  }
}
