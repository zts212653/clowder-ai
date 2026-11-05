import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ApprovalIngress } from '../../../api/dist/domains/approval-hub/ApprovalIngress.js';
import { F139ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F139ApprovalAdapter.js';
import { applyMigrations } from '../../../api/dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../../api/dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../../api/dist/infrastructure/scheduler/RunLedger.js';
import {
  fingerprintDynamicTaskDef,
  ScheduleMutationProposalStore,
} from '../../../api/dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { TaskRunnerV2 } from '../../../api/dist/infrastructure/scheduler/TaskRunnerV2.js';
import { reminderTemplate } from '../../../api/dist/infrastructure/scheduler/templates/reminder.js';
import { buildScheduleMutationCardBlock } from '../../../api/dist/routes/schedule-mutation-card-block.js';
import { scheduleProposalDecisionRoutes } from '../../../api/dist/routes/schedule-proposal-decision-routes.js';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Actual private SQLite proposal/task/audit stores and original TaskRunner registration. The runner is never started. */
export async function createInboxScheduleFixture(language) {
  const f = await createInboxProposalFixture({
    configureApprovals: async ({ app, owner, messages, threads, socketManager }) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'f322-schedule-'));
      const db = new Database(path.join(directory, 'schedule.sqlite'));
      applyMigrations(db);
      const store = new ScheduleMutationProposalStore(db),
        tasks = new DynamicTaskStore(db);
      const runner = new TaskRunnerV2({
        logger: { info() {}, error() {} },
        ledger: new RunLedger(db),
        dynamicTaskStore: tasks,
      });
      const notifications = [],
        records = [];
      const close = async () => {
        runner.stop();
        db.close();
        await rm(directory, { recursive: true, force: true });
      };
      try {
        const template = { ...reminderTemplate, label: language === 'en' ? 'Reminder' : '定时提醒' };
        const ingress = new ApprovalIngress({ messageStore: messages, socketManager });
        for (const action of ['reject', 'create', 'delete', 'recover']) {
          const label = language === 'en' ? `Evidence reminder ${action}` : `证据提醒 ${action}`;
          const thread = threads.create(owner, label, 'default');
          const destination = threads.create(
            owner,
            language === 'en' ? 'Original evidence discussion' : '原证据讨论',
            'default',
          );
          const origin = messages.append({
            userId: owner,
            threadId: thread.id,
            from: { kind: 'user', userId: owner },
            content:
              language === 'en' ? 'Use the original schedule and verify its outcome.' : '沿原定时任务核实处理结果。',
            timestamp: Date.now(),
          });
          const task = {
            id: `private-schedule-${action}`,
            templateId: 'reminder',
            trigger: { type: 'once', fireAt: Date.now() + 3600000 },
            params: {
              message:
                (language === 'en' ? 'Check the original evidence.' : '核对原始证据。') +
                '\nOriginal bounded reminder.\n'.repeat(45),
              triggerUserId: owner,
              targetCatId: 'codex61-sol',
            },
            display: {
              label,
              category: 'thread',
              description:
                language === 'en' ? 'Verify the original record before interpreting it.' : '解释之前核对原记录。',
            },
            deliveryThreadId: destination.id,
            enabled: true,
            createdBy: 'codex61-sol',
            createdAt: new Date().toISOString(),
          };
          if (action === 'delete') {
            tasks.insert(task);
            const spec = template.createSpec(task.id, {
              trigger: task.trigger,
              params: task.params,
              deliveryThreadId: task.deliveryThreadId,
            });
            spec.display = task.display;
            runner.registerDynamic(spec, task.id);
          }
          const proposal = {
            proposalId: `schedule-${action}`,
            ownerUserId: owner,
            requesterCatId: 'codex61-sol',
            mutation:
              action === 'delete'
                ? {
                    kind: 'delete',
                    taskId: task.id,
                    expectedFingerprint: fingerprintDynamicTaskDef(task),
                    taskSnapshot: task,
                  }
                : { kind: 'create', task, relativeOnceDelayMs: 60000 },
            status: 'pending',
            publication: { state: 'staged', stagedAt: origin.timestamp },
            createdAt: origin.timestamp,
          };
          store.create(proposal);
          const envelope = await ingress.publish(
            {
              producerId: 'F139',
              canonicalProposalId: proposal.proposalId,
              ownerUserId: owner,
              requesterCatId: proposal.requesterCatId,
              originRef: { kind: 'message', threadId: thread.id, messageId: origin.id },
              cardThreadId: thread.id,
              cardContent: language === 'en' ? 'Please check this original scheduled task.' : '请核对这条原定时任务。',
              cardBlock: buildScheduleMutationCardBlock(proposal),
              createdAt: proposal.createdAt,
            },
            store,
          );
          const card = messages.getById(envelope.approvalCardRef.messageId);
          assert.ok(card);
          records.push({
            action,
            proposalId: proposal.proposalId,
            task,
            thread,
            destination,
            envelope,
            card,
            block: card.extra.rich.blocks[0],
          });
        }
        let failNextRegistration = false;
        const templateRegistry = {
          get(id) {
            if (failNextRegistration) {
              failNextRegistration = false;
              return null;
            }
            return id === 'reminder' ? template : null;
          },
        };
        await app.register(scheduleProposalDecisionRoutes, {
          ownerUserId: owner,
          store,
          taskRunner: runner,
          templateRegistry,
          socketManager,
          notifyLifecycle: (n) => notifications.push(n),
        });
        app.get('/api/schedule/templates', async () => ({
          templates: [{ templateId: template.templateId, label: template.label, paramSchema: template.paramSchema }],
        }));
        return {
          adapters: [new F139ApprovalAdapter(store)],
          records,
          store,
          tasks,
          runner,
          failRegistrationOnce() {
            failNextRegistration = true;
          },
          async effects() {
            return {
              proposals: records.map((r) => store.getById(r.proposalId)),
              tasks: tasks.getAll(),
              audit: store.listAudit(owner),
              registered: runner.getTaskSummaries().map((t) => t.id),
              notifications,
            };
          },
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  });
  return f;
}
