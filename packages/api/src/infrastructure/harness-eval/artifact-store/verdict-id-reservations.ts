import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactCoordinates } from './artifact-store-layout.js';

/**
 * F257 — a verdict id names one verdict in its owner's store, whichever artifact
 * holds it. The Eval Hub, lifecycle roots and lifecycle logs all address a runtime
 * verdict by its bare id, and separate container directories cannot keep two of them
 * from holding the same one. So before a container becomes visible, its publisher
 * reserves every verdict id the container holds:
 *
 *   <ownerRoot>/.verdict-ids/<sha256(verdictId)>   → { verdictId, domainSlug, artifactId }
 *
 * The file name is a digest because ids are case-sensitive and a filesystem may not
 * be. A reservation appears atomically and complete — a fully written file is
 * hard-linked into place — so a concurrent publisher finds either no reservation or
 * the whole claim.
 *
 * A reservation is never released. A publication that fails after reserving leaves
 * its ids with its own container: a retry of that container finds them its own, and
 * no other container can take them. Releasing them instead would race a concurrent
 * publication of the same container that has already relied on them.
 */

const RESERVATIONS_DIR = '.verdict-ids';

interface VerdictIdReservation extends ArtifactCoordinates {
  verdictId: string;
}

function isNodeError(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function reservationPath(reservationsDir: string, verdictId: string): string {
  return join(reservationsDir, createHash('sha256').update(verdictId, 'utf8').digest('hex'));
}

/** Creates the reservation unless one exists; false when another claim got there first. */
function createReservation(reservationsDir: string, path: string, claim: VerdictIdReservation): boolean {
  const pending = join(reservationsDir, `.pending-${randomUUID()}`);
  writeFileSync(pending, `${JSON.stringify(claim)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    linkSync(pending, path);
    return true;
  } catch (err) {
    if (isNodeError(err, 'EEXIST')) return false;
    throw err;
  } finally {
    rmSync(pending, { force: true });
  }
}

function readReservation(path: string, verdictId: string): VerdictIdReservation {
  const holder = JSON.parse(readFileSync(path, 'utf8')) as Partial<VerdictIdReservation>;
  if (
    holder.verdictId !== verdictId ||
    typeof holder.domainSlug !== 'string' ||
    typeof holder.artifactId !== 'string'
  ) {
    throw new Error(`verdict id reservation for '${verdictId}' is unreadable at ${path}`);
  }
  return holder as VerdictIdReservation;
}

/**
 * Reserves each verdict id for the container, or throws `verdict_id_taken` for the
 * first id another container already holds. Ids this container reserved on an
 * earlier attempt are its own.
 */
export function reserveVerdictIds(
  ownerRoot: string,
  container: ArtifactCoordinates,
  verdictIds: readonly string[],
): void {
  const reservationsDir = join(ownerRoot, RESERVATIONS_DIR);
  mkdirSync(reservationsDir, { recursive: true });
  for (const verdictId of verdictIds) {
    const claim = { verdictId, domainSlug: container.domainSlug, artifactId: container.artifactId };
    const path = reservationPath(reservationsDir, verdictId);
    if (createReservation(reservationsDir, path, claim)) continue;
    const holder = readReservation(path, verdictId);
    if (holder.domainSlug === container.domainSlug && holder.artifactId === container.artifactId) continue;
    throw new Error(
      `verdict_id_taken: verdict id '${verdictId}' is already held by artifact ${holder.domainSlug}/${holder.artifactId} in this owner's store`,
    );
  }
}
