import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { DaemonStateError } from './daemon-state.mjs';
import { isProcessRunning } from './process-tree.mjs';

/**
 * F300 -- ownership of a stop operation, as an append-only chain of generations.
 *
 * Taking over from a crashed executor cannot be "read the holder, decide it is
 * dead, delete, re-create": two recoverers read the same dead holder, and the
 * second one deletes the first one's *live* claim on its way in. Neither can a
 * conditional delete fix it, because the filesystem has no compare-and-delete.
 *
 * So nobody ever deletes anybody else's claim. Each takeover creates the *next*
 * generation with `wx`, which the filesystem grants to exactly one process, and
 * the current owner is simply the highest generation whose holder is still
 * running. A recoverer that loses the race finds a live successor and stands
 * down without having touched anything.
 */

const LEGACY_GENERATION = 0;

function claimFile(paths) {
  return join(paths.namespaceDir, 'stop-operation.claim');
}

function claimGenerationFile(paths, generation) {
  return generation === LEGACY_GENERATION ? claimFile(paths) : `${claimFile(paths)}.${generation}`;
}

function readClaimAt(paths, generation) {
  try {
    return JSON.parse(readFileSync(claimGenerationFile(paths, generation), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The highest generation present, with its holder. */
export function currentClaim(paths) {
  const prefix = `${basename(claimFile(paths))}.`;
  let generations = [];
  try {
    generations = readdirSync(paths.namespaceDir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => Number.parseInt(entry.slice(prefix.length), 10))
      .filter((generation) => Number.isSafeInteger(generation));
  } catch {
    generations = [];
  }
  if (existsSync(claimFile(paths))) generations.push(LEGACY_GENERATION);
  if (generations.length === 0) return undefined;
  const generation = Math.max(...generations);
  return { generation, holder: readClaimAt(paths, generation) };
}

/**
 * Take ownership of this operation, or fail.
 *
 * @returns {{generation: number, token: string}} proof of ownership, for release
 */
export function acquireClaim(paths) {
  mkdirSync(paths.namespaceDir, { recursive: true, mode: 0o700 });
  const current = currentClaim(paths);
  if (current) {
    // Only a holder proven gone may be superseded. "I could not tell" leaves the
    // operation with whoever holds it.
    const running = isProcessRunning(current.holder?.pid);
    if (running !== false) {
      throw new DaemonStateError('stop-already-in-progress', 'Another executor holds this stop operation');
    }
  }

  const generation = (current?.generation ?? -1) + 1;
  const token = randomUUID();
  try {
    writeFileSync(claimGenerationFile(paths, generation), JSON.stringify({ pid: process.pid, at: Date.now(), token }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    // Somebody else created this generation first; they own the recovery.
    throw new DaemonStateError('stop-already-in-progress', 'Another executor is already recovering this operation');
  }
  return { generation, token };
}

/** Release only our own generation; other generations belong to other processes. */
export function releaseClaim(paths, claim) {
  if (!claim || readClaimAt(paths, claim.generation)?.token !== claim.token) return;
  try {
    unlinkSync(claimGenerationFile(paths, claim.generation));
  } catch {
    // Already released; nothing to undo.
  }
}
