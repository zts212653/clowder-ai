import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { F290AssetCollaboration } from '../asset-collaboration';

Object.assign(globalThis as Record<string, unknown>, { React });

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const target = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`Missing button: ${label}`);
  return target;
}

describe('F290 asset collaboration v-next', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<F290AssetCollaboration />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens on the current result with eight source-linked collaboration records', () => {
    expect(container.textContent).toContain('插件平台契约与分工：v0 讨论');
    expect(container.textContent).toContain('当前版本 · v3');
    expect(container.textContent).toContain('协同记录');

    const records = container.querySelectorAll('[data-collaboration-record]');
    expect(records).toHaveLength(8);
    expect(container.textContent).toContain('接受');
    expect(container.textContent).toContain('部分接受');
    expect(container.textContent).toContain('保留分歧');
    expect(container.textContent).toContain('新版本');

    const sourceLinks = container.querySelectorAll<HTMLAnchorElement>('[data-record-source]');
    expect(sourceLinks).toHaveLength(8);
    expect(sourceLinks[0]?.href).toContain('issuecomment-4951786772');
    expect(sourceLinks[7]?.href).toContain('issuecomment-4966794934');
  });

  it('gives reading, editing, and discussion visibly distinct working modes', async () => {
    const scene = container.querySelector<HTMLElement>('[data-testid="asset-workspace"]');
    expect(scene?.dataset.mode).toBe('read');
    expect(container.textContent).toContain('正在阅读当前版本');

    await act(async () => buttonByText(container, '审阅修改').click());
    expect(scene?.dataset.mode).toBe('edit');
    expect(container.querySelector('[data-testid="asset-change-decision"]')).not.toBeNull();
    expect(container.textContent).toContain('正在审阅修改建议');

    await act(async () => buttonByText(container, '批注').click());
    expect(scene?.dataset.mode).toBe('discuss');
    expect(container.querySelector('[data-testid="asset-discussion"]')).not.toBeNull();
    expect(container.textContent).toContain('正在围绕原文讨论');
    expect(container.textContent).toContain('吴浪');
    expect(container.textContent).toContain('You');
  });

  it('names proposal review as review rather than free-form editing', () => {
    expect(() => buttonByText(container, '审阅修改')).not.toThrow();
  });

  it('keeps the current work mode explicit in the navigation active treatment', async () => {
    const readButton = buttonByText(container, '阅读');
    const reviewButton = buttonByText(container, '审阅修改');

    expect(readButton.getAttribute('aria-pressed')).toBe('true');
    expect(readButton.className).toContain('bg-cafe-interactive');

    await act(async () => reviewButton.click());

    expect(reviewButton.getAttribute('aria-pressed')).toBe('true');
    expect(reviewButton.className).toContain('bg-cafe-interactive');
    expect(readButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('projects each work mode onto the matching collaboration record', async () => {
    await act(async () => buttonByText(container, '审阅修改').click());
    expect(container.querySelector('[aria-current="step"]')?.getAttribute('data-record-id')).toBe('partial-4965951215');

    await act(async () => buttonByText(container, '批注').click());
    expect(container.querySelector('[aria-current="step"]')?.getAttribute('data-record-id')).toBe('review-4951812238');
  });

  it('uses the record as a causal return path instead of a decorative activity list', async () => {
    const target = container.querySelector<HTMLButtonElement>('[data-record-id="cleanup-279a9cb"]');
    if (!target) throw new Error('Missing collaboration record');

    await act(async () => target.click());

    expect(target.getAttribute('aria-current')).toBe('step');
    expect(container.querySelector('[data-active-record="cleanup-279a9cb"]')).not.toBeNull();
    expect(container.textContent).toContain('四组修改逐项落进新版本');
  });
});
