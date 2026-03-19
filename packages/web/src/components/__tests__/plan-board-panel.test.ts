/**
 * F055: PlanBoardPanel — 猫猫祟祟
 * Tests for independent per-cat plan board in right sidebar.
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatInvocationInfo } from '@/stores/chatStore';

const origCreateElement = document.createElement.bind(document);

/* ── Mocks ────────────────────────────────────────────────── */
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    isLoading: false,
    getCatById: (id: string) => {
      const cats: Record<string, { id: string; displayName: string; color: { primary: string } }> = {
        opus: { id: 'opus', displayName: 'Opus', color: { primary: '#7C3AED' } },
        codex: { id: 'codex', displayName: 'Codex', color: { primary: '#059669' } },
        gemini: { id: 'gemini', displayName: 'Gemini', color: { primary: '#D97706' } },
        sonnet: { id: 'sonnet', displayName: 'Sonnet', color: { primary: '#2563EB' } },
      };
      return cats[id] ?? null;
    },
    getCatsByBreed: () => new Map(),
  }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn() }),
}));

vi.mock('@/utils/taskProgressContinue', () => ({
  buildContinueMessage: () => 'continue',
}));

/* ── Helpers ──────────────────────────────────────────────── */

function makeTasks(specs: Array<{ status: 'pending' | 'in_progress' | 'completed'; subject: string }>) {
  return specs.map((s, i) => ({
    id: `t${i}`,
    subject: s.subject,
    status: s.status,
    ...(s.status === 'in_progress' ? { activeForm: `${s.subject}中...` } : {}),
  }));
}

function makeInvocation(
  overrides: Partial<CatInvocationInfo> & { taskProgress: CatInvocationInfo['taskProgress'] },
): CatInvocationInfo {
  return {
    startedAt: Date.now(),
    ...overrides,
  };
}

/* ── Test suite ───────────────────────────────────────────── */

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

