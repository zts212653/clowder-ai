'use client';

import { HandoffEventRows, RawEventRows } from '@/components/audit/SessionEventRows';
import { RuntimeMetadataHeader } from '@/components/audit/SessionRuntimeMetadataHeader';
import type { ExternalRuntimeSessionListItem } from '@/components/runtime-sessions/external-runtime-session-types';

const SESSION: ExternalRuntimeSessionListItem = {
  sessionId: 'f269-session-audit-preview',
  threadId: 'external-runtime:antigravity-desktop:f269-preview',
  runtime: 'antigravity-desktop',
  runtimeSessionId: 'cascade-f269-session-audit-preview-tail',
  runtimeConversationId: 'conversation-f269-session-audit-preview-tail',
  catId: 'codex-sol',
  model: 'gpt-5.6-sol',
  lastObservedAt: 1_754_915_200_000,
  lifecycle: {
    state: 'sealed',
    startedAt: 1_754_915_100_000,
    lastObservedAt: 1_754_915_200_000,
    sealReason: 'runtime_disconnected',
  },
  binding: { mode: 'thread', threadId: 'thread_f269_preview', requestedBy: 'agent_key' },
  drilldown: {
    sessionRecord: '/api/sessions/f269-session-audit-preview',
    events: '/api/sessions/f269-session-audit-preview/events',
    digest: '/api/sessions/f269-session-audit-preview/digest',
  },
};

const HANDOFFS = [
  {
    invocationId: 'invocation-f269-session-audit-preview-with-a-preserved-tail',
    eventCount: 28,
    toolCalls: ['Read', 'Edit', 'Bash'],
    errors: 0,
    durationMs: 82_000,
    keyMessages: [],
  },
];

const RAW_EVENTS = [
  {
    eventNo: 41,
    v: 1,
    t: 1_754_915_200_000,
    catId: 'codex-sol',
    event: {
      type: 'tool_result',
      tool: 'cat_cafe_read_invocation_detail',
      content: '完整 JSON payload 进入可访问的技术详情，不再依赖原生 title。',
    },
  },
];

export function SessionAuditRecoveryPreview() {
  return (
    <section
      data-testid="f269-session-audit-recovery"
      className="rounded-3xl border border-cafe bg-[var(--console-card-bg)] p-5 shadow-[var(--console-shadow-soft)] sm:p-7"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-cafe-accent">
        Production spot-check · Session Audit
      </p>
      <h2 className="mt-2 text-lg font-bold text-cafe">元数据保持紧凑，完整诊断仍可达</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-cafe-secondary">
        ID 只有真实溢出时才出现复制入口；Raw 事件保留一行语义摘要，完整 JSON 进入低强调的技术详情。
      </p>

      <div className="mt-5 max-w-xl overflow-hidden rounded-xl border border-cafe">
        <RuntimeMetadataHeader session={SESSION} noise={[]} />
        <div className="grid gap-3 p-3 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="mb-1.5 text-micro font-bold uppercase tracking-[0.1em] text-cafe-muted">Handoff</p>
            <HandoffEventRows invocations={HANDOFFS} />
          </div>
          <div className="min-w-0">
            <p className="mb-1.5 text-micro font-bold uppercase tracking-[0.1em] text-cafe-muted">Raw</p>
            <RawEventRows events={RAW_EVENTS} />
          </div>
        </div>
      </div>
    </section>
  );
}
