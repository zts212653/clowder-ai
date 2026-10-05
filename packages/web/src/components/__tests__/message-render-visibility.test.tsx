import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { computeCliDiagnosticsDedup } from '@/utils/cli-diagnostics-dedup';
import { ChatMessage } from '../ChatMessage';
import { messageRendersNothing } from '../message-render-visibility';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell/shell-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));

/**
 * F322 B segment 1 (human message) — the one answer to "does this row put anything on screen?".
 *
 * A run of your own messages is read from what is on screen, so the grouping asks `messageRendersNothing`. That predicate
 * mirrors the early exits of `ChatMessage`, which is exactly the kind of thing that drifts. This is the guard: a spread of
 * messages — every kind, with and without content, streaming, thinking, recalled, folded, linked, duplicated — is rendered
 * by the REAL `ChatMessage` and the real answer is compared with the predicate's. A new early exit in `ChatMessage` that the
 * predicate does not know about shows up here as a named mismatch.
 */
const THREAD = 'thread-visibility';
let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  resetCoCreatorConfigCacheForTest();
  primeCoCreatorConfigCache({ name: 'You', aliases: [], mentionPatterns: ['@co-creator'] });
  window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useChatStore.setState({ currentThreadId: THREAD, messages: [], threads: [] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  resetCoCreatorConfigCacheForTest();
});

/** Something a person would see: any node that is not inside an aria-hidden subtree (the h-0 anchors are aria-hidden). */
const putsSomethingOnScreen = () =>
  Array.from(container.querySelectorAll('*')).some((el) => !el.closest('[aria-hidden="true"]'));

interface Case {
  label: string;
  message: Message;
  /** The rest of the thread the message is rendered in (it is always part of it). */
  others?: Message[];
}

const diag = {
  reasonCode: 'auth_failed',
  publicSummary: 'API 认证失败',
  publicHint: '检查 API key',
  debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId: 'inv-x' },
} as NonNullable<Message['extra']>['cliDiagnostics'];

const sourceOwn: Message = { id: 'src', type: 'user', content: 'src', timestamp: 1 };
const noticeMeta = (linked: boolean) => ({
  presentation: 'system_notice',
  cloudBridgeRecovery: {
    v: 1,
    kind: 'needs_binding',
    sourceMessageId: linked ? 'src' : 'elsewhere',
    targetCatId: 'gpt-pro',
    dispatchInvocationId: 'dispatch-1',
  },
});

