import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TtsCacheIdentityError } from './TtsCacheIdentityError.js';

interface CachedIdentity {
  readonly model: string;
  readonly generationProfile: string | null;
}

interface IdentityRow {
  model: string;
  generation_profile: string | null;
  revision: string;
  ambiguous: number;
}

export interface TtsIdentityObservation {
  readonly cacheDir: string;
  readonly endpointKey: string;
  readonly revision: string | null;
}

const databaseName = '.tts-identities.sqlite';

function withDatabase<T>(cacheDir: string, use: (db: Database.Database) => T): T {
  const db = new Database(join(cacheDir, databaseName));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS endpoint_identity (
      endpoint_key TEXT PRIMARY KEY, model TEXT NOT NULL, generation_profile TEXT,
      revision TEXT NOT NULL, ambiguous INTEGER NOT NULL CHECK (ambiguous IN (0, 1))
    )`);
    return use(db);
  } finally {
    db.close();
  }
}

function keyFor(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('hex');
}

function readRow(db: Database.Database, key: string): IdentityRow | undefined {
  return db.prepare('SELECT * FROM endpoint_identity WHERE endpoint_key = ?').get(key) as IdentityRow | undefined;
}

/** Capture shared metadata state, never an inferred sidecar/network chronology. */
export async function beginTtsIdentityObservation(cacheDir: string, baseUrl: string): Promise<TtsIdentityObservation> {
  await mkdir(cacheDir, { recursive: true });
  const file = await open(join(cacheDir, databaseName), 'a', 0o600);
  await file.close();
  const endpointKey = keyFor(baseUrl);
  const revision = withDatabase(cacheDir, (db) => readRow(db, endpointKey)?.revision ?? null);
  return { cacheDir, endpointKey, revision };
}

export function readCachedTtsIdentity(cacheDir: string, baseUrl: string): CachedIdentity | null {
  return withDatabase(cacheDir, (db) => {
    const row = readRow(db, keyFor(baseUrl));
    if (!row) return null;
    if (row.ambiguous !== 0)
      throw new TtsCacheIdentityError(
        'TTS_CACHE_IDENTITY_AMBIGUOUS',
        'TTS cache identity is ambiguous; reconnect TTS to verify its generation policy',
      );
    if (
      typeof row.model !== 'string' ||
      !row.model ||
      (row.generation_profile !== null &&
        (typeof row.generation_profile !== 'string' || !row.generation_profile || row.generation_profile.length > 64))
    )
      throw new Error('Invalid cached TTS identity receipt');
    return { model: row.model, generationProfile: row.generation_profile };
  });
}

export function recordTtsIdentity(observation: TtsIdentityObservation, identity: CachedIdentity): void {
  withDatabase(observation.cacheDir, (db) => {
    // The write lock covers only read/compare/write, never the health request.
    db.transaction(() => {
      const current = readRow(db, observation.endpointKey);
      const unchanged = (current?.revision ?? null) === observation.revision;
      const sameIdentity =
        current &&
        current.ambiguous === 0 &&
        current.model === identity.model &&
        current.generation_profile === identity.generationProfile;
      const ambiguous = !unchanged && !sameIdentity;
      db.prepare(`INSERT INTO endpoint_identity (endpoint_key, model, generation_profile, revision, ambiguous)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint_key) DO UPDATE SET
          model = excluded.model, generation_profile = excluded.generation_profile,
          revision = excluded.revision, ambiguous = excluded.ambiguous
      `).run(observation.endpointKey, identity.model, identity.generationProfile, randomUUID(), ambiguous ? 1 : 0);
    }).immediate();
  });
}
