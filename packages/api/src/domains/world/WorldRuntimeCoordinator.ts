import type { WorldActionEnvelope, WorldEventEntry } from '@cat-cafe/shared';
import { type ActionContext, getActionHandler } from './action-handlers.js';
import type { IWorldStore } from './interfaces.js';

export interface ExecuteResult {
  events: WorldEventEntry[];
  errors?: string[];
}

const MODE_ACTION_ALLOWLIST: Record<string, string[]> = {
  build: [
    'narrate',
    'perform_dialogue',
    'edit_character_definition',
    'update_character_state',
    'propose_canon',
    'decide_canon',
    'transition_scene',
    'care_check_in',
  ],
  perform: [
    'narrate',
    'perform_dialogue',
    'update_character_state',
    'propose_canon',
    'decide_canon',
    'transition_scene',
    'care_check_in',
  ],
  replay: [],
};

export class WorldRuntimeCoordinator {
  private readonly store: IWorldStore;
  private readonly processedKeys = new Set<string>();
  private idCounter = 0;

  constructor(store: IWorldStore) {
    this.store = store;
  }

  async execute(envelope: WorldActionEnvelope): Promise<ExecuteResult> {
    const scopedKey = `${envelope.worldId}:${envelope.sceneId}:${envelope.idempotencyKey}`;
    if (this.processedKeys.has(scopedKey)) {
      return { events: [] };
    }
    this.processedKeys.add(scopedKey);

    const world = await this.store.getWorld(envelope.worldId);
    if (!world) throw new Error(`World not found: ${envelope.worldId}`);

    const scene = await this.store.getScene(envelope.sceneId);
    if (!scene) throw new Error(`Scene not found: ${envelope.sceneId}`);

    if (scene.worldId !== envelope.worldId) {
      throw new Error(`Scene ${envelope.sceneId} does not belong to world ${envelope.worldId}`);
    }

    if (envelope.mode !== scene.mode) {
      return { events: [], errors: [`Envelope mode '${envelope.mode}' does not match scene mode '${scene.mode}'`] };
    }

    const allowed = MODE_ACTION_ALLOWLIST[scene.mode] ?? [];
    const modeErrors: string[] = [];
    for (const action of envelope.actions) {
      if (!allowed.includes(action.type)) {
        modeErrors.push(`Action '${action.type}' is not allowed in '${scene.mode}' mode`);
      }
    }
    if (modeErrors.length > 0) {
      return { events: [], errors: modeErrors };
    }

    const now = new Date().toISOString();
    const ctx: ActionContext = {
      worldId: envelope.worldId,
      sceneId: envelope.sceneId,
      actorCatId: envelope.actorCatId,
      store: this.store,
      generateEventId: () => `evt-${++this.idCounter}-${Date.now()}`,
      now,
    };

    const events: WorldEventEntry[] = [];
    const sideEffects: Array<() => Promise<void>> = [];

    for (const action of envelope.actions) {
      const handler = getActionHandler(action.type);
      const result = await handler(action, ctx);
      events.push(result.event);
      if (result.sideEffects) sideEffects.push(result.sideEffects);
    }

    for (const effect of sideEffects) {
      await effect();
    }
    for (const event of events) {
      await this.store.appendEvent(event);
    }

    return { events };
  }
}
