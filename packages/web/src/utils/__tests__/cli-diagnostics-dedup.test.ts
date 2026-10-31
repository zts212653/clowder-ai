import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chat-types';
import { computeCliDiagnosticsDedup } from '../cli-diagnostics-dedup';

function diagMsg(id: string, timestamp: number, reasonCode: string | undefined, publicSummary: string): ChatMessage {
  return {
    id,
    type: 'system',
    threadId: 't1',
    timestamp,
    content: '',
    extra: {
      cliDiagnostics: {
        reasonCode: reasonCode as never,
        publicSummary,
        publicHint: '',
        debugRef: { command: 'codex', exitCode: 1, signal: null },
      },
    },
  } as unknown as ChatMessage;
}

function plainMsg(id: string, timestamp: number): ChatMessage {
  return { id, type: 'user', threadId: 't1', timestamp, content: 'hi' } as unknown as ChatMessage;
}

describe('computeCliDiagnosticsDedup', () => {
  it('single cliDiagnostics message → no dedup info (renders normally)', () => {
    const result = computeCliDiagnosticsDedup([diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限')]);
    expect(result.size).toBe(0);
  });

  it('two adjacent same-fingerprint messages within window → first gets dedupCount=2, second hidden', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('b', 5000, 'quota_exceeded', 'API 配额超限'),
    ]);
    expect(result.get('a')).toEqual({ dedupCount: 2, hideDiagnosticsPanel: false });
    expect(result.get('b')).toEqual({ dedupCount: 0, hideDiagnosticsPanel: true });
  });

  it('three adjacent same-fingerprint messages → first count=3, rest hidden (Repo Inbox real case)', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('b', 2000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('c', 3000, 'quota_exceeded', 'API 配额超限'),
    ]);
    expect(result.get('a')?.dedupCount).toBe(3);
    expect(result.get('b')?.hideDiagnosticsPanel).toBe(true);
    expect(result.get('c')?.hideDiagnosticsPanel).toBe(true);
  });

  it('two same-fingerprint messages > 30s apart → no dedup (window exceeded)', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('b', 50_000, 'quota_exceeded', 'API 配额超限'),
    ]);
    expect(result.size).toBe(0);
  });

  it('different reasonCodes → no dedup (different errors are legitimately distinct)', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('b', 2000, 'auth_failed', 'API 认证失败'),
    ]);
    expect(result.size).toBe(0);
  });

  it('non-cliDiagnostics message breaks the group (legitimately reappearing diagnostics NOT hidden)', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限'),
      plainMsg('p', 2000),
      diagMsg('b', 3000, 'quota_exceeded', 'API 配额超限'),
    ]);
    // No group has size>1, so map is empty (both render normally)
    expect(result.size).toBe(0);
  });

  it('same reasonCode different publicSummary → no dedup (different humanized titles)', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('b', 2000, 'quota_exceeded', 'Different summary'),
    ]);
    expect(result.size).toBe(0);
  });

  it('two groups separated by different-reasonCode → both groups dedup independently', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('b', 2000, 'quota_exceeded', 'API 配额超限'),
      diagMsg('c', 3000, 'auth_failed', 'API 认证失败'),
      diagMsg('d', 4000, 'auth_failed', 'API 认证失败'),
    ]);
    expect(result.get('a')?.dedupCount).toBe(2);
    expect(result.get('b')?.hideDiagnosticsPanel).toBe(true);
    expect(result.get('c')?.dedupCount).toBe(2);
    expect(result.get('d')?.hideDiagnosticsPanel).toBe(true);
  });

  it('undefined reasonCode + same publicSummary still dedups (AC-D3 cc_structured case)', () => {
    const result = computeCliDiagnosticsDedup([
      diagMsg('a', 1000, undefined, 'Claude Code 报告：xxx'),
      diagMsg('b', 2000, undefined, 'Claude Code 报告：xxx'),
    ]);
    expect(result.get('a')?.dedupCount).toBe(2);
    expect(result.get('b')?.hideDiagnosticsPanel).toBe(true);
  });
});