function cases(): Case[] {
  const list: Case[] = [];
  const add = (label: string, message: Message, others?: Message[]) => list.push({ label, message, others });

  // Your own message.
  for (const content of ['', 'hi']) {
    add(`own, content ${JSON.stringify(content)}`, { id: 'm', type: 'user', content, timestamp: 2 });
    for (const exposure of ['none', 'seen'] as const) {
      add(`own, recalled (${exposure}), content ${JSON.stringify(content)}`, {
        id: 'm',
        type: 'user',
        content,
        timestamp: 2,
        extra: { recall: { version: 1, exposure, recalledAt: 3 } },
      });
    }
  }
  add(
    'own, body folded into the reply by real receipt lineage',
    {
      id: 'm',
      type: 'user',
      content: 'hi',
      timestamp: 2,
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-folded',
          reminderAttempts: [],
          targets: [
            {
              catId: 'opus',
              state: 'handled',
              invocationId: 'child-1',
              seenAt: 1,
              outcome: {
                invocationId: 'child-1',
                disposition: 'responded',
                handledAt: 2,
                evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
              },
            },
          ],
        },
      },
    },
    [
      {
        id: 'terminal',
        type: 'assistant',
        catId: 'opus',
        content: '已回复',
        timestamp: 3,
        extra: {
          turnExecution: { invocationId: 'child-1', parentInvocationId: 'parent-1', executionKind: 'ordinary' },
        },
      },
    ],
  );

  // A cat's message (and a user-typed record that a trusted catId makes a cat's message).
  for (const type of ['assistant', 'user'] as const) {
    for (const content of ['', 'text']) {
      for (const isStreaming of [false, true]) {
        for (const thinking of [undefined, 'thinking']) {
          for (const [extraLabel, extra] of [
            ['no extra', undefined],
            [
              'turn execution',
              { turnExecution: { invocationId: 'i-1', parentInvocationId: 'p-1', executionKind: 'ordinary' } },
            ],
            ['cross-thread source', { crossPost: { sourceThreadId: 'other-thread', sourceInvocationId: 'x' } }],
          ] as const) {
            add(
              `cat (${type}+catId), content ${JSON.stringify(content)}, streaming ${isStreaming}, thinking ${thinking ?? 'none'}, ${extraLabel}`,
              {
                id: 'm',
                type,
                catId: 'opus',
                content,
                timestamp: 2,
                isStreaming,
                ...(thinking ? { thinking } : {}),
                ...(extra ? { extra: extra as Message['extra'] } : {}),
              },
            );
          }
        }
      }
    }
  }

  // Connector messages.
  const connectorBase = { id: 'm', type: 'connector' as const, content: 'connector text', timestamp: 2 };
  add('connector without a source', connectorBase);
  add('connector with a plain source', {
    ...connectorBase,
    source: { connector: 'feishu', label: '飞书', icon: 'f' },
  });
  add(
    'connector system notice, not linked to a message of yours',
    {
      ...connectorBase,
      replyTo: 'elsewhere',
      source: { connector: 'cloud-bridge-status', label: '云端猫投递', icon: 'c', meta: noticeMeta(false) },
    },
    [sourceOwn],
  );
  add(
    'connector system notice, linked to a message of yours',
    {
      ...connectorBase,
      replyTo: 'src',
      source: { connector: 'cloud-bridge-status', label: '云端猫投递', icon: 'c', meta: noticeMeta(true) },
    },
    [sourceOwn],
  );

  // Summary cards: a summary with its content is a visible card; one without draws nothing.
  add('summary with its content', {
    id: 'm',
    type: 'summary',
    content: '',
    timestamp: 2,
    summary: {
      id: 's1',
      topic: '本周结论',
      conclusions: ['定下设计方向'],
      openQuestions: ['谁来验收'],
      createdBy: 'opus',
    },
  });
  add('summary record with no summary attached', { id: 'm', type: 'summary', content: 'x', timestamp: 2 });

  // System messages.
  for (const variant of [undefined, 'tool', 'error'] as const) {
    add(`system, variant ${variant ?? 'none'}`, {
      id: 'm',
      type: 'system',
      content: variant === 'error' ? 'Error: boom' : 'system text',
      timestamp: 2,
      ...(variant ? { variant } : {}),
    });
  }
  add('system CLI diagnostics, the first of a group', {
    id: 'm',
    type: 'system',
    variant: 'error',
    content: 'Error: auth',
    timestamp: 2,
    extra: { cliDiagnostics: diag },
  });
  add(
    'system CLI diagnostics, a duplicate the list collapses',
    {
      id: 'm',
      type: 'system',
      variant: 'error',
      content: 'Error: auth',
      timestamp: 3,
      extra: { cliDiagnostics: diag },
    },
    [
      {
        id: 'head',
        type: 'system',
        variant: 'error',
        content: 'Error: auth',
        timestamp: 2,
        extra: { cliDiagnostics: diag },
      },
    ],
  );
  return list;
}

/** Every message kind `ChatMessage` is handed. Adding a kind to the type fails to compile here until the spread covers it. */
const KINDS = { user: true, assistant: true, system: true, summary: true, connector: true } satisfies Record<
  Message['type'],
  true
>;

it('covers every kind of message the type allows, so a new kind cannot slip past the guard', () => {
  const seen = new Set(cases().map(({ message }) => message.type));

  expect(Array.from(seen).sort()).toEqual(Object.keys(KINDS).sort());
});

