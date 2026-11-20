import {
  catRegistry,
  formatCatDisplayName,
  parseWatcherThreadControl,
  WATCHER_PANEL_DEFAULTS,
  type WatcherMemberCapability,
  type WatcherPanelConfig,
  watcherConfigPatchSchema,
  watcherPrimaryCatId,
  watcherRoutingPreference,
  watcherThreadControlPatchSchema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveBuiltinClientForProvider } from '../config/account-resolver.js';
import { readAccountCatalogSnapshot } from '../config/account-store-snapshot.js';
import { resolveThreadAccess } from '../domains/cats/services/session/thread-access-policy.js';
import type { ILabelStore, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import type { IConciergeConfigStore } from '../domains/concierge/ConciergeConfigStore.js';
import { effectiveWatcherState, readWatcherPreferences } from '../domains/concierge/watcher/watcher-controls.js';
import { watcherDailyRows } from '../domains/concierge/watcher/watcher-daily.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

interface WatcherRouteOptions {
  configStore: IConciergeConfigStore;
  threadStore: IThreadStore;
  labelStore: ILabelStore;
  turnExecutionStore: ITurnExecutionStore;
  capability(catId: string): WatcherMemberCapability | Promise<WatcherMemberCapability>;
  controlChanged?(threadId?: string): void;
  runtimeReady?(): boolean;
}
const configBody = watcherConfigPatchSchema.extend({ expectedRevision: z.number().int().nonnegative() });
const controlBody = watcherThreadControlPatchSchema.extend({ expectedRevision: z.number().int().nonnegative() });

/** Person-session only: cat callback credentials never read or change watcher settings or the panel ledger. */
export function watcherOwner(request: FastifyRequest, reply: FastifyReply, write: boolean): string | null {
  if (
    ['x-invocation-id', 'x-callback-token', 'x-agent-key-secret'].some((name) => request.headers[name] !== undefined)
  ) {
    reply.code(403).send({ error: 'Watcher settings require the person’s session' });
    return null;
  }
  const access = requirePluginOwnerLocalAccess(request, write ? 'write' : 'read');
  if ('error' in access) {
    reply.code(access.status).send({ error: access.error });
    return null;
  }
  return access.operator;
}

/** Execution-local overrides stay within the selected member’s account client. Native ACP keeps its own account. */
function panelAccounts(catId?: string): Array<{ id: string; label: string }> {
  try {
    const config = catId ? catRegistry.tryGet(catId)?.config : undefined;
    const client = config ? resolveBuiltinClientForProvider(config.clientId) : catId ? null : 'openai';
    if (!client) return [];
    return Object.entries(readAccountCatalogSnapshot(resolveActiveProjectRoot(process.cwd())))
      .filter(
        ([, account]) =>
          !account.googleCloud &&
          (account.codex ? 'openai' : account.claude ? 'anthropic' : account.agy ? 'google' : account.clientId) ===
            client,
      )
      .filter(
        ([, account]) =>
          config?.agyProfile?.carrier !== 'native' ||
          config.carrier === 'acp' ||
          (account.authType === 'oauth' && !account.baseUrl && Object.keys(account.envVars ?? {}).length === 0),
      )
      .map(([id, account]) => ({ id, label: account.displayName ?? id }));
  } catch {
    return [];
  }
}

async function panelProblem(
  panel: WatcherPanelConfig,
  capability: WatcherRouteOptions['capability'],
): Promise<string | null> {
  for (const member of panel.members) {
    if (!catRegistry.tryGet(member.catId) || !(await capability(member.catId)).supported)
      return `${member.catId} 的守望读取尚未接通`;
    if (member.accountRef && !panelAccounts(member.catId).some((account) => account.id === member.accountRef))
      return `账号 ${member.accountRef} 不可用`;
  }
  return null;
}

export const watcherRoutes: FastifyPluginAsync<WatcherRouteOptions> = async (app, deps) => {
  app.get('/api/watcher/daily', async (request, reply) => {
    const userId = watcherOwner(request, reply, false);
    if (!userId) return;
    const parsed = z
      .object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timezone: z.string().max(100).default('UTC'),
        cursor: z.coerce.number().int().nonnegative().optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'day must be YYYY-MM-DD with a valid timezone' });
    const timestamp = Date.parse(`${parsed.data.day}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== parsed.data.day)
      return reply.code(400).send({ error: 'Invalid day' });
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: parsed.data.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return reply.code(400).send({ error: 'Invalid timezone' });
    }
    const dayOf = (at: number) => {
      const parts = formatter.formatToParts(at);
      return ['year', 'month', 'day'].map((kind) => parts.find((part) => part.type === kind)!.value).join('-');
    };
    const utcDay = Math.floor(timestamp / 86400000);
    const page = await deps.turnExecutionStore.listSettled({
      userId,
      watcherDays: [utcDay - 1, utcDay, utcDay + 1],
      afterSequence: parsed.data.cursor,
      limit: 200,
    });
    return {
      usageVersion: 2,
      day: parsed.data.day,
      timezone: parsed.data.timezone,
      rows: await Promise.all(
        watcherDailyRows(
          page.records,
          (at) => dayOf(at) === parsed.data.day,
          (start, end) => dayOf(start) <= parsed.data.day && (end === undefined || dayOf(end) >= parsed.data.day),
        ).map(async (row) => ({
          ...row,
          title: (await deps.threadStore.get(row.threadId))?.title ?? '已删除的对话',
        })),
      ),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });
  async function settings(userId: string) {
    const preferences = await readWatcherPreferences(deps.configStore, deps.labelStore, userId);
    return {
      ...preferences,
      // The settings switch is the only on/off control; this field only reports whether the watcher runtime is ready.
      rolloutEnabled: deps.runtimeReady?.() ?? true,
      panelDefaults: WATCHER_PANEL_DEFAULTS,
      panelAccounts: panelAccounts(),
      members: await Promise.all(
        catRegistry.getAllIds().map(async (catId) => {
          const config = catRegistry.tryGet(catId)?.config;
          const capability = await deps.capability(catId);
          return {
            catId,
            displayName: config
              ? formatCatDisplayName({
                  displayName: config.nickname ?? config.displayName,
                  variantLabel: config.variantLabel ?? config.defaultModel,
                })
              : catId,
            capability,
            accounts: panelAccounts(catId),
            panelSupported: capability.supported,
          };
        }),
      ),
    };
  }
  app.get('/api/watcher/config', async (request, reply) => {
    const userId = watcherOwner(request, reply, false);
    if (!userId) return;
    return settings(userId);
  });
  app.put('/api/watcher/config', async (request, reply) => {
    const userId = watcherOwner(request, reply, true);
    if (!userId) return;
    const parsed = configBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Invalid watcher settings', details: parsed.error.issues });
    const { expectedRevision, ...patch } = parsed.data;
    const current = (await readWatcherPreferences(deps.configStore, deps.labelStore, userId)).config;
    if (current.revision !== expectedRevision) return reply.code(409).send({ error: '设置已改变，请刷新后重试' });
    // Older clients may still send memberCatId; that choice must not start the retired 30k lane.
    if (
      !patch.routing &&
      (patch.memberCatId ||
        (patch.enabled === true && !current.routing && !current.panel?.enabled && !patch.panel?.enabled))
    ) {
      const catId = patch.memberCatId ?? current.memberCatId;
      if (!catId) return reply.code(422).send({ code: 'WATCHER_PRIMARY_REQUIRED', error: '请先选择主守望猫' });
      patch.routing = {
        ...watcherRoutingPreference(current),
        primary: { catId },
      };
    }
    if (patch.memberCatId && !(await deps.capability(patch.memberCatId)).supported)
      return reply.code(422).send({ code: 'WATCHER_SESSION_UNSUPPORTED', error: '此成员暂不支持守望会话' });
    const problem = patch.panel ? await panelProblem(patch.panel, deps.capability) : null;
    if (problem) return reply.code(422).send({ code: 'WATCHER_PANEL_INVALID', error: problem });
    if (patch.routing) {
      const members = [
        patch.routing.primary,
        ...(patch.routing.whenSameFamily.mode === 'member' ? [patch.routing.whenSameFamily.member] : []),
      ];
      for (const member of members) {
        const capability = await deps.capability(member.catId);
        if (!catRegistry.tryGet(member.catId) || !capability.supported)
          return reply.code(422).send({
            code: 'WATCHER_MEMBER_UNAVAILABLE',
            error: capability.supported ? '成员不存在' : capability.reason,
          });
        if (member.accountRef && !panelAccounts(member.catId).some((account) => account.id === member.accountRef))
          return reply.code(422).send({ code: 'WATCHER_ACCOUNT_UNAVAILABLE', error: '所选账号不可用' });
      }
    }
    if (patch.doNotDisturbLabelIds) {
      const allowed = new Set((await deps.labelStore.list(userId)).map((label) => label.id));
      if (patch.doNotDisturbLabelIds.some((id) => !allowed.has(id)))
        return reply.code(400).send({ error: 'Unknown conversation label' });
    }
    if (!deps.configStore.updateWatcherConfig) return reply.code(503).send({ error: 'Watcher settings unavailable' });
    const restarting =
      (!current.enabled && patch.enabled === true) ||
      (patch.scope !== undefined && patch.scope !== current.scope) ||
      (patch.memberCatId !== undefined && patch.memberCatId !== current.memberCatId) ||
      (patch.routing !== undefined && JSON.stringify(patch.routing) !== JSON.stringify(current.routing)) ||
      // Either watcher mode starts from now; neither replays turns that settled under the other.
      (patch.panel !== undefined && patch.panel.enabled !== (current.panel?.enabled ?? false));
    const floor = restarting ? await deps.turnExecutionStore.settledHead(userId) : undefined;
    if (!(await deps.configStore.updateWatcherConfig(userId, expectedRevision, patch, floor)))
      return reply.code(409).send({ error: '设置已改变，请刷新后重试' });
    deps.controlChanged?.();
    return settings(userId);
  });
  async function thread(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    const userId = watcherOwner(request, reply, write);
    if (!userId) return null;
    const { threadId } = request.params as { threadId: string };
    const row = await deps.threadStore.get(threadId);
    const decision = await resolveThreadAccess({
      threadStore: deps.threadStore,
      thread: row,
      userId,
      request: { resource: 'executions', action: write ? 'cancel' : 'read' },
    });
    if (decision.status !== 200 || !row || row.deletedAt) {
      reply.code(404).send({ error: 'Conversation not found' });
      return null;
    }
    return { row, userId };
  }
  async function snapshot(row: NonNullable<Awaited<ReturnType<IThreadStore['get']>>>, userId: string) {
    const preferences = await readWatcherPreferences(deps.configStore, deps.labelStore, userId);
    const running = await deps.turnExecutionStore.listRunningByUser(userId);
    const primaryCatId = watcherPrimaryCatId(preferences.config);
    const member = primaryCatId ? catRegistry.tryGet(primaryCatId)?.config : undefined;
    return {
      control: parseWatcherThreadControl(row.watcher),
      config: preferences.config,
      ...effectiveWatcherState(preferences.config, row, preferences.quietLabels),
      // The settings switch is the only on/off control; this field only reports whether the watcher runtime is ready.
      rolloutEnabled: deps.runtimeReady?.() ?? true,
      reviewing: running.some((record) => record.threadId === row.id && record.executionKind === 'watcher'),
      reviewingCatIds: [
        ...new Set(
          running
            .filter((record) => record.threadId === row.id && record.executionKind === 'watcher')
            .map((record) => record.catId),
        ),
      ],
      memberName: primaryCatId ? (member?.nickname ?? member?.displayName ?? primaryCatId) : '选择主守望猫',
      capability: primaryCatId
        ? await deps.capability(primaryCatId)
        : { supported: false as const, reason: '请先选择主守望猫' },
    };
  }
  app.get('/api/threads/:threadId/watcher', async (request, reply) => {
    const result = await thread(request, reply, false);
    return result ? snapshot(result.row, result.userId) : undefined;
  });
  app.put('/api/threads/:threadId/watcher', async (request, reply) => {
    const result = await thread(request, reply, true);
    if (!result) return;
    const parsed = controlBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid watcher control' });
    const { expectedRevision, ...patch } = parsed.data;
    const restarting = parseWatcherThreadControl(result.row.watcher).enabled !== true && patch.enabled === true;
    const updated = await deps.threadStore.updateWatcherControl(
      result.row.id,
      expectedRevision,
      patch,
      restarting
        ? { startedAfterSequence: await deps.turnExecutionStore.settledHead(result.userId, result.row.id) }
        : undefined,
    );
    if (!updated) return reply.code(409).send({ error: '对话设置已改变，请刷新后重试' });
    deps.controlChanged?.(result.row.id);
    const row = await deps.threadStore.get(result.row.id);
    return row ? snapshot(row, result.userId) : reply.code(404).send({ error: 'Conversation not found' });
  });
};
