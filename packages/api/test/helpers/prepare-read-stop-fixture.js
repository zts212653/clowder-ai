import { OwnerPreparationSources } from '../../dist/domains/memory/cue/preparation/OwnerPreparationSources.js';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MemoryReadExecution } from '../../dist/domains/memory/memory-read-execution.js';
import { checkSearchExecution } from '../../dist/domains/memory/message-search-lifetime.js';
import { preparationFixture } from './work-preparation-fixture.js';

export const SECRET = 'PRIVATE_BODY_QUERY_PATH_STACK';
export const FINGERPRINT = 'a'.repeat(64);

/** Existing execution snapshots with synthetic witnesses; this fixture runs no model/native KNN. */
export function executionWitness() {
  const execution = new MemoryReadExecution('message-search');
  execution.dispatched(12345);
  execution.ready();
  const sql = {
    databasePath: `/${SECRET}`,
    caller: [SECRET],
    requestId: SECRET,
    sqlFingerprint: FINGERPRINT,
    startedAt: 1000,
    native: {
      kind: 'vector-knn',
      requestedK: 20,
      dimensions: 768,
      resourcesBefore: {
        userCpuUs: 10,
        systemCpuUs: 2,
        fsReadOperations: 0,
        fsWriteOperations: 0,
        voluntaryContextSwitches: 1,
        involuntaryContextSwitches: 0,
        maxRssKiB: 100,
      },
    },
  };
  execution.observe({ phase: 'sql-start', sql });
  execution.observe({
    phase: 'cjk-read',
    cjk: {
      bodyVisits: 256,
      bodyUtf16: 4096,
      checkpoints: 1,
      checkpointLimit: 8,
      outcome: 'running',
      complete: false,
      returnedRows: null,
      elapsedMs: 3,
    },
  });
  return { execution, sql };
}

/** Real preparation/MessageSearchService/source wrappers and SQLite store; only the native reader is controlled. */
export function preparationReadStopFixture(t, mode) {
  const logs = [];
  const f = preparationFixture(t, { logger: { warn: (fields) => logs.push(fields) } });
  const caller = new AbortController();
  const original = mode === 'unknown' ? { name: 'TimeoutError', message: SECRET } : new Error(SECRET);
  if (mode === 'spoof-deadline') original.name = 'TimeoutError';
  const thread = { id: f.auth.threadId, createdBy: f.auth.userId, projectPath: `/${SECRET}` };
  let lateReject;
  const service = new MessageSearchService({
    threadStore: { list: () => [thread], get: () => thread },
    messageStore: {
      getById: (id) => ({ id, threadId: thread.id, userId: f.auth.userId, content: SECRET, timestamp: 1 }),
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      async searchMessagePassages(_query, options) {
        const { execution, sql } = executionWitness();
        const report = (outcome) =>
          options.onReadSnapshot?.({
            ...execution.snapshot(outcome),
            candidateAudit: { body: SECRET },
            query: SECRET,
            sql: SECRET,
            bindings: [SECRET],
          });
        report('pending');
        if (mode === 'deadline') checkSearchExecution({ deadlineAt: Date.now() - 1 });
        if (mode === 'budget' || mode === 'caller' || mode === 'late-reject') {
          if (mode === 'caller' || mode === 'late-reject') queueMicrotask(() => caller.abort(new Error(SECRET)));
          return new Promise((_resolve, reject) => {
            lateReject = reject;
            if (mode !== 'late-reject')
              options.signal.addEventListener(
                'abort',
                () => {
                  report('rejected');
                  reject(options.signal.reason);
                },
                { once: true },
              );
          });
        }
        execution.observe({ phase: 'sql-finish', sql: { ...sql, elapsedMs: 4, rows: null } });
        report('rejected');
        throw original;
      },
    },
  });
  // Ordinary per-source failures remain tolerated. A separate pending source makes the
  // whole call stop later, preserving the first reader's already-observed outcome.
  const holdOther = ['deadline', 'reader', 'spoof-deadline', 'unknown'].includes(mode);
  const project = holdOther
    ? {
        discoverySource: async () => ({
          id: 'neutral-pending-project',
          read: () => new Promise(() => {}),
          project: async () => null,
          revalidate: async () => null,
          key: () => 'neutral',
        }),
      }
    : undefined;
  const owners = new OwnerPreparationSources({
    ...(project ? { project } : {}),
    messages: service,
    taste: { resolveExplicit: async () => null },
  });
  f.deps.sources.create = (input) => owners.create(input);
  return {
    ...f,
    logs,
    caller,
    original,
    run: () =>
      f.service.prepare({
        auth: f.auth,
        activity: 'html',
        query: SECRET,
        receivedAt: Date.now(),
        deadlineAt: Date.now() + 550,
        signal: caller.signal,
      }),
    rejectLate: () => lateReject?.(original),
  };
}
