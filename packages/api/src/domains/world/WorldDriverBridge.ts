import type { PackWorldDriver, WorldActionEnvelope, WorldContextEnvelope } from '@cat-cafe/shared';
import type { WorldContextProvider } from './WorldContextProvider.js';
import type { ExecuteResult, WorldRuntimeCoordinator } from './WorldRuntimeCoordinator.js';

export class WorldDriverBridge {
  constructor(
    private readonly driverConfig: PackWorldDriver,
    private readonly coordinator: WorldRuntimeCoordinator,
    private readonly contextProvider: WorldContextProvider,
  ) {}

  get allowedActions(): string[] {
    return this.driverConfig.actions ?? [];
  }

  get resolver(): string {
    return this.driverConfig.resolver;
  }

  validateEnvelope(envelope: WorldActionEnvelope): string[] {
    const errors: string[] = [];
    const allowed = this.allowedActions;
    if (allowed.length > 0) {
      for (const action of envelope.actions) {
        if (!allowed.includes(action.type)) {
          errors.push(`Action "${action.type}" not allowed by pack driver (allowed: ${allowed.join(', ')})`);
        }
      }
    }
    return errors;
  }

  async execute(envelope: WorldActionEnvelope): Promise<ExecuteResult> {
    const errors = this.validateEnvelope(envelope);
    if (errors.length > 0) {
      return { events: [], errors };
    }
    return this.coordinator.execute(envelope);
  }

  async getContext(
    worldId: string,
    sceneId: string,
    options?: { query?: string; careLoopHint?: WorldContextEnvelope['careLoopHint'] },
  ): Promise<WorldContextEnvelope | null> {
    return this.contextProvider.assemble(worldId, sceneId, options);
  }
}
