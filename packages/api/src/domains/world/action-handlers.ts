import type { CharacterRecord, WorldAction, WorldEventEntry, WorldEventType } from '@cat-cafe/shared';
import type { IWorldStore } from './interfaces.js';
import { applyPatch } from './json-patch.js';

export interface ActionContext {
  worldId: string;
  sceneId: string;
  actorCatId: string;
  store: IWorldStore;
  generateEventId: () => string;
  now: string;
}

export interface ActionResult {
  event: WorldEventEntry;
  sideEffects?: () => Promise<void>;
}

type Handler = (action: WorldAction, ctx: ActionContext) => Promise<ActionResult>;

const handlers: Record<string, Handler> = {
  perform_dialogue: async (action, ctx) => {
    if (action.type !== 'perform_dialogue') throw new Error('type mismatch');
    return {
      event: makeEvent(ctx, 'dialogue', { content: action.content }, action.characterId),
    };
  },

  narrate: async (action, ctx) => {
    if (action.type !== 'narrate') throw new Error('type mismatch');
    return {
      event: makeEvent(ctx, 'narration', { content: action.content }),
    };
  },

  update_character_state: async (action, ctx) => {
    if (action.type !== 'update_character_state') throw new Error('type mismatch');
    const char = await ctx.store.getCharacter(action.characterId);
    if (!char) throw new Error(`Character not found: ${action.characterId}`);
    if (char.worldId !== ctx.worldId) {
      throw new Error(`Character ${action.characterId} does not belong to world ${ctx.worldId}`);
    }
    const slotValue = char[action.slot];
    const patched = applyPatch(slotValue, action.patch);
    const updated: CharacterRecord = { ...char, [action.slot]: patched, updatedAt: ctx.now };
    return {
      event: makeEvent(
        ctx,
        'character_state_change',
        { characterId: action.characterId, slot: action.slot, patch: action.patch },
        action.characterId,
      ),
      sideEffects: () => ctx.store.upsertCharacter(updated),
    };
  },

  edit_character_definition: async (action, ctx) => {
    if (action.type !== 'edit_character_definition') throw new Error('type mismatch');
    const char = await ctx.store.getCharacter(action.characterId);
    if (!char) throw new Error(`Character not found: ${action.characterId}`);
    if (char.worldId !== ctx.worldId) {
      throw new Error(`Character ${action.characterId} does not belong to world ${ctx.worldId}`);
    }
    const slotValue = char[action.slot];
    const patched = applyPatch(slotValue, action.patch);
    const updated: CharacterRecord = { ...char, [action.slot]: patched, updatedAt: ctx.now };
    return {
      event: makeEvent(
        ctx,
        'character_definition_change',
        { characterId: action.characterId, slot: action.slot, patch: action.patch },
        action.characterId,
      ),
      sideEffects: () => ctx.store.upsertCharacter(updated),
    };
  },

  propose_canon: async (action, ctx) => {
    if (action.type !== 'propose_canon') throw new Error('type mismatch');
    const recordId = `canon-${ctx.generateEventId()}`;
    const event = makeEvent(ctx, 'canon_proposed', {
      sourceEventId: action.sourceEventId,
      summary: action.summary,
      category: action.category,
    });
    event.canonRecordId = recordId;
    const sourceEventId = action.sourceEventId ?? event.eventId;
    return {
      event,
      sideEffects: () =>
        ctx.store.createCanonRecord({
          recordId,
          worldId: ctx.worldId,
          sceneId: ctx.sceneId,
          sourceEventId,
          status: 'proposed',
          summary: action.summary,
          category: action.category,
          proposedBy: { kind: 'cat', id: ctx.actorCatId },
          createdAt: ctx.now,
        }),
    };
  },

  decide_canon: async (action, ctx) => {
    if (action.type !== 'decide_canon') throw new Error('type mismatch');
    const record = await ctx.store.getCanonRecord(action.recordId);
    if (!record) throw new Error(`Canon record not found: ${action.recordId}`);
    if (record.worldId !== ctx.worldId) {
      throw new Error(`Canon record ${action.recordId} does not belong to world ${ctx.worldId}`);
    }
    const eventType: WorldEventType = action.decision === 'accepted' ? 'canon_accepted' : 'canon_rejected';
    const event = makeEvent(ctx, eventType, { recordId: action.recordId, reason: action.reason });
    event.canonRecordId = action.recordId;
    return {
      event,
      sideEffects: () =>
        ctx.store.updateCanonDecision(action.recordId, {
          status: action.decision,
          decidedBy: { kind: 'cat', id: ctx.actorCatId },
          reason: action.reason,
          decidedAt: ctx.now,
        }),
    };
  },

  transition_scene: async (action, ctx) => {
    if (action.type !== 'transition_scene') throw new Error('type mismatch');
    return {
      event: makeEvent(ctx, 'scene_transition', {
        targetSceneId: action.targetSceneId,
        newSceneName: action.newSceneName,
        newSceneDescription: action.newSceneDescription,
      }),
    };
  },

  care_check_in: async (action, ctx) => {
    if (action.type !== 'care_check_in') throw new Error('type mismatch');
    return {
      event: makeEvent(ctx, 'care_check_in', {
        suggestion: action.suggestion,
        realityBridge: action.realityBridge,
      }),
    };
  },
};

export function getActionHandler(type: string): Handler {
  const h = handlers[type];
  if (!h) throw new Error(`Unknown action type: ${type}`);
  return h;
}

function makeEvent(
  ctx: ActionContext,
  type: WorldEventType,
  payload: Record<string, unknown>,
  characterId?: string,
): WorldEventEntry {
  return {
    eventId: ctx.generateEventId(),
    worldId: ctx.worldId,
    sceneId: ctx.sceneId,
    type,
    actor: { kind: 'cat', id: ctx.actorCatId },
    characterId,
    payload,
    createdAt: ctx.now,
  };
}
