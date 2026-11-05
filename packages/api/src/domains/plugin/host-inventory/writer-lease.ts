import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { PluginInventoryError } from './types.js';

const require = createRequire(import.meta.url);

/** Same key for queues and connections, including directory aliases and Windows case aliases. */
export function canonicalInventoryPath(path: string): string {
  let parent = dirname(resolve(path));
  let suffix = basename(path);
  for (;;) {
    try {
      const canonical = join(realpathSync.native(parent), suffix);
      return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') || dirname(parent) === parent)
        throw error;
      suffix = join(basename(parent), suffix);
      parent = dirname(parent);
    }
  }
}

/** Hold across work, JSON commit and compensation; OS releases on crash. Never delete the auxiliary file. */
export function requireInventoryWriterLease(inventoryPath: string): () => void {
  mkdirSync(dirname(inventoryPath), { recursive: true, mode: 0o700 });
  const key = canonicalInventoryPath(inventoryPath);
  const path = `${key}.writer-lock.sqlite`;
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('Plugin inventory writer lock must be a regular file');
  // Existing API dependency, loaded only when a file inventory actually claims its writer.
  const SQLite = require('better-sqlite3') as typeof Database;
  const database = new SQLite(path, { timeout: 0 });
  try {
    database.exec('BEGIN EXCLUSIVE');
    return () => database.close();
  } catch (error) {
    database.close();
    if (error instanceof Error && 'code' in error && ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String(error.code)))
      throw new PluginInventoryError(
        'INVENTORY_INVARIANT',
        'Plugin inventory already has a live writer transaction; retry after it finishes (use one Host API per inventory)',
      );
    throw error;
  }
}
