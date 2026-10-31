// Only non-secret procfs identity facts may enter cleanup diagnostics.
export function readLinuxExitIdentity(pid, readFileSyncImpl, path = `/proc/${pid}/stat`) {
  try {
    const text = String(readFileSyncImpl(path, 'utf8'));
    const prefix = text.match(/^(\d+) \(/u);
    const end = text.lastIndexOf(')');
    const fields = text
      .slice(end + 2)
      .trim()
      .split(/\s+/u);
    if (!prefix || Number(prefix[1]) !== pid || end < 0 || fields.length < 20) return null;
    const state = fields[0];
    const threads = Number(fields[17]);
    const birth = fields[19];
    if (!/^[RSDZTtXxKWPIN]$/u.test(state) || !Number.isSafeInteger(threads) || threads < 1) return null;
    if (!/^[0-9]{1,20}$/u.test(birth)) return null;
    return { pid, state, threads, birth };
  } catch {
    return null;
  }
}

export function proveLinuxExecutionExited(pid, before, { readFileSyncImpl, readdirSyncImpl }) {
  const after = readLinuxExitIdentity(pid, readFileSyncImpl);
  const evidence = { before, after };
  const terminal = (identity) =>
    identity && (identity.state === 'Z' || identity.state === 'X' || identity.state === 'x');
  // A zombie leader alone is insufficient: pthread_exit can leave workers alive.
  // A terminal sole thread cannot create new workers. Require a complete task
  // enumeration and repeat the birth/state/thread-count observation afterwards.
  if (!before || !after || before.birth !== after.birth || !terminal(after) || after.threads !== 1)
    return { proven: false, evidence };
  try {
    const tasks = readdirSyncImpl(`/proc/${pid}/task`);
    evidence.taskCount = tasks.length;
    if (tasks.length !== 1 || tasks[0] !== String(pid)) return { proven: false, evidence };
    const thread = readLinuxExitIdentity(pid, readFileSyncImpl, `/proc/${pid}/task/${pid}/stat`);
    const final = readLinuxExitIdentity(pid, readFileSyncImpl);
    evidence.thread = thread;
    evidence.final = final;
    const proven = [thread, final].every(
      (identity) => terminal(identity) && identity.birth === before.birth && identity.threads === 1,
    );
    return { proven, evidence };
  } catch {
    return { proven: false, evidence };
  }
}
