import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatId } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useRoutingPreview } from '../../hooks/useRoutingPreview';
import { ChatInput, threadDrafts } from '../ChatInput';
import { ComposerPreferredCatSection } from '../ComposerPreferredCatSection';
import { ComposerRoutingPreview } from '../ComposerRoutingPreview';
import { buildComposerRecipientIdentities } from '../composer-routing-presentation';
import { writeShellLanguage } from '../shell/shell-language';

const api = vi.hoisted(() => vi.fn());
const defaultCats = [
  {
    id: 'opus',
    displayName: '布偶猫',
    nickname: '宪宪',
    variantLabel: 'Opus 5.5',
    mentionPatterns: ['@opus', '@宪宪'],
    clientId: 'fixture',
    defaultModel: 'fixture',
    personality: '',
    roleDescription: '架构猫',
    avatar: '/avatars/opus.png',
    color: { primary: '#334155', secondary: '#cbd5e1' },
    roster: { available: true },
  },
  {
    id: 'codex',
    displayName: '缅因猫',
    nickname: '砚砚',
    mentionPatterns: ['@codex', '@砚砚'],
    clientId: 'fixture',
    defaultModel: 'fixture',
    personality: '',
    roleDescription: '实现猫',
    avatar: '/avatars/codex.png',
    color: { primary: '#92400e', secondary: '#fed7aa' },
    roster: { available: true },
  },
  {
    id: 'gemini',
    displayName: '暹罗猫',
    nickname: '烁烁',
    mentionPatterns: ['@gemini', '@烁烁'],
    clientId: 'fixture',
    defaultModel: 'fixture',
    personality: '',
    roleDescription: '探索猫',
    avatar: '/avatars/gemini.png',
    color: { primary: '#2563eb', secondary: '#bfdbfe' },
    roster: { available: true },
  },
  {
    id: 'sonnet',
    displayName: '布偶猫',
    nickname: '宪宪',
    variantLabel: 'Sonnet 5.5',
    mentionPatterns: ['@sonnet', '@宪宪'],
    clientId: 'fixture',
    defaultModel: 'fixture',
    personality: '',
    roleDescription: '实现审查猫',
    avatar: '/avatars/sonnet.png',
    color: { primary: '#7c3aed', secondary: '#ddd6fe' },
    roster: { available: true },
  },
];
let cats = defaultCats;

vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
vi.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    transcript: '',
    partialTranscript: '',
    error: null,
    duration: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats,
    getCatById: (id: string) => cats.find((cat) => cat.id === id),
    getCatsByBreed: () => new Map(),
  }),
  formatCatName: (cat: (typeof cats)[number]) => cat.nickname ?? cat.displayName,
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  writeShellLanguage('zh');
  api.mockReset();
  cats = defaultCats;
  threadDrafts.clear();
  useActiveExecutionStore.getState().reset();
  useChatStore.setState({
    messages: [],
    threadStates: {},
    currentThreadId: 'thread-a',
    threads: [
      {
        id: 'thread-a',
        title: '对话',
        projectPath: '/project',
        preferredCats: ['opus'],
        createdBy: 'owner',
        participants: [],
        lastActiveAt: 1,
        createdAt: 1,
        pinned: false,
        favorited: false,
      },
    ],
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    targetCats: [],
    replyToMessage: null,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  threadDrafts.clear();
  vi.useRealTimers();
});

function PreviewProbe({ content, preferredCats }: { content: string; preferredCats: readonly string[] }) {
  const preview = useRoutingPreview({
    enabled: true,
    content,
    scope: { scope: 'new-thread', preferredCats },
  });
  return <output>{JSON.stringify(preview)}</output>;
}

function RoutedRecipientProbe() {
  const preview = useRoutingPreview({
    enabled: true,
    content: '继续',
    scope: { scope: 'thread', threadId: 'thread-a' },
  });
  return <ComposerRoutingPreview preview={preview} onInsertMention={() => {}} />;
}

