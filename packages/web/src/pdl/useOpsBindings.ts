'use client';
import type {
  BootstrapReport,
  BrakeCheckinResponse,
  BrakeSettings,
  GovernanceHealthSummary,
  GovernanceProvider,
  GovernanceSelection,
  LeaderboardStatsResponse,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionSnapshot } from '@/components/agent-session-types';
import type { HandoffSummary, RawEvent } from '@/components/audit/session-event-types';
import { discoverUnsynced, postGovernanceOperation } from '@/components/governance-operations';
import type { AccountsResponse, ProfileItem } from '@/components/hub-accounts.types';
import type { ClaudeRescueRunResult, ClaudeRescueSessionItem } from '@/components/hub-claude-rescue.types';
import {
  projectAccountQuota,
  reconcileQuotaProfiles,
  refreshAccountQuotaPools,
  resolveConfiguredQuotaPlatforms,
} from '@/components/hub-quota-refresh';
import {
  type EnvVar,
  filterTelemetryEditable,
  type HealthData,
  type MetricsSnapshot,
} from '@/components/observability-helpers';
import { type QuotaResponse } from '@/components/quota-data';
import type {
  ExternalRuntimeSessionListItem,
  ExternalRuntimeSessionsListResponse,
} from '@/components/runtime-sessions/external-runtime-session-types';
import type { CallbackAuthSnapshot } from '@/hooks/useCallbackAuthSnapshot';
import { useBrakeStore } from '@/stores/brakeStore';
import type { Thread, ThreadRoutingPolicyV1 } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import type { ChatData } from './chat-models';
import { failRead, request, write } from './owner-api';

interface OpsUi {
  opsView: string;
  obsV: string;
  lbRange: string;
  toolCat: string;
  toolType: string;
  toolRange: number;
  rpReview: boolean;
  rpArch: boolean;
  rtF?: 'all' | 'active' | 'sealed' | 'attention';
  rtView?: string | null;
  rtTab?: 'chat' | 'handoff' | 'raw';
  rtPage?: number;
  govPath?: string | null;
  gov?: Record<string, boolean | string>;
  rescueSel?: Record<string, boolean>;
}
type RuntimeOverflow = {
  oversized: true;
  drillDown: { tool: string; args: Record<string, string | number> };
};
type RuntimeChat =
  | { eventNo: number; role: string; content: string; timestamp: number; invocationId?: string }
  | (RuntimeOverflow & { eventNo: number; role: string; contentLength: number });
type RuntimeHandoff =
  | (HandoffSummary & { startEventNo?: number })
  | (RuntimeOverflow & { invocationId: string; eventCount: number; startEventNo?: number });
