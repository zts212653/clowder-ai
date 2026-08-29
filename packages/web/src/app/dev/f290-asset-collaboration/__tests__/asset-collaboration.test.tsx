import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { F290AssetCollaboration } from '../asset-collaboration';
import { createInitialAssetCollaborationState, F290_ASSET_STORAGE_KEY } from '../asset-collaboration-store';

Object.assign(globalThis as Record<string, unknown>, { React });

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const target = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`Missing button: ${label}`);
  return target;
}

function fieldByLabel(container: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const target = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).find(
    (candidate) => candidate.getAttribute('aria-label') === label,
  );
  if (!target) throw new Error(`Missing field: ${label}`);
  return target;
}

async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('F290 asset collaboration true frontend', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(async () => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<F290AssetCollaboration />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('输入并发送批注 → 批注正文、数量、历程增长', async () => {
    const beforeAnnotations = Number(container.querySelector('[data-testid="annotation-total"]')?.textContent);
    const beforeHistory = Number(container.querySelector('[data-testid="history-total"]')?.textContent);

    await act(async () => container.querySelector<HTMLButtonElement>('[data-annotate-section="memory"]')?.click());
    await typeInto(fieldByLabel(container, '给“记忆归属”添加批注'), 'SENTINEL-批注-不是 fixture');
    await act(async () => buttonByText(container, '发送批注').click());

    expect(container.textContent).toContain('SENTINEL-批注-不是 fixture');
    expect(Number(container.querySelector('[data-testid="annotation-total"]')?.textContent)).toBe(
      beforeAnnotations + 1,
    );
    expect(Number(container.querySelector('[data-testid="history-total"]')?.textContent)).toBe(beforeHistory + 1);
    expect(container.querySelector('[data-section-annotation-count="memory"]')?.textContent).toContain('2 条批注');
  });

  it('输入并发送讨论 → 当前身份消息增长，批注数量不变', async () => {
    const annotationCount = container.querySelector('[data-testid="annotation-total"]')?.textContent;

    await act(async () => buttonByText(container, '讨论').click());
    const beforeMessages = container.querySelectorAll('[data-discussion-message]').length;
    await typeInto(fieldByLabel(container, '围绕整份产物讨论'), 'SENTINEL-讨论-不是 fixture');
    await act(async () => buttonByText(container, '发送讨论').click());

    expect(container.querySelectorAll('[data-discussion-message]')).toHaveLength(beforeMessages + 1);
    expect(container.textContent).toContain('SENTINEL-讨论-不是 fixture');
    expect(container.textContent).toContain('You');
    expect(container.querySelector('[data-testid="annotation-total"]')?.textContent).toBe(annotationCount);
  });

  it('编辑正文并保存 → 正文/版本变化，刷新恢复', async () => {
    await act(async () => buttonByText(container, '编辑产物').click());
    const draft = fieldByLabel(container, '编辑“记忆归属”正文');
    await typeInto(draft, `${draft.value} SENTINEL-正文-不是 fixture`);
    await act(async () => buttonByText(container, '保存新版本').click());

    expect(container.textContent).toContain('SENTINEL-正文-不是 fixture');
    expect(container.querySelector('[data-testid="asset-version"]')?.textContent).toContain('v4');
    expect(localStorage.getItem(F290_ASSET_STORAGE_KEY)).toContain('SENTINEL-正文-不是 fixture');

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<F290AssetCollaboration />));

    expect(container.textContent).toContain('SENTINEL-正文-不是 fixture');
    expect(container.querySelector('[data-testid="asset-version"]')?.textContent).toContain('v4');
  });

  it('接受建议 → 真正改正文、关闭待处理、记录决定', async () => {
    expect(container.querySelector('[data-testid="pending-suggestion-count"]')?.textContent).toContain('1');
    expect(container.textContent).toContain('停用插件时，同时清理与该插件有关的互动记录。');

    await act(async () => buttonByText(container, '接受并更新').click());

    expect(container.textContent).toContain('停用插件不删除关系记忆与互动历史；仅停止新的插件调用。');
    expect(container.textContent).not.toContain('停用插件时，同时清理与该插件有关的互动记录。');
    expect(container.querySelector('[data-testid="pending-suggestion-count"]')?.textContent).toContain('0');
    expect(container.textContent).toContain('已接受修改建议');
    expect(container.textContent).toContain('You 复查后确认四组实质问题已经解决，只剩三处措辞需要统一。');
  });

  it('人工保存新版本后阻止陈旧建议覆盖正文', async () => {
    const sentinel = 'TERRA-REVIEW-HUMAN-MEMORY-EDIT';
    await act(async () => buttonByText(container, '编辑产物').click());
    const draft = fieldByLabel(container, '编辑“记忆归属”正文');
    await typeInto(draft, `${draft.value} ${sentinel}`);
    await act(async () => buttonByText(container, '保存新版本').click());

    expect(container.textContent).toContain(sentinel);
    expect(buttonByText(container, '接受并更新').disabled).toBe(true);
    expect(container.textContent).toContain('正文已产生新版本');
  });

  it('保留分歧 → 正文不变、理由可回看、关闭待处理', async () => {
    const beforeBody = container.querySelector('[data-section-body="memory"]')?.textContent;

    await act(async () => buttonByText(container, '保留分歧').click());
    await typeInto(fieldByLabel(container, '说明保留分歧的理由'), 'SENTINEL-保留理由-需要更多证据');
    await act(async () => buttonByText(container, '确认保留分歧').click());

    expect(container.querySelector('[data-section-body="memory"]')?.textContent).toBe(beforeBody);
    expect(container.textContent).toContain('SENTINEL-保留理由-需要更多证据');
    expect(container.querySelector('[data-testid="pending-suggestion-count"]')?.textContent).toContain('0');
    expect(container.textContent).toContain('已保留分歧');
  });

  it('历程记录 → 返回对应原文/批注/版本', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-annotate-section="memory"]')?.click());
    await typeInto(fieldByLabel(container, '给“记忆归属”添加批注'), 'SENTINEL-回链批注');
    await act(async () => buttonByText(container, '发送批注').click());

    await act(async () => buttonByText(container, '编辑产物').click());
    const draft = fieldByLabel(container, '编辑“事件交付”正文');
    await typeInto(draft, `${draft.value} SENTINEL-回链版本`);
    await act(async () => buttonByText(container, '保存新版本').click());

    await act(async () => buttonByText(container, '历程').click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-action="annotated"]')?.click());
    expect(container.querySelector('[data-selected-section="memory"]')).not.toBeNull();
    expect(container.querySelector('[data-active-annotation]')?.textContent).toContain('SENTINEL-回链批注');

    await act(async () => buttonByText(container, '历程').click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-action="edited"]')?.click());
    expect(container.querySelector('[data-viewing-version]')?.textContent).toContain('SENTINEL-回链版本');

    await act(async () => buttonByText(container, '历程').click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-history-target-kind="section"]')?.click());
    expect(container.querySelector('[data-selected-section]')).not.toBeNull();
  });

  it('keeps the current artifact central and states the browser-local boundary', () => {
    expect(container.querySelector('[data-testid="asset-document"]')).not.toBeNull();
    expect(container.textContent).toContain('本次体验数据保存在此浏览器');
    expect(container.querySelector('[data-concierge-safe-edge="right"]')).not.toBeNull();
  });

  it('embeds a fixture-external artifact through an isolated storage adapter', async () => {
    await act(async () => root.unmount());
    const initialState = createInitialAssetCollaborationState();
    initialState.asset = {
      ...initialState.asset,
      title: 'SENTINEL fixture 外产物',
      origin: '从 Studio Commons 加入',
      summary: '用户刚刚创建的浏览器产物',
      versionId: 'version-user-1',
      updatedAt: '2026-08-25T10:00:00.000Z',
    };
    initialState.versions = [
      {
        id: 'version-user-1',
        number: 1,
        sections: [{ id: 'body', title: '正文', body: 'SENTINEL 初始正文' }],
        createdAt: '2026-08-25T10:00:00.000Z',
        reason: 'fixture',
      },
    ];
    initialState.annotations = [];
    initialState.discussions = [];
    initialState.suggestions = [];
    initialState.history = [];
    initialState.ui = {
      ...initialState.ui,
      selectedSectionId: 'body',
      annotationDrafts: {},
      editDrafts: {},
    };
    const storageKey = 'cat-cafe:f290-artifact:sentinel:v1';

    root = createRoot(container);
    await act(async () =>
      root.render(<F290AssetCollaboration embedded initialState={initialState} storageKey={storageKey} />),
    );
    expect(container.querySelector('[data-asset-host="embedded"]')).not.toBeNull();
    expect(container.textContent).toContain('SENTINEL fixture 外产物');
    expect(container.textContent).toContain('SENTINEL 初始正文');

    await act(async () => buttonByText(container, '编辑产物').click());
    await typeInto(fieldByLabel(container, '编辑“正文”正文'), 'SENTINEL 已编辑正文');
    await act(async () => buttonByText(container, '保存新版本').click());

    expect(localStorage.getItem(storageKey)).toContain('SENTINEL 已编辑正文');
    expect(localStorage.getItem(F290_ASSET_STORAGE_KEY)).toBeNull();
  });
});