it('agrees with the real ChatMessage about what is on screen, for every kind of row', () => {
  const mismatches: string[] = [];
  let checked = 0;
  for (const { label, message, others = [] } of cases()) {
    // The head of a duplicate group comes before the message; every other support message comes after.
    const before = others.filter((o) => o.timestamp < message.timestamp);
    const after = others.filter((o) => o.timestamp >= message.timestamp);
    const timeline = [...before, message, ...after];
    const dedup = computeCliDiagnosticsDedup(timeline);
    act(() =>
      root.render(
        <ChatMessage
          message={message}
          timelineMessages={timeline}
          threadId={THREAD}
          getCatById={() => undefined}
          hideDiagnosticsPanel={dedup.get(message.id)?.hideDiagnosticsPanel}
          dedupCount={dedup.get(message.id)?.dedupCount}
        />,
      ),
    );
    const real = putsSomethingOnScreen();
    const predicted = !messageRendersNothing(message, timeline, { currentThreadId: THREAD });
    checked += 1;
    if (real !== predicted)
      mismatches.push(
        `${label}: renderer ${real ? 'draws' : 'draws nothing'}, predicate says ${predicted ? 'draws' : 'nothing'}`,
      );
    act(() => root.render(<></>));
  }

  expect(checked).toBeGreaterThan(60);
  expect(mismatches).toEqual([]);
});

/**
 * The hand-picked spread above is what someone thought of. This sweeps the fields ChatMessage actually branches on - the
 * kind, the variant, the origin, whether there is any text, streaming, thinking - as a product, so an exit nobody thought of
 * shows up as a named mismatch instead of in review.
 */
it('agrees with the real ChatMessage across the product of the fields it branches on', () => {
  const kinds = Object.keys(KINDS) as Message['type'][];
  const variants = [undefined, 'tool', 'error', 'evidence', 'governance_blocked', 'a2a_followup'] as const;
  const origins = [undefined, 'stream', 'briefing', 'callback'] as const;
  const mismatches: string[] = [];
  let checked = 0;
  for (const type of kinds)
    for (const variant of variants)
      for (const origin of origins)
        for (const content of ['', 'text'])
          for (const isStreaming of [false, true])
            for (const thinking of [undefined, '想']) {
              const message = {
                id: 'm',
                type,
                ...(type === 'assistant' || type === 'summary' ? {} : {}),
                content,
                timestamp: 2,
                ...(variant ? { variant } : {}),
                ...(origin ? { origin } : {}),
                ...(isStreaming ? { isStreaming } : {}),
                ...(thinking ? { thinking } : {}),
                ...(type === 'assistant' ? { catId: 'opus' } : {}),
              } as Message;
              const timeline = [message];
              act(() =>
                root.render(
                  <ChatMessage
                    message={message}
                    timelineMessages={timeline}
                    threadId={THREAD}
                    getCatById={() => undefined}
                  />,
                ),
              );
              const real = putsSomethingOnScreen();
              const predicted = !messageRendersNothing(message, timeline, { currentThreadId: THREAD });
              checked += 1;
              if (real !== predicted)
                mismatches.push(
                  `${type}/${variant ?? '-'}/${origin ?? '-'}/${content ? 'text' : 'empty'}/${isStreaming ? 'streaming' : 'done'}/${thinking ? 'thinking' : '-'}: renderer ${real ? 'draws' : 'draws nothing'}, predicate says ${predicted ? 'draws' : 'nothing'}`,
                );
              act(() => root.render(<></>));
            }

  expect(mismatches).toEqual([]);
  expect(checked).toBe(960);
});

it('exercises both answers: the spread is not all visible and not all hidden', () => {
  const answers = new Set<boolean>();
  for (const { message, others = [] } of cases()) {
    const timeline = [
      ...others.filter((o) => o.timestamp < message.timestamp),
      message,
      ...others.filter((o) => o.timestamp >= message.timestamp),
    ];
    answers.add(messageRendersNothing(message, timeline, { currentThreadId: THREAD }));
  }

  expect(answers).toEqual(new Set([true, false]));
});
