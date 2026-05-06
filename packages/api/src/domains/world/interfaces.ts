import type {
  CanonPromotionRecord,
  CharacterRecord,
  SceneRecord,
  WorldEventEntry,
  WorldRecord,
} from '@cat-cafe/shared';

export const IWorldStoreSymbol = Symbol.for('IWorldStore');

export interface IWorldStore {
  initialize(): Promise<void>;
  close(): void;

  createWorld(world: WorldRecord): Promise<void>;
  getWorld(worldId: string): Promise<WorldRecord | null>;
  getWorldForThread(threadId: string): Promise<WorldRecord | null>;
  updateWorldStatus(worldId: string, status: WorldRecord['status'], updatedAt: string): Promise<void>;

  upsertCharacter(character: CharacterRecord): Promise<void>;
  getCharacter(characterId: string): Promise<CharacterRecord | null>;
  getCharactersByWorld(worldId: string): Promise<CharacterRecord[]>;

  createScene(scene: SceneRecord): Promise<void>;
  getScene(sceneId: string): Promise<SceneRecord | null>;
  getScenesByWorld(worldId: string): Promise<SceneRecord[]>;
  updateSceneStatus(sceneId: string, status: SceneRecord['status'], updatedAt: string): Promise<void>;

  appendEvent(event: WorldEventEntry): Promise<void>;
  getRecentEvents(worldId: string, sceneId: string, limit?: number): Promise<WorldEventEntry[]>;

  createCanonRecord(record: CanonPromotionRecord): Promise<void>;
  updateCanonDecision(
    recordId: string,
    decision: {
      status: 'accepted' | 'rejected';
      decidedBy: WorldEventEntry['actor'];
      reason?: string;
      decidedAt: string;
    },
  ): Promise<void>;
  getCanonRecord(recordId: string): Promise<CanonPromotionRecord | null>;
  getCanonSummary(worldId: string): Promise<Array<{ recordId: string; summary: string; acceptedAt: string }>>;

  getContext(
    worldId: string,
    sceneId: string,
    options?: { recentEventLimit?: number },
  ): Promise<{
    world: WorldRecord;
    scene: SceneRecord;
    characters: CharacterRecord[];
    recentEvents: WorldEventEntry[];
    canonSummary: Array<{ recordId: string; summary: string; acceptedAt: string }>;
  } | null>;
}
