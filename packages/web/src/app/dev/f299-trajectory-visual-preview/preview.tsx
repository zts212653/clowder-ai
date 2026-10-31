'use client';

import type { InvocationTrajectorySummary, RequestGenerationProjectionV1 } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import {
  type InvocationDetailResponse,
  InvocationTrajectoryDetail,
} from '../../../components/workspace/trajectory/InvocationTrajectoryDetail';

const summary: InvocationTrajectorySummary = {
  invocationId: 'inv-f299-visual-parity',
  threadId: 'thread-f299-preview',
  sessionId: 'session-f299-preview',
  sessionSeq: 0,
  sessionStatus: 'active',
  catId: 'codex-sol',
  status: 'running',
  startedAt: 1_000,
  durationMs: 84_000,
  eventCount: 11,
  statusEventCount: 1,
  toolUseCount: 2,
  toolResultCount: 2,
  messageCount: 2,
  errorCount: 1,
  toolNames: ['cat_cafe_get_thread_context', 'exec_command'],
  keyMessages: [],
};

function event(eventNo: number, payload: Record<string, unknown>) {
  return {
    v: 1,
    t: 1_000 + eventNo,
    threadId: summary.threadId,
    catId: summary.catId,
    sessionId: summary.sessionId,
    invocationId: summary.invocationId,
    eventNo,
    event: payload,
  };
}

const detail: InvocationDetailResponse = {
  invocationId: summary.invocationId,
  total: 11,
  summary,
  promptInput: {
    status: 'available',
    messages: [
      {
        messageId: 'message-f299-preview',
        status: 'available',
        author: 'user',
        excerpt: '对照 Design Gate 与真实轨迹：真实版好的留下，设计稿更好的回归。',
      },
    ],
  },
  events: [
    event(0, { type: 'user', content: '开始视觉一致性检查' }),
    event(1, { type: 'text', content: '保留真实版的紧凑密度、单标签与原位工具详情。' }),
    event(2, { type: 'system', content: 'canonical invocation 已绑定 thread 与 session。' }),
    event(3, { type: 'context', content: 'F299 Design Gate 是本次视觉判断的来源。' }),
    event(4, { type: 'status', status: 'running' }),
    event(5, {
      type: 'tool_use',
      toolName: 'cat_cafe_get_thread_context',
      toolUseId: 'tool-f299-preview',
      toolSource: 'mcp',
      toolChannel: 'commentary',
    }),
    event(6, {
      type: 'tool_result',
      toolUseId: 'tool-f299-preview',
      toolResultStatus: 'ok',
      content: 'Design Gate 与真实页面已读取',
    }),
    event(7, {
      type: 'tool_use',
      toolName: 'exec_command',
      toolUseId: 'tool-f299-preview-failed',
      toolSource: 'host_cli',
      toolChannel: 'commentary',
    }),
    event(8, {
      type: 'tool_result',
      toolUseId: 'tool-f299-preview-failed',
      toolResultStatus: 'error',
      content: 'Design Gate 背景类未进入浏览器 CSS',
    }),
    event(9, { type: 'error', error: '视觉背景未按 Design Gate 呈现' }),
    event(10, { type: 'done' }),
  ],
};

const digest = `hmac-sha256:${'a'.repeat(64)}`;
const requestGenerations: RequestGenerationProjectionV1[] = [
  {
    envelope: {
      v: 1,
      invocationId: summary.invocationId,
      sessionId: summary.sessionId,
      generationOrdinal: 1,
      requestGenerationId: '00000000-0000-4000-8000-000000000001',
      promptGenerationId: digest,
      assembledAt: 1_000,
      continuity: {
        capability: 'exact',
        mode: 'cold',
        contextEpoch: 3,
        compactionRefs: ['compaction:authoritative:1'],
      },
      channels: [
        {
          channel: 'message',
          accuracy: 'exact',
          keyedContentDigest: digest,
          byteLength: 64,
          sourceRefs: [{ owner: 'message', ref: 'thread-f299-preview:message-f299-preview' }],
          state: 'redacted',
          injectionDecision: 'assembled_after_continuity_settle',
        },
        {
          channel: 'provider_native_hidden',
          accuracy: 'unknown',
          sourceRefs: [],
          state: 'unknown',
        },
      ],
      presentations: [
        {
          owner: 'runtime-context',
          kind: 'runtime_context',
          sourceRefs: [{ owner: 'runtime_context', ref: 'thread-f299-preview:epoch:3' }],
          decision: 'admitted',
          renderedDigest: digest,
        },
      ],
      runtime: {
        requested: { provider: 'openai', carrier: 'app_server', model: 'gpt-5.6-sol' },
        providerNativeVisibility: 'unknown',
      },
      tools: { finalSurface: 'exact', catCafeSchemaSetHash: digest },
      retryBoundary: { attempt: 1 },
    },
  },
];

export function F299TrajectoryVisualPreview() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);

  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-4 text-cafe sm:p-8">
      <section className="mx-auto max-w-3xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">F299 语义卡视觉回归</h1>
            <p className="text-micro text-cafe-muted">真实组件 · 确定性数据 · development only</p>
          </div>
          <button
            type="button"
            onClick={() => setTheme((value) => (value === 'light' ? 'dark' : 'light'))}
            className="rounded-lg border border-cafe px-3 py-1.5 text-xs font-semibold text-cafe-secondary"
          >
            {theme === 'light' ? '切到暗色' : '切到亮色'}
          </button>
        </div>
        <div className="h-[760px] overflow-hidden rounded-2xl border border-cafe bg-cafe-surface">
          <InvocationTrajectoryDetail
            summary={summary}
            detail={detail}
            loading={false}
            error={false}
            onBack={() => undefined}
            onRetry={() => undefined}
            onOpenPromptMessage={() => undefined}
            requestGenerations={requestGenerations}
            onRevealGenerations={() => undefined}
          />
        </div>
      </section>
    </main>
  );
}