describe('computeCliDiagnosticsDedup groups only the CLI panel each row renders (F117)', () => {
  type Extra = NonNullable<ChatMessage['extra']>;
  const classified = {
    reasonCode: 'auth_failed',
    publicSummary: 'API 认证失败',
    publicHint: '',
    debugRef: { command: 'codex', exitCode: 1, signal: null },
  } as Extra['cliDiagnostics'];
  // A timeout the classifier could not name: the timeout panel explains it wherever one exists.
  const unclassified = {
    publicSummary: '未识别的 CLI 错误',
    publicHint: '',
    debugRef: { command: 'codex', exitCode: null, signal: 'SIGTERM' },
  } as Extra['cliDiagnostics'];
  const timeoutDiagnostics = {
    silenceDurationMs: 1_800_000,
    processAlive: true,
    lastEventType: 'thread.started',
    invocationId: 'turn',
  } as Extra['timeoutDiagnostics'];

  function response(
    id: string,
    extra: Extra,
    opts: {
      status?: 'processing' | 'completed' | 'failed' | 'interrupted';
      admittedAt?: number;
      completedAt?: number;
    } = {},
  ): ChatMessage {
    const { status = 'failed', admittedAt = 1000, completedAt = admittedAt + 500 } = opts;
    return {
      id,
      type: 'assistant',
      catId: 'opus',
      threadId: 't1',
      content: '',
      timestamp: admittedAt,
      lifecycle: {
        kind: 'response',
        orderKey: `${admittedAt}:${id}`,
        invocationId: id,
        targetId: 'opus',
        inputEntryIds: [`entry-${id}`],
        inputMessageIds: [`source-${id}`],
        status,
        startedAt: admittedAt,
        ...(status === 'processing' ? {} : { completedAt }),
      },
      extra,
    } as unknown as ChatMessage;
  }

  function errorRow(id: string, extra: Extra, timestamp = 1000): ChatMessage {
    return {
      id,
      type: 'system',
      variant: 'error',
      threadId: 't1',
      timestamp,
      content: 'Error: x',
      extra,
    } as ChatMessage;
  }

  it.each([
    ['responses', response],
    ['error rows', errorRow],
  ])('a CLI panel after a row that shows the timeout panel stays visible (%s)', (_label, row) => {
    const result = computeCliDiagnosticsDedup([
      row('shows-timeout', { cliDiagnostics: unclassified, timeoutDiagnostics }),
      row('shows-cli', { cliDiagnostics: unclassified }),
    ]);

    expect(result.size).toBe(0);
  });

  it.each([
    'completed',
    'processing',
    'failed',
    'interrupted',
  ] as const)('a %s response shows no panel, so it never heads a group', (status) => {
    const result = computeCliDiagnosticsDedup([
      response('no-panel', { cliDiagnostics: classified }, { status }),
      response('failed', { cliDiagnostics: classified }),
    ]);

    expect(result.size).toBe(0);
  });

  it('failed and interrupted responses never collapse independent response bodies', () => {
    const result = computeCliDiagnosticsDedup([
      response('first', { cliDiagnostics: classified }),
      response('second', { cliDiagnostics: classified }, { status: 'interrupted', completedAt: 1600 }),
    ]);
    expect(result.size).toBe(0);
  });

  it('a hidden protocol row carrying diagnostics never heads a group', () => {
    const guard = {
      ...errorRow('guard', { cliDiagnostics: classified }),
      from: { kind: 'system', service: 'routing-guard' },
    } as ChatMessage;

    expect(computeCliDiagnosticsDedup([guard, errorRow('visible', { cliDiagnostics: classified }, 2000)]).size).toBe(0);
  });

  it('only rows that are drawn take part; the timeline only resolves how each row renders', () => {
    const head = errorRow('head', { cliDiagnostics: classified });
    const later = errorRow('later', { cliDiagnostics: classified }, 2000);

    expect(computeCliDiagnosticsDedup([later], [head, later]).size).toBe(0);
  });
});
