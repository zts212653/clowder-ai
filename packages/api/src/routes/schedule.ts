/**
 * Schedule Panel API Routes (F139 Phase 2)
 *
 * GET  /api/schedule/tasks              → list registered tasks + summaries
 * GET  /api/schedule/tasks/:id/runs     → run history (optional ?threadId= filter)
 * POST /api/schedule/tasks/:id/trigger  → manual trigger
 * POST /api/schedule/nl-config          → natural language → TaskSpec proposal
 */

import type { FastifyPluginAsync } from 'fastify';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { TriggerSpec } from '../infrastructure/scheduler/types.js';

export interface ScheduleRoutesOptions {
  taskRunner: TaskRunnerV2;
}

/** Extract threadId from subjectKey — handles both thread-xxx (real tasks) and thread:xxx formats */
export function extractThreadId(subjectKey: string): string | null {
  if (subjectKey.startsWith('thread-')) return subjectKey.slice(7);
  if (subjectKey.startsWith('thread:')) return subjectKey.slice(7);
  return null;
}

export const scheduleRoutes: FastifyPluginAsync<ScheduleRoutesOptions> = async (app, opts) => {
  const { taskRunner } = opts;

  // GET /api/schedule/tasks
  app.get('/api/schedule/tasks', async () => {
    const summaries = taskRunner.getTaskSummaries();
    return { tasks: summaries };
  });

  // GET /api/schedule/tasks/:id/runs
  app.get('/api/schedule/tasks/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { threadId, limit } = request.query as { threadId?: string; limit?: string };
    const maxRows = Math.min(Number(limit) || 50, 200);

    const registered = taskRunner.getRegisteredTasks();
    if (!registered.includes(id)) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const ledger = taskRunner.getLedger();
    let runs: import('../infrastructure/scheduler/types.js').RunLedgerRow[];

    // AC-C3b-1: filter by threadId at SQL level (P2-1 fix: avoid post-LIMIT filtering)
    if (threadId) {
      // Try both subject_key formats used by real tasks
      const hyphenKey = `thread-${threadId}`;
      const colonKey = `thread:${threadId}`;
      const hyphenRuns = ledger.queryBySubject(id, hyphenKey, maxRows);
      const colonRuns = ledger.queryBySubject(id, colonKey, maxRows);
      runs = [...hyphenRuns, ...colonRuns].sort(
        (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
      );
      if (runs.length > maxRows) runs = runs.slice(0, maxRows);
    } else {
      runs = ledger.query(id, maxRows);
    }

    return {
      runs: runs.map((r) => ({
        ...r,
        threadId: extractThreadId(r.subject_key),
      })),
    };
  });

  // POST /api/schedule/tasks/:id/trigger
  app.post('/api/schedule/tasks/:id/trigger', async (request, reply) => {
    const { id } = request.params as { id: string };
    const registered = taskRunner.getRegisteredTasks();
    if (!registered.includes(id)) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    await taskRunner.triggerNow(id);
    return { success: true, taskId: id };
  });

  // POST /api/schedule/nl-config (AC-C4)
  app.post('/api/schedule/nl-config', async (request, reply) => {
    const { prompt } = (request.body ?? {}) as { prompt?: string };
    if (!prompt?.trim()) {
      reply.status(400);
      return { error: 'Missing prompt' };
    }

    const proposal = parseNlToTrigger(prompt.trim());
    if (!proposal) {
      return {
        proposal: null,
        confirmation:
          'Could not parse your request. Try something like "every 30 minutes check stale issues" or "daily at 9am summarize threads".',
      };
    }

    return {
      proposal: {
        trigger: proposal.trigger,
        description: proposal.description,
      },
      confirmation: `Understood: ${proposal.description}. This would create a task with ${proposal.trigger.type === 'cron' ? `cron "${proposal.trigger.expression}"` : `${proposal.trigger.ms}ms interval`}. (Registration coming in Phase 3)`,
    };
  });
};

/** Parse natural language into a trigger spec (best-effort, regex-based) */
export function parseNlToTrigger(input: string): { trigger: TriggerSpec; description: string } | null {
  const lower = input.toLowerCase();

  // "every N minutes/hours"
  const intervalMatch = lower.match(/every\s+(\d+)\s*(min(?:ute)?s?|hours?|h|m)/);
  if (intervalMatch) {
    const n = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    const ms = unit.startsWith('h') ? n * 3600000 : n * 60000;
    return {
      trigger: { type: 'interval', ms },
      description: `Every ${n} ${unit.startsWith('h') ? 'hour' : 'minute'}${n > 1 ? 's' : ''}`,
    };
  }

  // "daily at HH:MM" or "every day at HH"
  const dailyMatch = lower.match(/(?:daily|every\s*day)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?/);
  if (dailyMatch) {
    const hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2] ?? 0);
    if (hour > 23 || minute > 59) return null;
    return {
      trigger: { type: 'cron', expression: `${minute} ${hour} * * *` },
      description: `Daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }

  // "hourly"
  if (/\bhourly\b/.test(lower)) {
    return {
      trigger: { type: 'cron', expression: '0 * * * *' },
      description: 'Every hour',
    };
  }

  return null;
}
