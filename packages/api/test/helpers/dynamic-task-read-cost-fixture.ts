import type { DevelopmentReturnRegistrationV1 } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { DynamicTaskDef, DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import type { TaskTemplate } from '../../src/infrastructure/scheduler/templates/types.js';
export function definition(id: string, enabled: boolean, templateId = 'fixture'): DynamicTaskDef {
  return {
    id,
    enabled,
    templateId,
    trigger: { type: 'once', fireAt: Date.now() + 86_400_000 },
    params: {},
    display: { label: id, category: 'system' },
    deliveryThreadId: 'original',
    createdBy: 'codex61-sol',
    createdAt: '2026-10-10T00:00:00.000Z',
  };
}
export function history(store: DynamicTaskStore) {
  for (let i = 0; i < 200; i++)
    store.insert({ ...definition(`history-${i}`, false), params: { payload: 'x'.repeat(10_000) } });
}
export function countHydratedRows(db: Database.Database) {
  const counts: number[] = [];
  const original = db.prepare;
  db.prepare = new Proxy(original, {
    apply(prepare, receiver, args) {
      const statement = Reflect.apply(prepare, receiver, args) as Database.Statement;
      if (/FROM dynamic_task_defs/i.test(String(args[0])))
        statement.all = new Proxy(statement.all, {
          apply(all, statementReceiver, bindings) {
            const rows = Reflect.apply(all, statementReceiver, bindings) as unknown[];
            counts.push(rows.length);
            return rows;
          },
        });
      return statement;
    },
  });
  return {
    counts,
    stop: () => {
      db.prepare = original;
    },
  };
}
export const template: TaskTemplate = {
  templateId: 'fixture',
  label: 'fixture',
  category: 'system',
  description: 'fixture',
  subjectKind: 'thread',
  defaultTrigger: { type: 'interval', ms: 60_000 },
  paramSchema: {},
  createSpec: (id, input) => ({
    id,
    profile: 'awareness',
    trigger: input.trigger,
    admission: { gate: async () => ({ run: false, reason: 'fixture' }) },
    run: { overlap: 'skip', timeoutMs: 1000, execute: async () => {} },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
  }),
};
export function registration(id: string, status: 'waiting' | 'retired'): DevelopmentReturnRegistrationV1 {
  return {
    v: 1,
    registrationId: id,
    ownerUserId: 'owner',
    ownerThreadId: 'original',
    ownerCatId: 'codex61-sol',
    taskRef: `task:work:${id}`,
    observedRevision: 3,
    proposalId: id,
    executionThreadId: 'child',
    reporterCatIds: ['codex61-sol'],
    sourceActionRef: 'message:authorized',
    sourceMessageRevision: `sha256:${'a'.repeat(64)}`,
    expectedSignal: 'terminal_report',
    slaUntil: Date.now() + 86_400_000,
    registeredAt: 1000,
    status,
    ...(status === 'retired' ? { reason: 'cancelled' as const } : {}),
  };
}