beforeEach(() => {
  container = origCreateElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Lazy import so mocks are in place
async function renderPanel(threadId: string, catInvocations: Record<string, CatInvocationInfo>) {
  const { PlanBoardPanel } = await import('../PlanBoardPanel');
  act(() => {
    root.render(React.createElement(PlanBoardPanel, { threadId, catInvocations }));
  });
}

describe('F055: PlanBoardPanel (猫猫祟祟)', () => {
  it('AC-1: renders section title with cat count', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([{ status: 'in_progress', subject: 'Write code' }]),
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
        },
      }),
    });

    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    expect(container.textContent).toContain('猫猫祟祟');
    expect(container.textContent).toMatch(/1/); // 1 cat with plan
  });

  it('AC-2: shows only cats with taskProgress (filters out empty)', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([{ status: 'completed', subject: 'Done' }]),
          lastUpdate: Date.now(),
          snapshotStatus: 'completed',
        },
      }),
      codex: makeInvocation({ taskProgress: undefined }),
      gemini: makeInvocation({
        taskProgress: { tasks: [], lastUpdate: Date.now(), snapshotStatus: 'running' },
      }),
    });

    // Only opus has real tasks; codex has no taskProgress; gemini has empty tasks
    // Opus is completed, so it's in the collapsed fold — count should be 1
    expect(container.textContent).toContain('猫猫祟祟 (1)');
    expect(container.textContent).toContain('已完成 (1)');
    expect(container.textContent).not.toContain('Codex');
    expect(container.textContent).not.toContain('Gemini');
  });

  it('AC-2: does not render when no cats have taskProgress', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({ taskProgress: undefined }),
    });

    expect(container.querySelector('section')).toBeNull();
  });

  it('AC-3: renders per-cat card with name and progress', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([
            { status: 'completed', subject: 'Step 1' },
            { status: 'in_progress', subject: 'Step 2' },
            { status: 'pending', subject: 'Step 3' },
          ]),
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
        },
      }),
    });

    expect(container.textContent).toContain('Opus');
    expect(container.textContent).toContain('1/3'); // 1 completed out of 3
    expect(container.textContent).toContain('Step 1');
    expect(container.textContent).toContain('Step 2中...'); // activeForm for in_progress
    expect(container.textContent).toContain('Step 3');
  });

  it('uses SVG status markers instead of emoji glyphs', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([
            { status: 'completed', subject: 'Step 1' },
            { status: 'in_progress', subject: 'Step 2' },
            { status: 'pending', subject: 'Step 3' },
          ]),
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
        },
      }),
    });

    const text = container.textContent ?? '';
    expect(text).not.toContain('✅');
    expect(text).not.toContain('🔄');
    expect(text).not.toContain('⬚');
  });

  it('exposes per-task status as screen-reader-only text without invalid aria-label', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([
            { status: 'completed', subject: 'Step 1' },
            { status: 'in_progress', subject: 'Step 2' },
            { status: 'pending', subject: 'Step 3' },
          ]),
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
        },
      }),
    });

    expect(container.querySelectorAll('div[aria-label]')).toHaveLength(0);

    const srOnlyTexts = Array.from(container.querySelectorAll('.sr-only')).map((el) => el.textContent?.trim());
    expect(srOnlyTexts).toContain('已完成');
    expect(srOnlyTexts).toContain('进行中');
    expect(srOnlyTexts).toContain('待处理');
  });

  it('AC-4: running cats appear first, completed fold to bottom', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([{ status: 'completed', subject: 'Done task' }]),
          lastUpdate: Date.now() - 5000,
          snapshotStatus: 'completed',
        },
      }),
      codex: makeInvocation({
        startedAt: Date.now(),
        taskProgress: {
          tasks: makeTasks([{ status: 'in_progress', subject: 'Active task' }]),
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
        },
      }),
    });

    const text = container.textContent ?? '';
    // Codex (running) should appear before the "已完成" fold
    const codexPos = text.indexOf('Codex');
    const completedFoldPos = text.indexOf('已完成');
    expect(codexPos).toBeGreaterThan(-1);
    expect(completedFoldPos).toBeGreaterThan(-1);
    expect(codexPos).toBeLessThan(completedFoldPos);

    // Opus (completed) should be hidden behind fold by default
    // Since completed section is collapsed, Opus task details should not be visible
    expect(text).not.toContain('Done task');
  });

  it('AC-4: completed section can be expanded', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([{ status: 'completed', subject: 'Finished work' }]),
          lastUpdate: Date.now(),
          snapshotStatus: 'completed',
        },
      }),
    });

    // Click expand button
    const expandBtn = container.querySelector('button');
    expect(expandBtn).not.toBeNull();
    act(() => {
      expandBtn?.click();
    });

    expect(container.textContent).toContain('Finished work');
  });

  it('AC-5: interrupted cat shows continue button', async () => {
    await renderPanel('thread-1', {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([
            { status: 'completed', subject: 'Step 1' },
            { status: 'pending', subject: 'Step 2' },
          ]),
          lastUpdate: Date.now(),
          snapshotStatus: 'interrupted',
        },
      }),
    });

    expect(container.textContent).toContain('已中断');
    const continueBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('继续'));
    expect(continueBtn).not.toBeUndefined();
  });

  it('AC-6: re-renders when taskProgress changes (new invocation)', async () => {
    const invocations: Record<string, CatInvocationInfo> = {
      opus: makeInvocation({
        taskProgress: {
          tasks: makeTasks([{ status: 'completed', subject: 'Old plan' }]),
          lastUpdate: Date.now(),
          snapshotStatus: 'completed',
        },
      }),
    };

    await renderPanel('thread-1', invocations);

    // Simulate new invocation resetting the plan
    const { PlanBoardPanel } = await import('../PlanBoardPanel');
    const newInvocations: Record<string, CatInvocationInfo> = {
      opus: makeInvocation({
        invocationId: 'inv-new',
        startedAt: Date.now(),
        taskProgress: {
          tasks: makeTasks([{ status: 'in_progress', subject: 'New plan' }]),
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
        },
      }),
    };
    act(() => {
      root.render(
        React.createElement(PlanBoardPanel, {
          threadId: 'thread-1',
          catInvocations: newInvocations,
        }),
      );
    });

    expect(container.textContent).toContain('New plan');
    expect(container.textContent).not.toContain('Old plan');
  });

  it('AC-7: renders 8 cats without crash', async () => {
    const cats = ['opus', 'codex', 'gemini', 'sonnet', 'cat5', 'cat6', 'cat7', 'cat8'];
    const invocations: Record<string, CatInvocationInfo> = {};
    for (const catId of cats) {
      invocations[catId] = makeInvocation({
        startedAt: Date.now(),
        taskProgress: {
          tasks: makeTasks([{ status: 'in_progress', subject: `${catId} work` }]),
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
        },
      });
    }

    await renderPanel('thread-1', invocations);

    // All 8 cats' work should appear
    for (const catId of cats) {
      expect(container.textContent).toContain(`${catId} work`);
    }
  });
});
