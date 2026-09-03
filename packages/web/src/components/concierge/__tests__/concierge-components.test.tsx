import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  API_URL: 'http://localhost:3003',
  resolveApiUrl: () => 'http://localhost:3003',
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: (id: string) =>
      id === 'gemini25'
        ? {
            id,
            displayName: '烁烁',
            name: 'Gemini',
            breed: 'siamese',
            color: { primary: '#000', secondary: '#fff' },
          }
        : undefined,
  }),
}));

type SurfaceActivity = {
  threadId: string;
  messageCount: number;
  hasActiveInvocation: boolean;
};

type SurfaceProps = {
  threadId: string;
  density: 'compact';
  composerSeed?: { id: string; text: string };
  onComposerFocusChange?: (focused: boolean) => void;
  onActivity?: (activity: SurfaceActivity) => void;
  emptyState?: React.ReactNode;
  messageConfirmations?: Map<string, unknown[]>;
};

let lastSurfaceProps: SurfaceProps | null = null;

vi.mock('../../thread-chat', () => ({
  ThreadChatSurface: (props: SurfaceProps) => {
    lastSurfaceProps = props;
    return (
      <section data-testid="thread-chat-surface" data-density={props.density} data-thread-id={props.threadId}>
        {props.emptyState}
        <textarea
          aria-label="消息输入框"
          value={props.composerSeed?.text ?? ''}
          onFocus={() => props.onComposerFocusChange?.(true)}
          onBlur={() => props.onComposerFocusChange?.(false)}
          readOnly
        />
      </section>
    );
  },
}));

const restoredConfirmations = vi.hoisted(
  () =>
    new Map([
      [
        'message-confirmed',
        [
          {
            id: 'confirmation-1',
            messageId: 'message-confirmed',
            status: 'confirmed',
            action: { kind: 'concierge_triage_confirm', planId: 'plan-1' },
          },
        ],
      ],
    ]),
);

vi.mock('../useConciergeConfirmations', () => ({
  useConciergeConfirmations: () => ({ confirmations: restoredConfirmations, loading: false, error: null }),
}));

import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { ConciergeBall } from '../ConciergeBall';
import { ConciergeHost } from '../ConciergeHost';
import { ConciergePanel } from '../ConciergePanel';
import { resolvePanelPetState } from '../ConciergePanelChrome';
import { ConciergeRailToggle } from '../ConciergeRailToggle';
import { ConciergeToolbar } from '../ConciergeToolbar';

const mockApiFetch = vi.mocked(apiFetch);

function configOk() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        config: {
          enabled: true,
          muted: false,
          displayName: '猫猫球',
          personaTone: 'cool',
          dutyCatProfileId: 'gemini25',
          proactivePolicy: 'quiet-badge',
          skin: 'ragdoll-v1',
          behaviorEnabled: true,
        },
      }),
  } as unknown as Response);
}

let container: HTMLDivElement;
let root: Root;

