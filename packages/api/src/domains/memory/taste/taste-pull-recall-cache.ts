import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { runMemoryTasteRecallRead } from '../MemoryProcess.js';
import { readTastePullRecallRows, type TastePullRecallRow } from './taste-pull-recall-rows.js';

interface ReadSlot {
  ownerUserId: string;
  expiresAt: number;
  rows: Promise<readonly TastePullRecallRow[]>;
}

// One slot per canonical connection, shared by browse/observatory reader instances. No authority is cached.
const reads = new WeakMap<Database.Database, ReadSlot>();
const COMPLETION_TTL_MS = 1_000;

export async function tastePullRecallRows(
  db: Database.Database,
  ownerUserId: string,
): Promise<readonly TastePullRecallRow[]> {
  // An in-memory/temporary database cannot be reopened by another process. Keep its local semantics.
  if (db.memory || !db.name) return readTastePullRecallRows(db);
  const cached = reads.get(db);
  if (cached?.ownerUserId === ownerUserId && cached.expiresAt > Date.now()) return cached.rows;
  const slot: ReadSlot = {
    ownerUserId,
    expiresAt: Number.POSITIVE_INFINITY,
    rows: runMemoryTasteRecallRead(resolve(db.name)),
  };
  reads.set(db, slot);
  try {
    const rows = await slot.rows;
    slot.expiresAt = Date.now() + COMPLETION_TTL_MS;
    return rows;
  } catch (error) {
    if (reads.get(db) === slot) reads.delete(db);
    throw error; // Never retry the broad scan on the API connection or cache an unavailable result.
  }
}