type RuntimePage = { total: number; nextCursor?: { eventNo: number } } & (
  | { messages: RuntimeChat[] }
  | { invocations: RuntimeHandoff[] }
  | { events: (RawEvent | (RuntimeOverflow & { eventNo: number; eventChars: number; invocationId?: string }))[] }
);
interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  invocations: number;
}
interface Usage {
  daily: { date: string; cats: Record<string, Omit<Totals, 'invocations'> & { participations: number }> }[];
  grandTotal: Totals;
}
interface Tools {
  summary: { totalCalls: number; byCategory: Record<string, number> };
  topTools: { name: string; category: string; count: number }[];
  daily: { date: string; native: number; mcp: number; skill: number }[];
  byCat: Record<string, Record<string, number>>;
}
interface RouteSpan {
  traceId: string;
  spanId: string;
  name: string;
}
interface StepSummary {
  traceId: string;
  routeSpanId?: string;
  agent_loop_count: number | null;
  tool_call_count: number | null;
  a2a_dispatch_count: number | null;
  duration_ms: number;
  token_total: number;
  error_count: number;
  is_restored: boolean;
  width_avg_tools_per_loop: number | null;
  agent_loop_partial: boolean;
}
interface OpsRead {
  daemon?: AgentSessionSnapshot[];
  quota?: QuotaResponse;
  profiles?: ProfileItem[];
  thread?: Thread;
  usage?: Usage;
  tools?: Tools;
  lb?: LeaderboardStatsResponse;
  health?: HealthData;
  system?: { storage: { mode: 'redis' | 'memory'; persistent: boolean; warning: string | null } };
  steps?: { route: RouteSpan; summary: StepSummary }[];
  auth?: CallbackAuthSnapshot;
  env?: EnvVar[];
  metrics?: MetricsSnapshot[];
  sessions?: ExternalRuntimeSessionsListResponse['sessions'];
  runtime?: { session: ExternalRuntimeSessionListItem; page: RuntimePage };
  governance?: GovernanceHealthSummary[];
  brake?: BrakeSettings;
  rescue?: ClaudeRescueSessionItem[];
}
export function useBrakeBindings(ready: boolean) {
  const visible = useBrakeStore((s) => s.visible),
    level = useBrakeStore((s) => s.level),
    minutes = useBrakeStore((s) => s.activeMinutes),
    bypassDisabled = useBrakeStore((s) => s.bypassDisabled);
  useEffect(() => {
    if (ready && visible) window.clowderChat.emit('brake:show', { level, minutes, bypassDisabled });
  }, [ready, visible, level, minutes, bypassDisabled]);
}
export function useOpsBindings(data: ChatData, ui: OpsUi, needed: boolean | number = false) {
  const { threadId } = data;
  const { opsView, obsV, lbRange, toolCat, toolType, toolRange, rtView, rtTab = 'chat', rtPage = 1 } = ui;
  const key = JSON.stringify([opsView, obsV, lbRange, toolCat, toolType, toolRange, threadId, rtView, rtTab, rtPage]);
  const cursors = useRef<{ key: string; pages: number[] }>({ key: '', pages: [0] });
  const [read, setRead] = useState<{ key: string; load: string; value?: OpsRead }>({ key: '', load: 'loading' });
  const governance = useRef<{
    path: string;
    operation: 'install' | 'cleanup';
    selection: GovernanceSelection;
    report: BootstrapReport;
  } | null>(null);
  const governanceEpoch = useRef(0);
  const rescueRun = useRef<ClaudeRescueRunResult | null>(null);
  const profiles = useRef<ProfileItem[]>([]),
    epoch = useRef(0);
  const liveKey = useRef(key),
    writing = useRef(false);
  liveKey.current = key;
  const reload = useCallback(
    async (force = false) => {
      if (liveKey.current !== key) return;
      const generation = ++epoch.current;
      setRead((s) => ({ key, load: 'loading', value: s.key === key ? s.value : undefined }));
      try {
        let value: OpsRead = {};
        if (opsView === 'quota') {
          const params = new URLSearchParams({ days: String(toolRange) });
          if (toolCat) params.set('catId', toolCat);
          if (toolType) params.set('category', toolType);
          if (force) params.set('refresh', '1');
          const [quota, accounts, thread, usage, tools] = await Promise.all([
            request<QuotaResponse>('/api/quota', undefined, { afterCurrentGet: true }),
            request<AccountsResponse>('/api/accounts', undefined, { afterCurrentGet: true }),
            request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`),
            request<Usage>(`/api/usage/daily?days=7${force ? '&refresh=1' : ''}`),
            request<Tools>(`/api/usage/tools?${params}`),
          ]);
          if (generation !== epoch.current) return;
          profiles.current = reconcileQuotaProfiles(accounts.providers, profiles.current);
          value = { quota, profiles: profiles.current, thread, usage, tools };
        } else if (opsView === 'lb')
          value.lb = await request<LeaderboardStatsResponse>(
            `/api/leaderboard/stats?range=${encodeURIComponent(lbRange)}`,
          );
        else if (opsView === 'rt' && rtView) {
          const scope = JSON.stringify([rtView, rtTab]);
          if (cursors.current.key !== scope) cursors.current = { key: scope, pages: [0] };
          const [session, page] = await Promise.all([
            request<ExternalRuntimeSessionListItem>(`/api/external-runtime-sessions/${encodeURIComponent(rtView)}`),
            request<RuntimePage>(
              `/api/sessions/${encodeURIComponent(rtView)}/events?${new URLSearchParams({ view: rtTab, cursor: String(cursors.current.pages[rtPage - 1]), limit: '30' })}`,
            ),
          ]);
          if (session.sessionId !== rtView) throw new Error('运行时会话来源不一致');
          if (generation !== epoch.current) return;
          if (page.nextCursor) cursors.current.pages[rtPage] = page.nextCursor.eventNo;
          value.runtime = { session, page };
        } else if (opsView === 'daemon') value.daemon = await request<AgentSessionSnapshot[]>('/api/agent-sessions');
        else if (opsView === 'rt')
          value.sessions = (
            await request<ExternalRuntimeSessionsListResponse>(
              '/api/external-runtime-sessions?runtime=antigravity-desktop&limit=100',
            )
          ).sessions;
        else if (opsView === 'obs' && obsV !== 'auth') {
          const [response, system] = await Promise.all([
            apiFetch('/api/telemetry/health'),
            request<NonNullable<OpsRead['system']>>('/api/system/status'),
          ]);
          if (!response.ok && response.status !== 503) throw new Error(`健康读取失败 (${response.status})`);
          const health: HealthData | { error: string } = await response.json();
          if ('error' in health) throw new Error(health.error);
          value.health = health;
          value.system = system;
          if (obsV === 'overview') {
            const [env, metrics] = await Promise.all([
              request<{ variables: EnvVar[] }>('/api/config/env-summary'),
              request<{ snapshots: MetricsSnapshot[] }>(
                `/api/telemetry/metrics/history?since=${Date.now() - 30 * 60 * 1000}`,
              ),
            ]);
            value.env = env.variables;
            value.metrics = metrics.snapshots;
            if (health.otelEnabled) {
              const { spans } = await request<{ spans: RouteSpan[] }>('/api/telemetry/traces');
              value.steps = await Promise.all(
                spans
                  .filter((span) => span.name === 'cat_cafe.route')
                  .map(async (route) => ({
                    route,
                    summary: await request<StepSummary>(
                      `/api/telemetry/step-summary?${new URLSearchParams({ traceId: route.traceId, routeSpanId: route.spanId })}`,
                    ),
                  })),
              );
            }
          }
        } else if (opsView === 'gov')
          value.governance = await discoverUnsynced(
            (await request<{ projects: GovernanceHealthSummary[] }>('/api/governance/health')).projects,
          );
        else if (opsView === 'brake') value.brake = await request<BrakeSettings>('/api/brake/settings');
        else if (opsView === 'rescue') {
          value.rescue = (
            await request<{ sessions: ClaudeRescueSessionItem[] }>('/api/claude-rescue/sessions')
          ).sessions;
          if (generation === epoch.current)
            ui.rescueSel = Object.fromEntries(
              value.rescue.map((r) => [r.sessionId, ui.rescueSel?.[r.sessionId] ?? true]),
            );
        } else if (opsView === 'obs' && obsV === 'auth')
          value.auth = await request<CallbackAuthSnapshot>('/api/debug/callback-auth');
        if (generation === epoch.current) setRead({ key, load: '', value });
      } catch (error) {
        if (generation === epoch.current) setRead((s) => ({ ...s, key, load: 'error' }));
        failRead(error);
      }
    },
    [key, opsView, obsV, lbRange, toolCat, toolType, toolRange, threadId, rtView, rtTab, rtPage],
  );
  useEffect(() => {
    if (!needed) return; // Periodic while this operational source is projected.
    const poll = () => {
      if (!document.hidden) void reload().catch(() => {});
    };
    poll();
    const interval = opsView === 'quota' || (opsView === 'obs' && obsV !== 'auth') ? 30_000 : 0;
    const timer = interval ? setInterval(poll, interval) : undefined;
    document.addEventListener('visibilitychange', poll);
    return () => {
      ++epoch.current;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [needed, reload, opsView, obsV]);
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'brakeCheckin') {
      const receipt = await write<BrakeCheckinResponse>('/api/brake/checkin', {
        choice: args.choice,
        reason: args.reason,
      });
      if (!receipt.ok) throw new Error('休息提醒状态已变化，请重新读取');
      if (receipt.bypassDisabled) {
        useBrakeStore.setState({ bypassDisabled: true });
        throw new Error('继续次数已用完，请选择休息或收尾');
      }
      useBrakeStore.getState().hide();
      return true;
    }
    if (name === 'opsGovSelection') {
      governanceEpoch.current++;
      governance.current = null;
      setRead((s) => ({ ...s }));
      return true;
    }
    if (name === 'wsGovPrev' || name === 'wsGovApply') {
      const path = ui.govPath!,
        ticket = ++governanceEpoch.current;
      const g = ui.gov || {};
      const selection: GovernanceSelection = {
        ...(g.guide
          ? { projectGuide: { thinEntrypoints: (['claude', 'gemini'] as const).filter((v) => !!g[v]) } }
          : {}),
        ...(g.skills
          ? {
              projectSkills: {
                skillIds: [
                  ...new Set(
                    String(g.sk || '')
                      .split(/[\s,]+/)
                      .filter(Boolean),
                  ),
                ].sort(),
                providers: (['claude', 'codex', 'gemini', 'kimi'] as GovernanceProvider[]).filter(
                  (v) => !!g['pv-' + v],
                ),
              },
            }
          : {}),
        ...(g.docs ? { docsLifecycle: true } : {}),
      };
      const previous = governance.current;
      if (
        name === 'wsGovApply' &&
        (!previous || previous.path !== path || JSON.stringify(previous.selection) !== JSON.stringify(selection))
      )
        throw new Error('选择已变化，请重新预览');
      const operation = name === 'wsGovApply' ? previous!.operation : args.v === 'undo' ? 'cleanup' : 'install';
      const result = await postGovernanceOperation(
        path,
        operation,
        name === 'wsGovPrev',
        selection,
        previous?.report ?? null,
      );
      if (ui.govPath !== path || ticket !== governanceEpoch.current) return true;
      governance.current = { path, operation, selection, report: result.report };
      setRead((s) => ({ ...s }));
      if (result.conflict) throw new Error('项目状态已变化，请重新确认最新预览');
      if (name === 'wsGovApply') {
        governance.current = null;
        await reload();
      }
      return true;
    }
    if (name === 'opsBrakeSet') {
      const patch =
        args.k === 'enabled'
          ? { enabled: (args.v as unknown) === true }
          : args.k === 'thresholdMinutes'
            ? { thresholdMinutes: Number(args.v) }
            : { mode: args.v as BrakeSettings['mode'] };
      await write('/api/brake/settings', patch, 'PUT');
      await reload();
      return true;
    }
    if (name === 'wsScan') {
      await reload();
      return true;
    }
    if (name === 'wsRescue') {
      const sessions = read.key === key ? read.value?.rescue : undefined;
      const sessionIds = sessions!.filter((r) => ui.rescueSel?.[r.sessionId]).map((r) => r.sessionId);
      const result = await write<ClaudeRescueRunResult>('/api/claude-rescue/rescue', { sessionIds });
      rescueRun.current = result;
      await reload();
      return true;
    }

    if (name === 'opsEnvSet') {
      const owner = read.key === key ? read.value : undefined;
      if (!owner?.env || !filterTelemetryEditable(owner.env).some((v) => v.name === args.name))
        throw new Error('该配置不能在运行时修改');
      await write('/api/config/env', { updates: [{ name: args.name, value: args.v }] }, 'PATCH');
      await reload();
      return true;
    }
    if (name === 'opsBrowse') {
      setRead((s) => ({ ...s }));
      return true;
    }
    if (
      name === 'refresh' &&
      [
        'ops',
        'quota',
        'usage',
        'toolLog',
        'lb',
        'obs',
        'health',
        'auth',
        'daemon',
        'runtime',
        'gov',
        'brake',
        'rescue',
      ].includes(args.k)
    ) {
      if (args.k === 'quota') {
        const warnings = await refreshAccountQuotaPools(
          profiles.current,
          resolveConfiguredQuotaPlatforms(profiles.current, data.cats),
          (account, observation) => {
            const next = projectAccountQuota(profiles.current, account, observation);
            if (next) profiles.current = next;
          },
        );
        await reload(true);
        if (warnings.length) throw new Error(warnings.join('；'));
      } else await reload(true);
      return true;
    }
    if (name === 'routingPolicySet') {
      const current = read.key === key ? read.value?.thread : null;
      if (!current) throw new Error('对话路由策略尚未读取');
      if (writing.current) throw new Error('路由策略正在保存');
      const scope = args.field === 'rpReview' ? 'review' : 'architecture',
        field = scope === 'review' ? 'avoidCats' : 'preferCats';
      const policy: ThreadRoutingPolicyV1 = {
        ...current.routingPolicy,
        v: 1,
        scopes: { ...current.routingPolicy?.scopes },
      };
      const rule = { ...policy.scopes?.[scope] },
        cats = rule[field] ?? [];
      rule[field] = (args.value as unknown as boolean)
        ? [...new Set([...cats, 'opus'])]
        : cats.filter((c) => c !== 'opus');
      if (scope === 'review' && !policy.scopes?.review && rule[field]!.length) rule.reason = 'budget';
      policy.scopes![scope] = rule;
      writing.current = true;
      setRead((s) => ({ ...s }));
      try {
        await write(`/api/threads/${encodeURIComponent(threadId)}`, { routingPolicy: policy }, 'PATCH');
        await reload();
      } finally {
        writing.current = false;
        setRead((s) => ({ ...s }));
      }
      return true;
    }
    return false;
  };
  const rawData = useMemo(
    () => ({
      read,
      governance: governance.current,
      rescueRun: rescueRun.current,
      profiles: profiles.current,
      writing: writing.current,
    }),
    [read, governance.current, rescueRun.current, profiles.current, writing.current],
  );
  return {
    action,

    data: rawData,
  };
}