async function render(jsx: React.ReactNode) {
  await act(async () => {
    root.render(jsx);
    await Promise.resolve();
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  lastSurfaceProps = null;
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(configOk);
  useConciergeStore.setState({
    enabled: true,
    muted: false,
    surfaceState: 'collapsed',
    inputFocused: false,
    invocationStatus: 'idle',
    pendingConfirmationCount: 0,
    pendingRelayCount: 0,
    unseenResultCount: 0,
    configLoaded: false,
    configLoading: false,
    configFailed: false,
    threadIdLoaded: false,
    threadIdLoading: false,
    threadId: null,
    pendingPrompt: null,
    behaviorEnabled: true,
    lastMessageTimestamp: 0,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('Concierge host lifecycle', () => {
  it('renders one ball only after config resolves', async () => {
    await render(<ConciergeHost />);
    await flushEffects();
    expect(container.querySelectorAll('button[aria-haspopup="dialog"]')).toHaveLength(1);
  });

  it('renders no ball for a persisted hidden config', async () => {
    useConciergeStore.setState({ muted: true, configLoaded: true });
    await render(<ConciergeHost />);
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
  });

  it('does not flash the ball before a slow config resolves', async () => {
    useConciergeStore.setState({ configLoaded: false, configLoading: true });
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
    await render(<ConciergeHost />);
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
  });

  it('keeps the rail wake path and clears hidden state', async () => {
    useConciergeStore.setState({ muted: true, configLoaded: true, surfaceState: 'collapsed' });
    await render(<ConciergeRailToggle />);
    act(() => (container.querySelector('[data-testid="concierge-rail-toggle"]') as HTMLButtonElement).click());
    await flushEffects();
    expect(useConciergeStore.getState()).toMatchObject({ muted: false, surfaceState: 'toolbar' });
  });

  it('uses the three-layer collapsed → toolbar → bubble lifecycle', async () => {
    useConciergeStore.setState({ configLoaded: true });
    await render(<ConciergeHost />);
    act(() => (container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).click());
    await flushEffects();
    expect(container.querySelector('[data-testid="concierge-toolbar"]')).not.toBeNull();

    act(() => (container.querySelector('button[aria-label="聊聊"]') as HTMLButtonElement).click());
    await flushEffects();
    expect(useConciergeStore.getState().surfaceState).toBe('bubble');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps the toolbar inside the positioned ball wrapper', async () => {
    useConciergeStore.setState({ configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeHost />);
    expect(
      container.querySelector('[data-testid="concierge-ball-wrapper"] [data-testid="concierge-toolbar"]'),
    ).not.toBeNull();
  });

  it('toolbar exposes one honest chat entry', async () => {
    useConciergeStore.setState({ configLoaded: true, surfaceState: 'toolbar' });
    await render(<ConciergeToolbar />);
    const buttons = container.querySelectorAll('[data-testid="concierge-toolbar"] button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain('聊聊');
  });

  it('keeps the ball badge quiet and polite', async () => {
    useConciergeStore.setState({ unseenResultCount: 3 });
    await render(<ConciergeBall ballState="found" />);
    expect(container.querySelector('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelector('span[aria-label*="未读"]')?.textContent).toBe('');
  });
});

describe('Concierge compact chat adapter', () => {
  beforeEach(() => {
    useConciergeStore.setState({
      configLoaded: true,
      surfaceState: 'bubble',
      threadId: 'thread-concierge',
      threadIdLoaded: true,
      dutyCatProfileId: 'gemini25',
    });
  });

  it('renders the canonical ThreadChatSurface at compact density', async () => {
    await render(<ConciergePanel />);
    expect(container.querySelector('[data-testid="thread-chat-surface"]')).not.toBeNull();
    expect(lastSurfaceProps).toMatchObject({
      threadId: 'thread-concierge',
      density: 'compact',
      messageConfirmations: restoredConfirmations,
    });
  });

  it('keeps bubble chrome, resize grip and duty-cat identity outside the surface', async () => {
    await render(<ConciergePanel />);
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('false');
    expect(container.querySelector('[data-testid="concierge-resize-grip"]')).not.toBeNull();
    expect(container.textContent).toContain('猫猫球 · 值班：烁烁');
  });

  it('preserves the two-level Escape path', async () => {
    await render(<ConciergePanel />);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flushEffects();
    expect(useConciergeStore.getState().surfaceState).toBe('toolbar');
  });

  it('names and persists the destructive visibility action honestly', async () => {
    mockApiFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
    );
    await render(<ConciergePanel />);
    act(() => (container.querySelector('button[aria-label="隐藏猫猫球"]') as HTMLButtonElement).click());
    await flushEffects();
    expect(useConciergeStore.getState()).toMatchObject({ muted: true, surfaceState: 'collapsed' });
  });

  it('turns toolbar pending prompts into one canonical composer seed', async () => {
    useConciergeStore.setState({ pendingPrompt: '帮我找上次的讨论' });
    await render(<ConciergePanel />);
    await flushEffects();
    expect(lastSurfaceProps?.composerSeed?.text).toBe('帮我找上次的讨论');
    expect(useConciergeStore.getState().pendingPrompt).toBeNull();

    const firstSeedId = lastSurfaceProps?.composerSeed?.id;
    act(() => useConciergeStore.setState({ pendingPrompt: '再找一条' }));
    await flushEffects();
    expect(lastSurfaceProps?.composerSeed).toMatchObject({ text: '再找一条' });
    expect(lastSurfaceProps?.composerSeed?.id).not.toBe(firstSeedId);
  });

  it('seeds the in-context capability starter through the canonical composer', async () => {
    await render(<ConciergePanel />);
    act(() => (container.querySelector('button[aria-label="问问猫猫能帮什么"]') as HTMLButtonElement).click());
    await flushEffects();
    expect(lastSurfaceProps?.composerSeed?.text).toBe('你能帮我什么？');
  });

  it('projects canonical composer focus into pet-only state', async () => {
    await render(<ConciergePanel />);
    const input = container.querySelector('textarea[aria-label="消息输入框"]') as HTMLTextAreaElement;
    act(() => input.focus());
    expect(useConciergeStore.getState().inputFocused).toBe(true);
    act(() => input.blur());
    expect(useConciergeStore.getState().inputFocused).toBe(false);
  });

  it('observes canonical liveness without polling or writing chat state', async () => {
    await render(<ConciergePanel />);
    act(() =>
      lastSurfaceProps?.onActivity?.({
        threadId: 'thread-concierge',
        messageCount: 2,
        hasActiveInvocation: true,
      }),
    );
    expect(useConciergeStore.getState().invocationStatus).toBe('in_progress');

    const firstTimestamp = useConciergeStore.getState().lastMessageTimestamp;
    act(() =>
      lastSurfaceProps?.onActivity?.({
        threadId: 'thread-concierge',
        messageCount: 3,
        hasActiveInvocation: false,
      }),
    );
    expect(useConciergeStore.getState().invocationStatus).toBe('idle');
    expect(useConciergeStore.getState().lastMessageTimestamp).toBeGreaterThanOrEqual(firstTimestamp);
  });

  it('keeps panel pet-state projection presentation-only', () => {
    expect(resolvePanelPetState('pending', false)).toBe('running');
    expect(resolvePanelPetState('error', true)).toBe('failed');
    expect(resolvePanelPetState('idle', true)).toBe('jumping');
    expect(resolvePanelPetState('idle', false)).toBe('idle');
  });
});
