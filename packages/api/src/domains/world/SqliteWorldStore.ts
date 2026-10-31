import type {
  CanonPromotionRecord,
  CharacterRecord,
  SceneRecord,
  WorldActorRef,
  WorldEventEntry,
  WorldRecord,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import type { IWorldStore } from './interfaces.js';
import { applyMigrations } from './schema.js';

export class SqliteWorldStore implements IWorldStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    applyMigrations(this.db);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private ensureOpen(): Database.Database {
    if (!this.db) throw new Error('WorldStore not initialized');
    return this.db;
  }

  async createWorld(world: WorldRecord): Promise<void> {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT INTO worlds (world_id, name, description, constitution, status, thread_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      world.worldId,
      world.name,
      world.description ?? null,
      world.constitution ?? null,
      world.status,
      world.threadId ?? null,
      JSON.stringify(world.createdBy),
      world.createdAt,
      world.updatedAt,
    );
  }

  async getWorld(worldId: string): Promise<WorldRecord | null> {
    const db = this.ensureOpen();
    const row = db.prepare('SELECT * FROM worlds WHERE world_id = ?').get(worldId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return rowToWorld(row);
  }

  async getWorldForThread(threadId: string): Promise<WorldRecord | null> {
    const db = this.ensureOpen();
    const row = db
      .prepare("SELECT * FROM worlds WHERE thread_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(threadId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToWorld(row);
  }

  async updateWorldStatus(worldId: string, status: WorldRecord['status'], updatedAt: string): Promise<void> {
    const db = this.ensureOpen();
    db.prepare('UPDATE worlds SET status = ?, updated_at = ? WHERE world_id = ?').run(status, updatedAt, worldId);
  }

  async upsertCharacter(character: CharacterRecord): Promise<void> {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT INTO world_characters (character_id, world_id, core_identity, inner_drive, relationship_tension, voice_and_image, growth_state, mask_overlay, base_cat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET
         core_identity = excluded.core_identity,
         inner_drive = excluded.inner_drive,
         relationship_tension = excluded.relationship_tension,
         voice_and_image = excluded.voice_and_image,
         growth_state = excluded.growth_state,
         mask_overlay = excluded.mask_overlay,
         base_cat_id = excluded.base_cat_id,
         updated_at = excluded.updated_at`,
    ).run(
      character.characterId,
      character.worldId,
      JSON.stringify(character.coreIdentity),
      JSON.stringify(character.innerDrive),
      JSON.stringify(character.relationshipTension),
      JSON.stringify(character.voiceAndImage),
      JSON.stringify(character.growthState),
      character.maskOverlay ? JSON.stringify(character.maskOverlay) : null,
      character.baseCatId ?? null,
      character.createdAt,
      character.updatedAt,
    );
  }

  async getCharacter(characterId: string): Promise<CharacterRecord | null> {
    const db = this.ensureOpen();
    const row = db.prepare('SELECT * FROM world_characters WHERE character_id = ?').get(characterId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return rowToCharacter(row);
  }

  async getCharactersByWorld(worldId: string): Promise<CharacterRecord[]> {
    const db = this.ensureOpen();
    const rows = db.prepare('SELECT * FROM world_characters WHERE world_id = ?').all(worldId) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToCharacter);
  }

  async createScene(scene: SceneRecord): Promise<void> {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT INTO world_scenes (scene_id, world_id, name, description, mode, status, active_character_ids, setting, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scene.sceneId,
      scene.worldId,
      scene.name,
      scene.description ?? null,
      scene.mode,
      scene.status,
      JSON.stringify(scene.activeCharacterIds),
      scene.setting ?? null,
      scene.createdAt,
      scene.updatedAt,
    );
  }

  async getScene(sceneId: string): Promise<SceneRecord | null> {
    const db = this.ensureOpen();
    const row = db.prepare('SELECT * FROM world_scenes WHERE scene_id = ?').get(sceneId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return rowToScene(row);
  }

  async getScenesByWorld(worldId: string): Promise<SceneRecord[]> {
    const db = this.ensureOpen();
    const rows = db.prepare('SELECT * FROM world_scenes WHERE world_id = ?').all(worldId) as Record<string, unknown>[];
    return rows.map(rowToScene);
  }

  async updateSceneStatus(sceneId: string, status: SceneRecord['status'], updatedAt: string): Promise<void> {
    const db = this.ensureOpen();
    db.prepare('UPDATE world_scenes SET status = ?, updated_at = ? WHERE scene_id = ?').run(status, updatedAt, sceneId);
  }

  async appendEvent(event: WorldEventEntry): Promise<void> {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT INTO world_event_log (event_id, world_id, scene_id, type, actor, character_id, payload, canon_record_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      event.worldId,
      event.sceneId,
      event.type,
      JSON.stringify(event.actor),
      event.characterId ?? null,
      JSON.stringify(event.payload),
      event.canonRecordId ?? null,
      event.createdAt,
    );
  }

  async getRecentEvents(worldId: string, sceneId: string, limit = 20): Promise<WorldEventEntry[]> {
    const db = this.ensureOpen();
    const rows = db
      .prepare(
        `SELECT * FROM world_event_log
         WHERE world_id = ? AND scene_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(worldId, sceneId, limit) as Record<string, unknown>[];
    return rows.reverse().map(rowToEvent);
  }

  async createCanonRecord(record: CanonPromotionRecord): Promise<void> {
    const db = this.ensureOpen();
    db.prepare(
      `INSERT INTO canon_promotion_records (record_id, world_id, scene_id, source_event_id, status, summary, category, proposed_by, decided_by, reason, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.recordId,
      record.worldId,
      record.sceneId,
      record.sourceEventId,
      record.status,
      record.summary,
      record.category ?? null,
      JSON.stringify(record.proposedBy),
      record.decidedBy ? JSON.stringify(record.decidedBy) : null,
      record.reason ?? null,
      record.createdAt,
      record.decidedAt ?? null,
    );
  }

  async updateCanonDecision(
    recordId: string,
    decision: { status: 'accepted' | 'rejected'; decidedBy: WorldActorRef; reason?: string; decidedAt: string },
  ): Promise<void> {
    const db = this.ensureOpen();
    db.prepare(
      'UPDATE canon_promotion_records SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE record_id = ?',
    ).run(decision.status, JSON.stringify(decision.decidedBy), decision.reason ?? null, decision.decidedAt, recordId);
  }

  async getCanonRecord(recordId: string): Promise<CanonPromotionRecord | null> {
    const db = this.ensureOpen();
    const row = db.prepare('SELECT * FROM canon_promotion_records WHERE record_id = ?').get(recordId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return rowToCanon(row);
  }

  async getCanonSummary(worldId: string): Promise<Array<{ recordId: string; summary: string; acceptedAt: string }>> {
    const db = this.ensureOpen();
    const rows = db
      .prepare(
        "SELECT record_id, summary, decided_at FROM canon_promotion_records WHERE world_id = ? AND status = 'accepted'",
      )
      .all(worldId) as Array<{ record_id: string; summary: string; decided_at: string }>;
    return rows.map((r) => ({ recordId: r.record_id, summary: r.summary, acceptedAt: r.decided_at }));
  }

  async getContext(
    worldId: string,
    sceneId: string,
    options?: { recentEventLimit?: number },
  ): Promise<{
    world: WorldRecord;
    scene: SceneRecord;
    characters: CharacterRecord[];
    recentEvents: WorldEventEntry[];
    canonSummary: Array<{ recordId: string; summary: string; acceptedAt: string }>;
  } | null> {
    const world = await this.getWorld(worldId);
    if (!world) return null;
    const scene = await this.getScene(sceneId);
    if (!scene) return null;
    if (scene.worldId !== worldId) return null;
    const [characters, recentEvents, canonSummary] = await Promise.all([
      this.getCharactersByWorld(worldId),
      this.getRecentEvents(worldId, sceneId, options?.recentEventLimit),
      this.getCanonSummary(worldId),
    ]);
    return { world, scene, characters, recentEvents, canonSummary };
  }
}

function rowToWorld(row: Record<string, unknown>): WorldRecord {
  return {
    worldId: row.world_id as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    constitution: (row.constitution as string) || undefined,
    status: row.status as WorldRecord['status'],
    threadId: (row.thread_id as string) || undefined,
    createdBy: JSON.parse(row.created_by as string) as WorldActorRef,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToCharacter(row: Record<string, unknown>): CharacterRecord {
  return {
    characterId: row.character_id as string,
    worldId: row.world_id as string,
    coreIdentity: JSON.parse(row.core_identity as string),
    innerDrive: JSON.parse(row.inner_drive as string),
    relationshipTension: JSON.parse(row.relationship_tension as string),
    voiceAndImage: JSON.parse(row.voice_and_image as string),
    growthState: JSON.parse(row.growth_state as string),
    maskOverlay: row.mask_overlay ? JSON.parse(row.mask_overlay as string) : undefined,
    baseCatId: (row.base_cat_id as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToScene(row: Record<string, unknown>): SceneRecord {
  return {
    sceneId: row.scene_id as string,
    worldId: row.world_id as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    mode: row.mode as SceneRecord['mode'],
    status: row.status as SceneRecord['status'],
    activeCharacterIds: JSON.parse(row.active_character_ids as string) as string[],
    setting: (row.setting as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToEvent(row: Record<string, unknown>): WorldEventEntry {
  return {
    eventId: row.event_id as string,
    worldId: row.world_id as string,
    sceneId: row.scene_id as string,
    type: row.type as WorldEventEntry['type'],
    actor: JSON.parse(row.actor as string) as WorldActorRef,
    characterId: (row.character_id as string) || undefined,
    payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    canonRecordId: (row.canon_record_id as string) || undefined,
    createdAt: row.created_at as string,
  };
}

function rowToCanon(row: Record<string, unknown>): CanonPromotionRecord {
  return {
    recordId: row.record_id as string,
    worldId: row.world_id as string,
    sceneId: row.scene_id as string,
    sourceEventId: row.source_event_id as string,
    status: row.status as CanonPromotionRecord['status'],
    summary: row.summary as string,
    category: (row.category as string) || undefined,
    proposedBy: JSON.parse(row.proposed_by as string) as WorldActorRef,
    decidedBy: row.decided_by ? (JSON.parse(row.decided_by as string) as WorldActorRef) : undefined,
    reason: (row.reason as string) || undefined,
    createdAt: row.created_at as string,
    decidedAt: (row.decided_at as string) || undefined,
  };
}
