const { createHash } = require('node:crypto');

/** F336 Phase C U2 (plan §D): the Host's write-behind for the living cat's scene archive.
 * The newest reported state belongs to this electron-main process, never to the body page.
 * - `scene.get` asks the API (private `scene.read` over the companion pipe) and hands the page
 *   the tri-state found | not_found | error. Only a body generation whose own read succeeded may
 *   report, so a failed read can never become a default write-back. While the Host still holds an
 *   unacknowledged state, a later body reads that state laid over the archive, never an older one.
 * - `scene.report {snapshot, dirty}` replaces the pending snapshot and adds its dirty fields.
 *   Writes go out at most once per second, the trailing change always included, and the pending
 *   state is held until the API answers with a new revision: a body that crashes, is swapped out
 *   or destroyed after reporting loses nothing it reported.
 * - A write lays the pending dirty fields over the last stored snapshot (a create writes the whole
 *   snapshot). On a revision conflict the stored value the API returned becomes the base and the
 *   same dirty fields are laid over it once more; a second conflict drops that write, adopts the
 *   stored state and logs it. A stale full snapshot is never replayed; a corrupt archive is kept.
 * - `flush(reason)` asks the body for its latest snapshot (≤ 300 ms), then writes at once past the
 *   throttle and waits for the ACK (≤ 2 s). A silent body is not "saved".
 * - There is no clear or delete of any kind. */
const FIELDS = new Set(['pose', 'ball', 'paper', 'hat', 'activity', 'lastSolo']);
const SNAPSHOT_MAX_BYTES = 16 * 1024;
const RETRY_MAX_MS = 30_000;
const ROUNDS = 3;
const denied = (code) => ({ kind: 'error', code });
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const validRevision = (value) => Number.isSafeInteger(value) && value >= 1;

/** The page's report, bounded like the API's snapshot envelope; returns an owned copy or undefined. */
function ownReport(command) {
  if (!exactKeys(command, ['kind', 'snapshot', 'dirty'])) return undefined;
  const { snapshot, dirty } = command;
  if (!plain(snapshot) || snapshot.schemaVersion !== 1) return undefined;
  if (!Object.keys(snapshot).every((field) => field === 'schemaVersion' || FIELDS.has(field))) return undefined;
  if (!Array.isArray(dirty) || dirty.length > FIELDS.size || !dirty.every((field) => FIELDS.has(field)))
    return undefined;
  let text;
  try {
    text = JSON.stringify(snapshot);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text, 'utf8') > SNAPSHOT_MAX_BYTES) return undefined;
  return { snapshot: JSON.parse(text), dirty: [...new Set(dirty)] };
}

/** The archive's answer as {status, revision, snapshot} with the stored-value rules, or undefined. */
function storedScene(value) {
  if (value?.status === 'not_found') return { status: 'not_found' };
  if (value?.status === 'found' && validRevision(value.revision) && plain(value.snapshot))
    return { status: 'found', revision: value.revision, snapshot: value.snapshot };
  if (value?.status === 'error')
    return { status: 'error', reason: value.reason === 'corrupt' ? 'corrupt' : 'unavailable' };
  return undefined;
}

function overlay(base, from, fields) {
  const next = { ...base, schemaVersion: from.schemaVersion };
  for (const field of fields) {
    if (Object.hasOwn(from, field)) next[field] = from[field];
    else delete next[field];
  }
  return next;
}