describe('server-backed composer routing preview', () => {
  it('shows a server-confirmed unavailable recipient and replacement without opening a tooltip', async () => {
    api.mockResolvedValue({
      ok: true,
      json: async () => ({ targetCats: ['codex'], reason: { kind: 'recent_replier' }, unavailableTargets: ['opus'] }),
    });
    await act(async () => root.render(<RoutedRecipientProbe />));
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(host.textContent).toContain('宪宪 · Opus 5.5暂时不能用，改发给砚砚');
    expect(host.querySelector('button')?.getAttribute('aria-label')).toContain('砚砚');
  });

  it('debounces draft changes and sends prospective preferences to the read-only endpoint', async () => {
    api.mockResolvedValue({
      ok: true,
      json: async () => ({ targetCats: ['opus'], reason: { kind: 'preferred_cat' } }),
    });

    await act(async () => root.render(<PreviewProbe content="第一版" preferredCats={['opus']} />));
    await act(async () => root.render(<PreviewProbe content="@宪宪 第二版" preferredCats={['opus']} />));
    expect(api).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]?.[0]).toBe('/api/routing/preview');
    expect(api.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(api.mock.calls[0]?.[1]?.body as string)).toEqual({
      scope: 'new-thread',
      content: '@宪宪 第二版',
      preferredCats: ['opus'],
    });
    expect(host.textContent).toContain('"status":"ready"');
    expect(host.textContent).toContain('"targetCats":["opus"]');
  });

  it('keeps the last resolved recipient visible while a newer draft is debounced and loaded', async () => {
    let resolveRefresh: ((response: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
    api
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ targetCats: ['opus'], reason: { kind: 'preferred_cat' } }),
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    await act(async () => root.render(<PreviewProbe content="第一版" preferredCats={['opus']} />));
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(host.textContent).toContain('"status":"ready"');
    expect(host.textContent).toContain('"targetCats":["opus"]');

    await act(async () => root.render(<PreviewProbe content="第一版继续输入" preferredCats={['opus']} />));
    expect(host.textContent).toContain('"status":"ready"');
    expect(host.textContent).toContain('"targetCats":["opus"]');
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('"targetCats":["opus"]');

    await act(async () =>
      resolveRefresh?.({
        ok: true,
        json: async () => ({ targetCats: ['codex'], reason: { kind: 'current_message_mentions' } }),
      }),
    );
    expect(host.textContent).toContain('"status":"ready"');
    expect(host.textContent).toContain('"targetCats":["codex"]');
  });

  it('does not refresh routing while the textarea is composing, then refreshes after composition ends', async () => {
    api.mockResolvedValue({
      ok: true,
      json: async () => ({ targetCats: ['opus'], reason: { kind: 'preferred_cat' } }),
    });
    await act(async () =>
      root.render(
        <ChatInput presentation="v2" threadId="thread-a" composerContext={<span>Project</span>} onSend={vi.fn()} />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(api.mock.calls.filter(([url]) => url === '/api/routing/preview')).toHaveLength(1);

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '@砚');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(api.mock.calls.filter(([url]) => url === '/api/routing/preview')).toHaveLength(1);
    expect(host.querySelector('[data-testid="composer-routing-preview"]')?.textContent).toContain('宪宪');

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(api.mock.calls.filter(([url]) => url === '/api/routing/preview')).toHaveLength(2);
  });

  it('fails closed when the server returns an unknown reason or malformed target', async () => {
    api.mockResolvedValue({
      ok: true,
      json: async () => ({ targetCats: [''], reason: { kind: 'whisper_recipients' } }),
    });
    await act(async () => root.render(<PreviewProbe content="draft" preferredCats={[]} />));
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(host.textContent).toContain('"status":"error"');
    expect(host.textContent).not.toContain('"status":"ready"');
  });

  it('renders exact recipients and inserts the selected visible @ mention at the start', async () => {
    const onInsertMention = vi.fn();
    await act(async () =>
      root.render(
        <ComposerRoutingPreview
          preview={{
            status: 'ready',
            targetCats: ['opus', 'codex'] as CatId[],
            reason: { kind: 'current_message_mentions' },
          }}
          onInsertMention={onInsertMention}
        />,
      ),
    );

    const trigger = host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('发给');
    expect(trigger.textContent).toContain('宪宪 · Opus 5.5、砚砚');
    expect(trigger.getAttribute('aria-label')).toContain('这条里 @ 了宪宪 · Opus 5.5、砚砚');
    act(() => trigger.click());
    const choice = document.querySelector('[data-testid="composer-recipient-codex"]') as HTMLButtonElement;
    act(() => choice.click());
    expect(onInsertMention).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex', insert: '@砚砚 ' }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps wide routing content-sized while the narrow compact rail alone expands', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/ComposerRoutingPreview.module.css'), 'utf8');
    expect(css).toMatch(
      /\.root\s*\{[^}]*flex:\s*0 1 auto;[^}]*inline-size:\s*fit-content;[^}]*max-inline-size:\s*min\(15rem,\s*100%\);/,
    );
    expect(css).toMatch(/\.button\s*\{[^}]*justify-content:\s*flex-start;/);
    expect(css).toMatch(
      /@media \(max-width: 639px\)[\s\S]*\.compactRoot\s*\{[^}]*flex:\s*1 0 auto;[^}]*inline-size:\s*auto;/,
    );
  });

  it('keeps compact status text in one clipped cell while exposing the full state accessibly', async () => {
    writeShellLanguage('en');
    await act(async () =>
      root.render(
        <ComposerRoutingPreview
          compact
          preview={{ status: 'error', targetCats: [], reason: null }}
          onInsertMention={vi.fn()}
        />,
      ),
    );

    const slot = host.querySelector('[data-testid="composer-routing-root"]') as HTMLElement;
    const trigger = host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement;
    const state = host.querySelector('[data-testid="composer-routing-name"]') as HTMLElement;
    expect(slot.getAttribute('data-layout')).toBe('compact');
    expect(slot.className).toContain('max-sm:min-w-0');
    expect(slot.className).toContain('max-sm:flex-1');
    expect(trigger.className).toContain('max-sm:overflow-hidden');
    expect(trigger.className).toContain('max-sm:whitespace-nowrap');
    expect(state.className).toContain('truncate');
    expect(state.className).toContain('whitespace-nowrap');
    expect(trigger.getAttribute('aria-label')).toContain('Send to: Unavailable');
  });

  it('reserves compact space for every visible recipient avatar and guards optional names from slivers', async () => {
    writeShellLanguage('en');
    await act(async () =>
      root.render(
        <ComposerRoutingPreview
          compact
          preview={{
            status: 'ready',
            targetCats: ['opus', 'sonnet', 'gemini'] as CatId[],
            reason: { kind: 'current_message_mentions' },
          }}
          onInsertMention={vi.fn()}
        />,
      ),
    );

    const slot = host.querySelector('[data-testid="composer-routing-root"]') as HTMLElement;
    const avatars = host.querySelector('[data-testid="composer-routing-avatars"]') as HTMLElement;
    const name = host.querySelector('[data-testid="composer-routing-name"]') as HTMLElement;
    expect(slot.getAttribute('data-compact-recipient-count')).toBe('3');
    expect(avatars.querySelectorAll('img')).toHaveLength(3);
    expect(avatars.className).toContain('max-sm:ml-1');
    expect(name.getAttribute('data-compact-name-policy')).toBe('whole-or-hidden');
    expect(
      (host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement).getAttribute('aria-label'),
    ).toContain('Send to: 宪宪 · Opus 5.5, 宪宪 · Sonnet 5.5, 烁烁');
  });

  it('disambiguates shared nicknames and inserts a unique visible handle', async () => {
    const onInsertMention = vi.fn();
    await act(async () =>
      root.render(
        <ComposerRoutingPreview
          preview={{
            status: 'ready',
            targetCats: ['opus'] as CatId[],
            reason: { kind: 'recent_replier' },
          }}
          onInsertMention={onInsertMention}
        />,
      ),
    );

    const trigger = host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('宪宪 · Opus 5.5');
    act(() => trigger.click());

    const opus = document.querySelector('[data-testid="composer-recipient-opus"]') as HTMLButtonElement;
    const sonnet = document.querySelector('[data-testid="composer-recipient-sonnet"]') as HTMLButtonElement;
    expect(opus.textContent).toContain('宪宪 · Opus 5.5');
    expect(sonnet.textContent).toContain('宪宪 · Sonnet 5.5');

    act(() => sonnet.click());
    expect(onInsertMention).toHaveBeenCalledWith(expect.objectContaining({ id: 'sonnet', insert: '@sonnet ' }));
  });

  it('disables a duplicate-name recipient when the catalog has no registered unique mention', async () => {
    cats = defaultCats
      .filter((cat) => cat.id === 'opus' || cat.id === 'sonnet')
      .map((cat) => ({ ...cat, mentionPatterns: ['@宪宪'] }));
    const onInsertMention = vi.fn();

    await act(async () =>
      root.render(
        <ComposerRoutingPreview
          preview={{
            status: 'ready',
            targetCats: ['opus'] as CatId[],
            reason: { kind: 'recent_replier' },
          }}
          onInsertMention={onInsertMention}
        />,
      ),
    );
    act(() => (host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement).click());

    const opus = document.querySelector('[data-testid="composer-recipient-opus"]') as HTMLButtonElement;
    expect(opus.disabled).toBe(true);
    expect(opus.textContent).toContain('没有唯一 @ 名称');
    expect(buildComposerRecipientIdentities(cats as unknown as CatData[]).get('opus')?.insert).toBeNull();
    act(() => opus.click());
    expect(onInsertMention).not.toHaveBeenCalled();
  });

  it('inserts a custom alias only when that registered mention uniquely identifies the cat', async () => {
    cats = defaultCats
      .filter((cat) => cat.id === 'opus' || cat.id === 'sonnet')
      .map((cat) => ({
        ...cat,
        mentionPatterns: cat.id === 'opus' ? ['@宪宪', '@architect'] : ['@宪宪'],
      }));
    const onInsertMention = vi.fn();

    await act(async () =>
      root.render(
        <ComposerRoutingPreview
          preview={{
            status: 'ready',
            targetCats: ['opus'] as CatId[],
            reason: { kind: 'recent_replier' },
          }}
          onInsertMention={onInsertMention}
        />,
      ),
    );
    act(() => (host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement).click());
    const opus = document.querySelector('[data-testid="composer-recipient-opus"]') as HTMLButtonElement;
    const insert = buildComposerRecipientIdentities(cats as unknown as CatData[])
      .get('opus')
      ?.insert?.trim();

    expect(opus.disabled).toBe(false);
    expect(opus.textContent).toContain('@architect');
    expect(insert).toBe('@architect');
    expect(
      cats.filter((cat) =>
        cat.mentionPatterns.some((pattern) => pattern.toLocaleLowerCase() === insert?.toLocaleLowerCase()),
      ),
    ).toHaveLength(1);
    act(() => opus.click());
    expect(onInsertMention).toHaveBeenCalledWith(expect.objectContaining({ id: 'opus', insert: '@architect ' }));
  });

  it('keeps every existing preferred cat and adds another from the separate + menu setting', async () => {
    const onChange = vi.fn().mockResolvedValue(true);
    await act(async () =>
      root.render(<ComposerPreferredCatSection selectedCatIds={['opus', 'codex']} onChange={onChange} />),
    );
    expect(host.textContent).toContain('这条对话 · 没 @ 时先找谁');
    expect(host.textContent).toContain('只在还没有猫回过话时用上');
    expect(host.textContent).toContain('首选猫 · 2');

    act(() => (host.querySelector('[data-testid="composer-preferred-cat-toggle"]') as HTMLButtonElement).click());
    expect(
      (host.querySelector('[data-testid="composer-preferred-cat-opus"]') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(
      (host.querySelector('[data-testid="composer-preferred-cat-codex"]') as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(host.querySelector('[data-testid="composer-preferred-cat-opus"]')?.textContent).toContain('宪宪 · Opus 5.5');
    expect(host.querySelector('[data-testid="composer-preferred-cat-sonnet"]')?.textContent).toContain(
      '宪宪 · Sonnet 5.5',
    );
    await act(async () =>
      (host.querySelector('[data-testid="composer-preferred-cat-gemini"]') as HTMLButtonElement).click(),
    );
    expect(onChange).toHaveBeenCalledWith(['opus', 'codex', 'gemini']);
  });

  it('wires the preview into ChatInput, prepends visible @ text and saves preferredCats only from +', async () => {
    useChatStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === 'thread-a' ? { ...thread, preferredCats: ['opus', 'codex'] } : thread,
      ),
    }));
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/routing/preview') {
        const body = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () => ({
            targetCats: body.content.startsWith('@砚砚 ') ? ['codex'] : ['opus'],
            reason: { kind: body.content.startsWith('@砚砚 ') ? 'current_message_mentions' : 'preferred_cat' },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    await act(async () =>
      root.render(
        <ChatInput presentation="v2" threadId="thread-a" composerContext={<span>Project</span>} onSend={vi.fn()} />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(host.querySelector('[data-testid="composer-routing-preview"]')?.textContent).toContain('宪宪');

    act(() => (host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid="composer-recipient-codex"]') as HTMLButtonElement).click());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('@砚砚 ');
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(host.querySelector('[data-testid="composer-routing-preview"]')?.textContent).toContain('砚砚');

    const add = host.querySelector('button[aria-controls="composer-add-menu"]') as HTMLButtonElement;
    act(() => add.click());
    const addMenu = document.querySelector('[data-testid="composer-add-menu"]') as HTMLElement;
    expect(addMenu.textContent).toContain('这条对话 · 没 @ 时先找谁');
    act(() => (addMenu.querySelector('[data-testid="composer-preferred-cat-toggle"]') as HTMLButtonElement).click());
    await act(async () =>
      (addMenu.querySelector('[data-testid="composer-preferred-cat-gemini"]') as HTMLButtonElement).click(),
    );
    const patchCall = api.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall?.[0]).toBe('/api/threads/thread-a');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ preferredCats: ['opus', 'codex', 'gemini'] });
    expect(useChatStore.getState().threads[0]?.preferredCats).toEqual(['opus', 'codex', 'gemini']);
  });

  it('shows whisper recipients as the actual send target without consulting normal routing', async () => {
    api.mockResolvedValue({
      ok: true,
      json: async () => ({ targetCats: ['opus'], reason: { kind: 'preferred_cat' } }),
    });
    await act(async () =>
      root.render(
        <ChatInput presentation="v2" threadId="thread-a" composerContext={<span>Project</span>} onSend={vi.fn()} />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(host.querySelector('[data-testid="composer-routing-preview"]')?.textContent).toContain('宪宪');
    const routingCallCount = () => api.mock.calls.filter(([url]) => url === '/api/routing/preview').length;
    expect(routingCallCount()).toBe(1);

    act(() => (host.querySelector('button[aria-controls="composer-add-menu"]') as HTMLButtonElement).click());
    act(() =>
      (
        document.querySelector(
          '[data-testid="composer-add-menu"] [data-testid="composer-whisper"]',
        ) as HTMLButtonElement
      ).click(),
    );
    const preview = host.querySelector('[data-testid="composer-routing-preview"]') as HTMLButtonElement;
    expect(preview.textContent).toContain('未选择收信猫');
    expect(preview.getAttribute('aria-label')).toContain('悄悄话已开启，请先选择收信猫');

    const codexWhisperChoice = document.querySelector('img[alt="砚砚"]')?.closest('button') as HTMLButtonElement;
    act(() => codexWhisperChoice.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(preview.textContent).toContain('砚砚');
    expect(preview.getAttribute('aria-label')).toContain('悄悄话会发给砚砚');

    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(routingCallCount()).toBe(1);
  });
});
