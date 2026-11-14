import { getCoCreatorConfig } from '../../../../../config/cat-config-loader.js';
import { getCoCreatorDisplay } from '../../../../../config/co-creator-display.js';
import { getSenderName } from '../../context/ContextAssembler.js';
import { renderSegment } from '../../context/prompt-template-loader.js';
import { formatPromptTime } from '../../format-time.js';
import type { ThreadExecutionSituation } from '../invocation/thread-execution-situation.js';
import type { InvocationSource } from './navigation-sources.js';

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  ownerCatId: string | null;
  /** Thread/owner-level registered wait; undefined means the read was unavailable. */
  hasActiveWait?: boolean;
}

export function summarizeActiveTasks(
  tasks: Array<{ id: string; title: string; status: string; ownerCatId: string | null; updatedAt: number }>,
): TaskSummary[] {
  return tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map(({ id, title, status, ownerCatId }) => ({ id, title, status, ownerCatId }));
}

export interface NavigationArtifact {
  type: string;
  ref: string;
  label: string;
  updatedBy: string;
}

export interface TruthSourceInfo {
  label: string;
  ref: string;
  provenance: 'canonical' | 'regex' | 'recency';
}

export interface NavigationContext {
  threadId?: string;
  threadTitle?: string;
  currentCatId?: string;
  sources?: readonly InvocationSource[];
  tasks: TaskSummary[];
  executionSituation?: ThreadExecutionSituation;
  artifacts?: NavigationArtifact[];
  truthSource?: TruthSourceInfo | null;
  /** Explicit original roadmap pointer; never a directive or custody grant. */
  roadmapPointer?: string;
}

export interface NavigationFormatOptions {
  nowMs?: number;
}

function situationSourceLabel(from: import('@cat-cafe/shared').MessageFrom): string {
  switch (from.kind) {
    case 'user':
      return `${getCoCreatorDisplay().nickname}`;
    case 'agent':
      return getSenderName(from.catId);
    case 'external':
      return `external:${from.connectorId}`;
    case 'plugin':
      return `plugin:${from.instanceId}`;
    case 'system':
      return `system:${from.service}`;
  }
}

/**
 * Build navigation inner content (conditional blocks).
 * Template envelope ([导航]...[/导航]) is in n1-navigation.md.
 */
function buildNavigationInner(ctx: NavigationContext, options?: NavigationFormatOptions): string {
  const lines: string[] = [];
  const coCreatorTimeZone = getCoCreatorConfig().timeZone;
  const nowMs = options?.nowMs;
  if (typeof nowMs === 'number') {
    lines.push(
      `当前时间: ${formatPromptTime(nowMs, { timeZone: coCreatorTimeZone })} (relative terms use this now; refreshed per invocation)`,
    );
  }

  if (ctx.sources?.length) {
    lines.push('本轮输入来源（触发事实，不表示接责或新增授权）:');
    for (const source of ctx.sources) lines.push(`  - ${formatInvocationSource(source)}`);
  }

  if (ctx.tasks.length > 0) {
    lines.push('活跃毛线球:');
    for (const t of ctx.tasks) {
      const owner = t.ownerCatId ? `@${t.ownerCatId}` : '未分配';
      const waitFact =
        t.ownerCatId === ctx.currentCatId && t.status !== 'done' && t.hasActiveWait === false ? ' [未挂等待]' : '';
      lines.push(`  - [${t.status}] ${t.title} (${owner})${waitFact}`);
    }
  }

  if (ctx.executionSituation) {
    const visibleRuns = ctx.executionSituation.activeRuns.filter((run) => run.targetId !== ctx.currentCatId);
    if (!ctx.executionSituation.complete) {
      lines.push('成员运行态: 当前无法完整验证（不按最近发言推断）');
    } else if (visibleRuns.length === 0) {
      lines.push('成员运行态: 当前无其他成员执行');
    } else {
      lines.push('成员运行态（生命周期真相）:');
      for (const run of visibleRuns) {
        const sources = run.sources
          .map((source) => `${source.messageId} ← ${situationSourceLabel(source.from)}`)
          .join(', ');
        lines.push(
          `  - [processing] ${getSenderName(run.targetId)} (${run.targetId}) · 来源 ${sources} · response=${run.responseMessageId} · invocation=${run.invocationId}`,
        );
      }
    }
  }

  if (ctx.artifacts && ctx.artifacts.length > 0) {
    lines.push('最近产物:');
    for (const a of ctx.artifacts) {
      lines.push(`  - [${a.type}] ${a.label} (${a.updatedBy})`);
    }
  }

  if (ctx.truthSource) {
    const tag = ctx.truthSource.provenance === 'regex' ? ' (推断)' : '';
    lines.push(`工作材料: ${ctx.truthSource.label}${tag} — ${ctx.truthSource.ref}`);
  }

  if (ctx.roadmapPointer) lines.push(ctx.roadmapPointer);
  return lines.join('\n');
}

export function formatInvocationSource(source: InvocationSource): string {
  const time = formatPromptTime(source.timestamp, { timeZone: getCoCreatorConfig().timeZone });
  const origin = source.sourceThreadId
    ? ` · 来源thread=${source.sourceThreadId}${source.sourceMessageId ? `#${source.sourceMessageId}` : ''}`
    : '';
  return `${source.fromSpeakerDisplay} · messageId=${source.fromMessageId} · ${time}${origin}`;
}

/* @segment N1 — 导航块 (template: n1-navigation.md) */
export function formatNavigationHeader(ctx: NavigationContext, options?: NavigationFormatOptions): string {
  return renderSegment('N1', { INNER_CONTENT: buildNavigationInner(ctx, options) }) ?? '[导航]\n[/导航]';
}
