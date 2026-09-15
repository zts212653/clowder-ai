import { execFileSync } from 'node:child_process';

import { isSelfOrDescendantOf } from './process-tree.mjs';

/**
 * F300 WP1.1 -- the health observation a stop record is closed against.
 *
 * This lives outside `daemon-stop-operation.mjs` on purpose. INV-5 keeps the
 * record writers free of network calls, because a record that could only be
 * written while something was reachable would be useless during exactly the
 * event it exists to survive. The probe is not a record writer: it is the
 * observation being recorded, and it is injected into `reverifyStop` as a
 * collaborator so the record layer owns *which* evidence closes the operation
 * without owning the socket.
 *
 * Two facts have to hold together, and neither implies the other: something on
 * the recorded port answers healthy, and the process that owns that port belongs
 * to the incarnation this operation recorded. A live launcher plus a healthy
 * stranger on its port is not a recovered deployment.
 */

/** How long to let the restarted deployment answer before calling it unhealthy. */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Which processes are listening on a TCP port.
 *
 * @returns {number[]} the listening pids; an empty list is a real answer (lsof
 *   exits 1 when nothing matches)
 * @returns {undefined} lsof could not be asked -- never read as "nobody listens"
 */
export function listenerPids(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [
      ...new Set(
        output
          .split('\n')
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1),
      ),
    ];
  } catch (error) {
    return error?.status === 1 ? [] : undefined;
  }
}

/**
 * Is every listener on the port the recorded incarnation or one of its children?
 *
 * Every listener, not any: a co-listener that does not belong could be the one
 * that answers. The API is normally a child of the recorded launcher, which is
 * why descent, not equality, is the test.
 *
 * @returns {true|false|undefined} undefined when ownership cannot be established
 */
function portBelongsTo(port, incarnationPid, { readListeners, isDescendant }) {
  const pids = readListeners(port);
  if (pids === undefined) return undefined;
  if (pids.length === 0) return false;
  let unknown = false;
  for (const pid of pids) {
    const related = isDescendant(pid, incarnationPid);
    if (related === false) return false;
    if (related === undefined) unknown = true;
  }
  return unknown ? undefined : true;
}

/**
 * Is the deployment we recorded actually serving again?
 *
 * Three outcomes, kept apart on purpose:
 *   - `{ok: true}`  the port belongs to the recorded incarnation, before and
 *                   after the request, and its health endpoint said ok
 *   - `{ok: false}` the port belongs to someone else, or the endpoint answered
 *                   otherwise, refused, timed out, or was not the health document
 *   - `undefined`   nothing could be established: no recorded port or
 *                   incarnation, or ownership could not be read. Never a pass.
 *
 * @returns {Promise<{ok: boolean, ref: string, reason?: string} | undefined>}
 */
export async function probeRecordedApiPort(
  state,
  {
    incarnationPid,
    timeoutMs = PROBE_TIMEOUT_MS,
    readListeners = listenerPids,
    isDescendant = isSelfOrDescendantOf,
    fetchImpl = fetch,
  } = {},
) {
  const port = state?.ports?.api;
  if (!Number.isSafeInteger(port) || !Number.isSafeInteger(incarnationPid)) return undefined;
  const ref = `http://127.0.0.1:${port}/health`;
  const ownership = { readListeners, isDescendant };

  const ownedBefore = portBelongsTo(port, incarnationPid, ownership);
  if (ownedBefore === undefined) return undefined;
  if (ownedBefore === false) return { ok: false, ref, reason: 'listener_not_incarnation' };

  let healthy;
  try {
    // The recorded endpoint has to answer for itself. Following a redirect would
    // accept a document served by whatever the Location names -- ownership was
    // proven for this port only (#4545 review R2).
    const response = await fetchImpl(ref, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return { ok: false, ref, reason: 'redirect_refused' };
    }
    if (!response.ok) return { ok: false, ref };
    const body = await response.json();
    healthy = body?.status === 'ok';
  } catch {
    return { ok: false, ref };
  }
  if (!healthy) return { ok: false, ref };

  // The port can change hands while we wait for the answer.
  const ownedAfter = portBelongsTo(port, incarnationPid, ownership);
  if (ownedAfter === undefined) return undefined;
  return ownedAfter ? { ok: true, ref } : { ok: false, ref, reason: 'listener_not_incarnation' };
}
