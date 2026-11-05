'use client';

import { useEffect, useState } from 'react';
import {
  type AuthorizedConversationsRead,
  CloudConversationLinkView,
  type RouteOperation,
  type ThreadRouteRead,
} from '@/components/CloudConversationLinkView';

const candidates = [
  {
    conversationId: 'conversation-stars',
    chatUrl: 'https://chatgpt.com/c/conversation-stars',
    displayTitle: '把云端的小星星接回家',
    authorizedAt: '2026-09-05T06:26:00.000Z',
    updatedAt: '2026-09-05T06:26:00.000Z',
  },
  {
    conversationId: 'conversation-review',
    chatUrl: 'https://chatgpt.com/c/conversation-review',
    displayTitle: '周末一起看连接体验',
    authorizedAt: '2026-09-04T04:56:00.000Z',
    updatedAt: '2026-09-04T04:56:00.000Z',
  },
  {
    conversationId: 'conversation-untitled',
    chatUrl: 'https://chatgpt.com/c/conversation-untitled',
    authorizedAt: '2026-08-29T07:42:00.000Z',
    updatedAt: '2026-08-29T07:42:00.000Z',
  },
];
const revokedBinding = { chatUrl: 'https://chatgpt.com/c/conversation-gone', conversationId: 'conversation-gone' };

const scenarios = [
  '已连接',
  '更换会话',
  '未连接',
  '尚未授权任何会话',
  '授权已撤销',
  '撤销且无授权会话',
  '读不到授权列表',
  '明确被拒',
  '结果未知·确认中',
  '结果未知·读不到',
  '断开结果未知',
  '连接记录无效',
  '仅所有者可见',
  '读取中',
] as const;
type Scenario = (typeof scenarios)[number];

function initialRoute(scenario: Scenario): ThreadRouteRead {
  if (scenario === '读取中') return { kind: 'loading' };
  if (scenario === '仅所有者可见') return { kind: 'unauthorized' };
  if (scenario === '连接记录无效') return { kind: 'ready', binding: 'invalid' };
  if (scenario === '未连接' || scenario === '尚未授权任何会话') return { kind: 'ready', binding: null };
  if (scenario === '授权已撤销' || scenario === '撤销且无授权会话') return { kind: 'ready', binding: revokedBinding };
  return { kind: 'ready', binding: candidates[0] };
}

function initialAuthorized(scenario: Scenario): AuthorizedConversationsRead {
  if (scenario === '读不到授权列表') return { kind: 'error' };
  if (scenario === '尚未授权任何会话' || scenario === '撤销且无授权会话') return { kind: 'ready', candidates: [] };
  return { kind: 'ready', candidates };
}

function initialOperation(scenario: Scenario): RouteOperation {
  if (scenario === '明确被拒')
    return { kind: 'rejected', action: 'change', reason: '登录状态失效了，刷新页面后再试。' };
  if (scenario === '结果未知·确认中') return { kind: 'reconciling', action: 'change' };
  if (scenario === '结果未知·读不到') return { kind: 'unknown', action: 'change' };
  if (scenario === '断开结果未知') return { kind: 'reconciling', action: 'disconnect' };
  return { kind: 'idle' };
}

const CHOOSING: readonly Scenario[] = [
  '更换会话',
  '明确被拒',
  '读不到授权列表',
  '结果未知·确认中',
  '结果未知·读不到',
  '断开结果未知',
];
const SELECTING: readonly Scenario[] = ['明确被拒', '结果未知·确认中', '结果未知·读不到'];

function ScenarioCard({ scenario }: { scenario: Scenario }) {
  const [route, setRoute] = useState<ThreadRouteRead>(() => initialRoute(scenario));
  const [choosing, setChoosing] = useState(CHOOSING.includes(scenario));
  const [selected, setSelected] = useState<string | null>(
    SELECTING.includes(scenario) ? candidates[1].conversationId : null,
  );
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [done, setDone] = useState<string | null>(null);
  const bound = route.kind === 'ready' && route.binding !== 'invalid' ? route.binding : null;
  return (
    <>
      <CloudConversationLinkView
        catLabel="@gpt-pro"
        radioName="preview-thread-route"
        route={route}
        authorized={initialAuthorized(scenario)}
        choosing={choosing}
        selectedConversationId={selected}
        busy={null}
        operation={initialOperation(scenario)}
        copyState={copyState}
        onCopy={() => setCopyState('copied')}
        onToggleChoosing={() => {
          setChoosing((value) => !value);
          setSelected(null);
        }}
        onSelect={setSelected}
        onConfirm={() => {
          const next = candidates.find((candidate) => candidate.conversationId === selected);
          if (!next) return;
          setRoute({ kind: 'ready', binding: next });
          setChoosing(false);
          setSelected(null);
          setDone(`已改用「${next.displayTitle ?? next.conversationId}」`);
        }}
        onDisconnect={() => {
          setRoute({ kind: 'ready', binding: null });
          setChoosing(false);
          setSelected(null);
          setDone(bound ? '已断开连接' : null);
        }}
        onReread={() => undefined}
        onRetryList={() => undefined}
      />
      {done ? (
        <p className="mt-2 text-micro text-cafe-muted" data-preview-note>
          （预览记录：{done}）
        </p>
      ) : null}
    </>
  );
}

export default function F202ThreadRoutePreview() {
  const [scenario, setScenario] = useState<Scenario>('已连接');
  const [clean, setClean] = useState(false);
  const [width, setWidth] = useState(304);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('scenario');
    if (fromUrl && (scenarios as readonly string[]).includes(fromUrl)) setScenario(fromUrl as Scenario);
    setClean(params.get('clean') === '1');
    const requestedWidth = Number(params.get('width'));
    if (requestedWidth >= 240 && requestedWidth <= 480) setWidth(requestedWidth);
    if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
  }, []);
  return (
    <main className="min-h-screen bg-cafe-bg p-4 sm:p-8">
      {!clean ? (
        <header className="mb-4 max-w-3xl">
          <p className="text-xs font-semibold text-cafe-muted">设计预览 · 示例数据 · 右栏宽 {width}px</p>
          <nav aria-label="预览状态" className="mt-2 flex flex-wrap gap-2">
            {scenarios.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={value === scenario}
                onClick={() => setScenario(value)}
                className="rounded-lg border border-[var(--console-border-soft)] px-3 py-1.5 text-xs text-cafe aria-pressed:bg-[var(--console-hover-bg)]"
              >
                {value}
              </button>
            ))}
          </nav>
        </header>
      ) : null}
      <div
        data-preview-panel
        style={{ width }}
        className="border-l border-[var(--console-border-soft)] bg-[var(--console-panel-bg)] p-3"
      >
        <ScenarioCard key={scenario} scenario={scenario} />
      </div>
    </main>
  );
}
