export const PENCIL_PROBE_RULE = 'stale-pencil-codex-status-probe';
export const PENCIL_PROBE_IDLE_MS = 60 * 60 * 1000;
export const PENCIL_PROBE_MAX_BYTES = 128 * 1024;
export const PENCIL_EXECUTABLE = '/Applications/Pencil.app/Contents/MacOS/Pencil';
const CODEX_EXECUTABLE =
  /^\/Applications\/Pencil\.app\/Contents\/Resources\/app\.asar\.unpacked\/node_modules\/@openai\/codex-sdk\/vendor\/(?:aarch64|x86_64)-apple-darwin\/codex\/codex$/;
const PROBE_ARGS =
  'exec --experimental-json --config reasoning_effort="medium" --model gpt-5.1-codex-mini --skip-git-repo-check';

export function pencilCodexExecutable(command) {
  const executable = String(command ?? '')
    .trim()
    .split(/\s+/, 1)[0];
  return CODEX_EXECUTABLE.test(executable) ? executable : null;
}

export function isPencilProbeCommand(command) {
  const executable = pencilCodexExecutable(command);
  return executable !== null && command === `${executable} ${PROBE_ARGS}`;
}

/** Parent ownership protects ordinary Pencil jobs from the legacy broad MCP-age rules. */
export function pencilOwnedDescendants(processes) {
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  const roots = new Set(
    processes
      .filter((row) => pencilCodexExecutable(row.command) && byPid.get(row.ppid)?.command === PENCIL_EXECUTABLE)
      .map((row) => row.pid),
  );
  const descendants = new Set();
  for (const row of processes) {
    const seen = new Set([row.pid]);
    let parentId = row.ppid;
    while (byPid.has(parentId) && !seen.has(parentId)) {
      if (roots.has(parentId)) {
        descendants.add(row.pid);
        break;
      }
      seen.add(parentId);
      parentId = byPid.get(parentId).ppid;
    }
  }
  return descendants;
}

/** Allow only the observed SDK login probe, never assistant/tool output or a later user turn. */
export function isInitialPencilProbeRollout(content) {
  if (Buffer.byteLength(content) > PENCIL_PROBE_MAX_BYTES) return false;
  let rows;
  try {
    rows = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch {
    return false;
  }
  const metadata = rows[0];
  if (metadata?.type !== 'session_meta' || metadata.payload?.originator !== 'codex_sdk_ts') return false;
  if (metadata.payload.source !== 'exec') return false;
  const last = rows.at(-1);
  if (last?.type !== 'event_msg' || last.payload?.type !== 'user_message' || last.payload.message !== 'whats 2+2?')
    return false;
  return rows
    .slice(1, -1)
    .every(
      (row) =>
        row?.type === 'response_item' &&
        row.payload?.type === 'message' &&
        ['developer', 'user'].includes(row.payload.role),
    );
}

export function isStalePencilProbe(row, processes, nowMs = Date.now()) {
  const proof = row.pencilProbe;
  const file = proof?.rollout;
  return Boolean(
    Number.isSafeInteger(row.pid) &&
      row.pid > 1 &&
      isPencilProbeCommand(row.command) &&
      row.elapsedSeconds * 1000 >= PENCIL_PROBE_IDLE_MS &&
      processes.some((parent) => parent.pid === row.ppid && parent.command === PENCIL_EXECUTABLE) &&
      proof?.executable === pencilCodexExecutable(row.command) &&
      proof.parentExecutable === PENCIL_EXECUTABLE &&
      proof.startedAt &&
      proof.parentStartedAt &&
      proof.cpuPercent === 0 &&
      proof.noTcpConnections === true &&
      proof.safeDescendants === true &&
      file?.probeOnly === true &&
      Number.isFinite(file.mtimeMs) &&
      file.size > 0 &&
      file.size <= PENCIL_PROBE_MAX_BYTES &&
      nowMs - file.mtimeMs >= PENCIL_PROBE_IDLE_MS,
  );
}

export function samePencilProbeWitness(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}
