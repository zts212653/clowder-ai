/**
 * F229 AC-A3 Bug2: ConciergeMessageContent — inline marker buttons
 *
 * Markers [跳过去 Rn] / [原地看 Rn] in duty cat reply text must render as
 * clickable inline buttons (method A), NOT raw bracket text.
 *
 * AC-2: teleport marker → inline button → pushThreadRouteWithHistory
 * AC-3: peek marker with messageId → inline peek button
 * AC-4: peek marker without messageId → degraded plain text (no dead button)
 * AC-5: no raw [原地看 R3] bracket text visible
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — match CardBlock-concierge-teleport.test.tsx patterns
// ---------------------------------------------------------------------------
const mockOnNavigationAction = vi.fn();
vi.mock('@/stores/conciergeStore', () => ({
  useConciergeStore: { getState: () => ({ onNavigationAction: mockOnNavigationAction }) },
}));

// chatStore mock must be callable (MarkdownContent uses it as a hook: useChatStore(selector))
// AND have .getState() (ConciergeMessageContent uses it for currentThreadId)
const chatStoreState = {
  currentThreadId: 'thread_current',
  updateRichBlock: vi.fn(),
  setWorkspaceOpenFile: vi.fn(),
};
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign((selector: (s: typeof chatStoreState) => unknown) => selector(chatStoreState), {
    getState: () => chatStoreState,
  }),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const mockScrollToMessage = vi.fn();
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: (...args: unknown[]) => mockScrollToMessage(...args) }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ConciergeMessageContent (Bug2 inline marker buttons)', () => {
  let ConciergeMessageContent: typeof import('../ConciergeMessageContent').ConciergeMessageContent;
  let container: HTMLDivElement;
  let root: Root;
  let pushStateSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Dynamic import after mocks are set up
    const mod = await import('../ConciergeMessageContent');
    ConciergeMessageContent = mod.ConciergeMessageContent;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    pushStateSpy = vi.spyOn(window.history, 'pushState');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // AC-2: teleport marker → inline button
  it('renders [跳过去 R1] as inline button', () => {
    const actions = [
      {
        action: 'concierge_teleport' as const,
        label: '跳过去：F229 讨论',
        handle: 'R1',
        verb: '跳过去',
        payload: { threadId: 'thread_target', messageId: 'msg_123' },
      },
    ];

    act(() => {
      root.render(createElement(ConciergeMessageContent, { content: '找到了！你可以 [跳过去 R1] 看看', actions }));
    });

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toContain('跳过去');
    expect(buttons[0].textContent).toContain('R1');
  });

  // AC-2: teleport click triggers pathname navigation (NOT query)
  it('teleport button click navigates via pushState pathname', () => {
    const actions = [
      {
        action: 'concierge_teleport' as const,
        label: '跳过去：Target',
        handle: 'R1',
        verb: '跳过去',
        payload: { threadId: 'thread_B' },
      },
    ];

    act(() => {
      root.render(createElement(ConciergeMessageContent, { content: '[跳过去 R1]', actions }));
    });

    const button = container.querySelector('button')!;
    act(() => {
      button.click();
    });

    expect(pushStateSpy).toHaveBeenCalledWith(expect.anything(), '', expect.stringContaining('/thread/thread_B'));
  });

  // P1 fix: same-thread teleport with messageId → scrollToMessage (not pushState)
  it('same-thread teleport with messageId calls scrollToMessage', () => {
    const actions = [
      {
        action: 'concierge_teleport' as const,
        label: '跳过去：Same Thread Target',
        handle: 'R1',
        verb: '跳过去',
        payload: { threadId: 'thread_current', messageId: 'msg_target' },
      },
    ];

    act(() => {
      root.render(createElement(ConciergeMessageContent, { content: '[跳过去 R1]', actions }));
    });

    const button = container.querySelector('button')!;
    act(() => {
      button.click();
    });

    // Same thread: should scroll, NOT pushState
    expect(mockScrollToMessage).toHaveBeenCalledWith('msg_target');
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  // AC-3: peek marker with messageId → inline button
  it('renders [原地看 R2] as inline button when action has messageId', () => {
    const actions = [
      {
        action: 'concierge_peek' as const,
        label: '原地看：记忆搜索',
        handle: 'R2',
        verb: '原地看',
        payload: { threadId: 'thread_abc', messageId: 'msg_456' },
      },
    ];

    act(() => {
      root.render(createElement(ConciergeMessageContent, { content: '这里有 [原地看 R2] 的内容', actions }));
    });

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toContain('原地看');
    expect(buttons[0].textContent).toContain('R2');
  });

  // AC-4: peek without messageId → degraded (no dead button)
  it('degrades peek marker to plain text when no matching action (validator skipped)', () => {
    // Only teleport survives (validator skip peek without messageId)
    const actions = [
      {
        action: 'concierge_teleport' as const,
        label: '跳过去：Thread Only',
        handle: 'R1',
        verb: '跳过去',
        payload: { threadId: 'thread_target' },
      },
    ];

    act(() => {
      root.render(
        createElement(ConciergeMessageContent, {
          content: '你可以 [跳过去 R1] 或 [原地看 R1] 看看',
          actions,
        }),
      );
    });

    const buttons = container.querySelectorAll('button');
    // Only teleport button, NOT peek (AC-4: no dead button)
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toContain('跳过去');
    // Peek marker NOT shown as raw bracket text (AC-5)
    expect(container.innerHTML).not.toContain('[原地看 R1]');
  });

  // AC-5: no raw bracket markers visible
  it('never shows raw [verb Rn] bracket text', () => {
    const actions = [
      {
        action: 'concierge_teleport' as const,
        label: '跳过去：Topic',
        handle: 'R1',
        verb: '跳过去',
        payload: { threadId: 'thread_t' },
      },
    ];

    act(() => {
      root.render(
        createElement(ConciergeMessageContent, {
          content: '你可以看看 [跳过去 R1] 里的讨论',
          actions,
        }),
      );
    });

    // Raw bracket text must not appear
    expect(container.innerHTML).not.toContain('[跳过去 R1]');
    // But the button label should contain the text (without brackets)
    expect(container.textContent).toContain('跳过去');
  });

  // Plain text (no markers) → passthrough
  it('renders plain text content unchanged when no markers', () => {
    act(() => {
      root.render(createElement(ConciergeMessageContent, { content: '纯文本，没有标记', actions: [] }));
    });

    expect(container.textContent).toBe('纯文本，没有标记');
    expect(container.querySelector('button')).toBeNull();
  });

  // BUG-UX-7: Markdown rendering — unified with thread chat MarkdownContent
  describe('BUG-UX-7: Markdown rendering (unified with MarkdownContent)', () => {
    it('renders **bold** text as <strong> elements', () => {
      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '这是**加粗**的文字',
            actions: [],
          }),
        );
      });

      const strong = container.querySelector('strong');
      expect(strong).not.toBeNull();
      expect(strong?.textContent).toBe('加粗');
    });

    it('renders `inline code` as <code> elements', () => {
      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '运行 `pnpm test` 命令',
            actions: [],
          }),
        );
      });

      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code?.textContent).toBe('pnpm test');
    });

    it('renders markdown lists as <ul>/<li>', () => {
      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '找到了以下结果：\n\n- 第一项\n- 第二项',
            actions: [],
          }),
        );
      });

      const list = container.querySelector('ul');
      expect(list).not.toBeNull();
      const items = container.querySelectorAll('li');
      expect(items.length).toBe(2);
    });

    it('renders markdown between marker buttons correctly', () => {
      const actions = [
        {
          action: 'concierge_teleport' as const,
          label: '跳过去',
          handle: 'R1',
          verb: '跳过去',
          payload: { threadId: 'thread_t' },
        },
      ];

      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '**发现了！** 详情请 [跳过去 R1] 查看',
            actions,
          }),
        );
      });

      // Both markdown rendering and marker button should work
      expect(container.querySelector('strong')).not.toBeNull();
      expect(container.querySelector('button')).not.toBeNull();
    });

    it('uses MarkdownContent wrapper (unified .markdown-content class)', () => {
      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '普通文本',
            actions: [],
          }),
        );
      });

      // MarkdownContent wraps output in a div.markdown-content
      expect(container.querySelector('.markdown-content')).not.toBeNull();
    });

    // P1 fix: markers inside inline code are NOT extracted as buttons
    it('does not extract markers inside inline code blocks', () => {
      const actions = [
        {
          action: 'concierge_teleport' as const,
          label: '跳过去',
          handle: 'R1',
          verb: '跳过去',
          payload: { threadId: 'thread_t' },
        },
      ];

      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '使用 `[跳过去 R1]` 格式的标记',
            actions,
          }),
        );
      });

      // Marker inside code block → rendered as code text, NOT as a button
      expect(container.querySelector('button')).toBeNull();
      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code?.textContent).toContain('[跳过去 R1]');
    });

    // P1 R2 fix: markers inside bold/formatted text are processed (not just p/li)
    it('processes markers inside bold text (textProcessor covers all text components)', () => {
      const actions = [
        {
          action: 'concierge_teleport' as const,
          label: '跳过去',
          handle: 'R1',
          verb: '跳过去',
          payload: { threadId: 'thread_t' },
        },
      ];

      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '重要！**[跳过去 R1]**',
            actions,
          }),
        );
      });

      // Marker inside bold → should be a button, not raw bracket text
      const button = container.querySelector('button');
      expect(button).not.toBeNull();
      expect(button?.textContent).toContain('跳过去');
      // Raw bracket text must not appear
      expect(container.innerHTML).not.toContain('[跳过去 R1]');
    });

    // P2 fix: single MarkdownContent → inline flow preserved
    it('preserves inline flow (single <p> for text with markers)', () => {
      const actions = [
        {
          action: 'concierge_teleport' as const,
          label: '跳过去',
          handle: 'R1',
          verb: '跳过去',
          payload: { threadId: 'thread_t' },
        },
      ];

      act(() => {
        root.render(
          createElement(ConciergeMessageContent, {
            content: '前文 [跳过去 R1] 后文',
            actions,
          }),
        );
      });

      // Single MarkdownContent → exactly one .markdown-content wrapper (not N per segment)
      const mdWrappers = container.querySelectorAll('.markdown-content');
      expect(mdWrappers.length).toBe(1);

      // The button should be inside a <p> element (inline with surrounding text)
      const button = container.querySelector('button');
      expect(button).not.toBeNull();
      expect(button?.closest('p')).not.toBeNull();
    });
  });

  // BUG-UX-9: button displays corrected verb from action, not raw text verb
  describe('BUG-UX-9: verb display matches action type', () => {
    it('displays "跳过去" when action is teleport but text says "原地看" (auto-corrected)', () => {
      // API auto-corrected peek→teleport, but kept verb field as "原地看" for map key matching
      // Frontend should display based on action.action, not raw text verb
      const actions = [
        {
          action: 'concierge_teleport' as const,
          label: '跳过去：Thread Level',
          handle: 'R1',
          verb: '原地看', // original text verb (before auto-correction was reflected in verb field)
          payload: { threadId: 'thread_target' },
        },
      ];

      act(() => {
        root.render(createElement(ConciergeMessageContent, { content: '看看 [原地看 R1]', actions }));
      });

      const button = container.querySelector('button');
      expect(button).not.toBeNull();
      // Button text should show the CORRECT verb for the action type
      expect(button?.textContent).toContain('跳过去');
      expect(button?.textContent).not.toContain('原地看');
    });

    it('displays teleport styling (color/icon) when action is auto-corrected teleport', () => {
      const actions = [
        {
          action: 'concierge_teleport' as const,
          label: '跳过去：Target',
          handle: 'R1',
          verb: '原地看',
          payload: { threadId: 'thread_target' },
        },
      ];

      act(() => {
        root.render(createElement(ConciergeMessageContent, { content: '[原地看 R1]', actions }));
      });

      const button = container.querySelector('button')!;
      // Should have teleport icon (→), not peek icon (👁)
      expect(button.textContent).toContain('→');
      expect(button.textContent).not.toContain('👁');
    });
  });

  // AC-6: card actions fallback (no handle/verb) → no inline buttons, text unchanged
  it('does not crash on actions without handle/verb (KD-19 fallback)', () => {
    const actions = [
      {
        action: 'concierge_teleport' as const,
        label: '跳过去：Topic',
        payload: { threadId: 'thread_t' },
        // No handle/verb — fallback actions from KD-19
      },
    ];

    act(() => {
      root.render(
        createElement(ConciergeMessageContent, {
          content: '纯文本，没有标记',
          actions: actions as Array<{ action: string; label: string; payload: { threadId: string } }>,
        }),
      );
    });

    // Should render cleanly — no crash, no spurious buttons
    expect(container.textContent).toBe('纯文本，没有标记');
    expect(container.querySelector('button')).toBeNull();
  });
});