function createSceneWriter({ request, log = () => {}, throttleMs = 1000, askMs = 300, ackMs = 2000 }) {
  let stored; // {catId, revision, snapshot?}: the archive as last read or acknowledged; undefined = unread
  let pending; // {catId, snapshot, seq}: the newest reported state not yet acknowledged, bound to the cat its body read
  const dirty = new Map(); // field → seq of the newest report that changed it, since stored.revision
  let seq = 0;
  let body; // {generation, ask, read, catId}: catId is the cat this body's own read returned
  let queue = Promise.resolve(); // reads and writes never overlap
  let writing; // the queued or running write attempt
  let timer;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let retryAt = Number.NEGATIVE_INFINITY;
  let retryMs = 0;
  let closed = false;
  const waiters = new Set();

  const call = (command) =>
    Promise.resolve()
      .then(() => request(command))
      .catch(() => denied('unavailable'));
  const exclusive = (task) => {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  /** Pending without dirty fields over an existing archive has nothing to write. */
  const normalize = () => {
    if (pending && stored && stored.revision > 0 && dirty.size === 0) pending = undefined;
  };
  const writable = () => !closed && stored !== undefined && pending !== undefined && stored.catId === pending.catId;
  const payload = () =>
    stored.revision === 0 ? pending.snapshot : overlay(stored.snapshot, pending.snapshot, dirty.keys());
  const settleThrough = (sent) => {
    for (const [field, at] of dirty) if (at <= sent) dirty.delete(field);
    if (pending && pending.seq <= sent) pending = undefined;
    normalize();
  };
  const forget = () => {
    pending = undefined;
    dirty.clear();
    stored = undefined;
    if (body) body.read = false;
  };
  const digest = () => {
    const sha = createHash('sha256').update(JSON.stringify(pending.snapshot)).digest('hex').slice(0, 12);
    return `cat=${pending?.catId ?? '?'} base=${stored?.revision ?? 'unread'} dirty=${[...dirty.keys()].join(',') || '-'} sha=${sha}`;
  };

  function adoptConflict(catId, current) {
    const scene = storedScene(current);
    if (scene?.status === 'found') stored = { catId, revision: scene.revision, snapshot: scene.snapshot };
    else if (scene?.status === 'not_found') stored = { catId, revision: 0 };
    else {
      log(`scene archive unreadable (${scene?.reason ?? 'unknown'}); kept as is, nothing written`);
      stored = undefined; // writes wait for the next successful read
      return 'blocked';
    }
    normalize();
    return 'conflict';
  }
  async function writeOnce() {
    const base = stored;
    const sent = pending.seq;
    const snapshot = payload();
    const reply = await call({ kind: 'scene.write', catId: base.catId, baseRevision: base.revision, snapshot });
    if (closed) return 'closed';
    if (
      reply?.kind === 'scene-put' &&
      reply.status === 'ok' &&
      reply.revision > base.revision &&
      validRevision(reply.revision)
    ) {
      stored = { catId: base.catId, revision: reply.revision, snapshot };
      settleThrough(sent);
      return 'ok';
    }
    if (reply?.kind === 'scene-put' && reply.status === 'conflict') return adoptConflict(base.catId, reply.current);
    if (reply?.kind === 'error' && reply.code === 'invalid_request') {
      log(`scene write refused by the archive; dropped ${digest()}`);
      settleThrough(sent);
      return 'dropped';
    }
    if (reply?.kind === 'error' && reply.code === 'selection_changed') {
      log(`scene belongs to a cat that is no longer on duty; dropped ${digest()}`);
      forget();
      return 'dropped';
    }
    return 'failed';
  }
  async function attempt() {
    if (!writable()) return 'idle';
    lastWriteAt = Date.now();
    let outcome = await writeOnce();
    if (outcome === 'conflict' && writable()) {
      const sent = pending.seq;
      outcome = await writeOnce();
      if (outcome === 'conflict') {
        settleThrough(sent);
        log(`scene write dropped after a second conflict; adopted revision ${stored?.revision}`);
        outcome = 'dropped';
      }
    }
    retryMs = outcome === 'failed' ? Math.min(RETRY_MAX_MS, Math.max(throttleMs, retryMs * 2)) : 0;
    retryAt = outcome === 'failed' ? Date.now() + retryMs : Number.NEGATIVE_INFINITY;
    return outcome;
  }
  /** Starts a write now, past the throttle; joins the one already queued or running. */
  function start() {
    writing ??= exclusive(attempt).finally(() => {
      writing = undefined;
      schedule();
    });
    return writing;
  }
  function schedule() {
    if (closed || timer || writing || !writable()) return;
    const wait = Math.max(lastWriteAt + throttleMs, retryAt) - Date.now();
    if (wait <= 0) return void start();
    timer = setTimeout(() => {
      timer = undefined;
      void start();
    }, wait);
    timer.unref?.();
  }
  const within = (promise, deadline) =>
    new Promise((resolve) => {
      const expiry = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
      promise.then(
        (value) => {
          clearTimeout(expiry);
          resolve(value);
        },
        () => {
          clearTimeout(expiry);
          resolve('failed');
        },
      );
    });
  function askBody(current) {
    return new Promise((resolve) => {
      const waiter = {
        generation: current.generation,
        resolve(value) {
          clearTimeout(expiry);
          waiters.delete(waiter);
          resolve(value);
        },
      };
      const expiry = setTimeout(() => waiter.resolve(false), askMs);
      waiters.add(waiter);
      try {
        current.ask();
      } catch {
        waiter.resolve(false); // a destroyed body cannot answer
      }
    });
  }
  /** Write now, past the throttle, until acknowledged, failed or out of time. */
  async function drain(deadline) {
    for (let round = 0; round < ROUNDS && !closed && Date.now() < deadline; round++) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const write = writable() ? start() : writing;
      if (!write || (await within(write, deadline)) !== 'ok') return;
    }
  }
  const release = (generation) => {
    for (const waiter of [...waiters])
      if (generation === undefined || waiter.generation === generation) waiter.resolve(false);
  };

  /** A successful read becomes the base; a state the Host still holds is laid over it for the page. */
  function adoptRead(catId, scene, generation) {
    // The pending state belongs to the cat its body read, whatever became of `stored` since
    // (a corrupt conflict leaves it unread): it is never laid over, or written to, another cat.
    if (pending && pending.catId !== catId) {
      log(`duty cat changed; the previous cat's unsaved scene is dropped ${digest()}`);
      pending = undefined;
      dirty.clear();
    }
    stored = { catId, revision: scene.revision ?? 0, snapshot: scene.snapshot };
    if (body?.generation === generation) Object.assign(body, { read: true, catId });
    normalize();
    schedule(); // an earlier body's pending state can now be written over this base
    if (pending) return { kind: 'scene', status: 'found', revision: stored.revision, snapshot: payload() };
    return { kind: 'scene', ...scene };
  }
  function read(generation) {
    return exclusive(async () => {
      const reply = await call({ kind: 'scene.read' });
      if (closed) return denied('cancelled');
      const scene = reply?.kind === 'scene' && typeof reply.catId === 'string' ? storedScene(reply) : undefined;
      if (!scene) return { kind: 'scene', status: 'error', reason: 'unavailable' };
      if (scene.status !== 'error') return adoptRead(reply.catId, scene, generation);
      log(`scene unreadable (${scene.reason}) for ${reply.catId}; archive kept, nothing written`);
      return { kind: 'scene', ...scene };
    });
  }
  function report(generation, command) {
    if (!body.read) return denied('session_required');
    const owned = ownReport(command);
    if (!owned) return denied('invalid_request');
    pending = { catId: body.catId, snapshot: owned.snapshot, seq: ++seq };
    for (const field of owned.dirty) dirty.set(field, seq);
    normalize();
    for (const waiter of [...waiters]) if (waiter.generation === generation) waiter.resolve(true);
    schedule();
    return { kind: 'ok' };
  }

  return {
    /** Internal swap in: the body of this generation may read and, after its read, report. */
    attach(generation, ask) {
      release();
      body = { generation, ask, read: false, catId: undefined };
    },
    /** The body is gone (swap, crash, close); what it already reported stays pending. */
    detach(generation) {
      if (!body || (generation !== undefined && body.generation !== generation)) return;
      release(body.generation);
      body = undefined;
    },
    request(sender, command) {
      if (closed || !body || sender?.role !== 'body' || sender.generation !== body.generation)
        return Promise.resolve(denied('permission_required'));
      if (command.kind === 'scene.get')
        return exactKeys(command, ['kind']) ? read(body.generation) : Promise.resolve(denied('invalid_request'));
      if (command.kind === 'scene.report') return Promise.resolve(report(body.generation, command));
      return Promise.resolve(denied('invalid_request'));
    },
    /** Ask the body (≤ askMs), then write at once and wait for the ACK (≤ ackMs). Never rejects. */
    async flush(reason) {
      if (closed) return { saved: pending === undefined, answered: false };
      let answered = body === undefined;
      if (body?.read) {
        answered = await askBody(body);
        if (!answered)
          log(`body did not answer the ${reason} flush within ${askMs} ms; writing its last reported state`);
      }
      await drain(Date.now() + ackMs);
      return { saved: answered && pending === undefined, answered };
    },
    /** Nothing to ask and nothing to save: quitting need not wait for this writer. */
    idle: () => !body && !pending,
    close() {
      if (closed) return;
      if (pending) log(`scene not saved: ${digest()}`);
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      release();
      body = undefined;
    },
  };
}

module.exports = { createSceneWriter };
