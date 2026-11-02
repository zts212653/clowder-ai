import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { ConnectorBubble } from '../ConnectorBubble';

const path = '/workspace/cat-cafe-alpha-f333-acceptance';
const legacy = `工位需要原负责人核对收尾：retention-head-changed
owner="codex-astra"
path="${path}"
source="task:work:original"
until="2026-11-02T15:40:00.000Z"
请核对原用途后执行 worktree:finish 或给出新的原因与截止。目录未被自动修改。`;

describe('readable worktree notices', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  function render(
    content = legacy,
    from: ChatMessage['from'] = { kind: 'system', service: 'worktree-lifecycle' },
    notice?: unknown,
  ) {
    const message: ChatMessage = {
      id: 'historical-worktree-notice',
      type: 'connector',
      from,
      content,
      timestamp: 1793100493544,
      source: {
        connector: 'worktree-lifecycle',
        label: '工位续留提醒',
        icon: 'scheduler',
        ...(notice ? { meta: { worktreeNotice: notice } } : {}),
      },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
  }
  it('renders old retained-version warnings as a compact explanation, keeping full recovery details folded', () => {
    render();
    expect(container.textContent).toContain('保留登记需要更新');
    expect(container.textContent).toContain('原保留登记对应较早版本');
    expect(container.textContent).toContain('cat-cafe-alpha-f333-acceptance');
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(path);
    expect(details?.textContent).toContain('task:work:original');
  });
  it('uses a registered SVG avatar instead of raw sch/scheduler text for persisted notices', () => {
    render();
    const avatar = container.querySelector('[data-sender-avatar="message"]');
    expect(avatar?.querySelector('svg')).not.toBeNull();
    expect(avatar?.textContent).toBe('');
  });
  it('does not interpret an external sender as an authoritative Host worktree notice', () => {
    render(legacy, {
      kind: 'external',
      connectorId: 'other-source',
      sender: { id: 'external-person', name: 'Person' },
    });
    expect(container.textContent).toContain('retention-head-changed');
    expect(container.textContent).not.toContain('保留登记需要更新');
  });
  it('does not offer a dead Workspace link for a removed checkout', () => {
    render('', undefined, {
      version: 1,
      kind: 'merged-removed',
      owner: 'codex-astra',
      path,
      sourceRef: 'pr:fixture/repo#42',
    });
    expect(container.textContent).toContain('工位已回收');
    expect(container.textContent).toContain('cat-cafe-alpha-f333-acceptance');
    expect(container.querySelector('a')).toBeNull();
  });
  it('keeps a partial-removal warning visible before expanding recovery details', () => {
    render('', undefined, {
      version: 1,
      kind: 'merged-retirement-blocked',
      owner: 'codex-astra',
      path,
      sourceRef: 'pr:fixture/repo#42',
      archivePath: '/fixture/only-copy',
      ownerAction: 'queued',
    });
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect([...container.querySelectorAll('section > p')].some((p) => p.textContent?.includes('请保留恢复归档'))).toBe(
      true,
    );
    expect(container.textContent).toContain('已排入负责人待办');
    expect(container.querySelector('a')).toBeNull();
  });
  it('shows an unavailable owner as an unresolved exception rather than a successful handoff', () => {
    render('', undefined, {
      version: 1,
      kind: 'retention-expired',
      owner: 'codex-astra',
      path,
      sourceRef: 'task:work:original',
      ownerAction: 'unavailable',
    });
    expect(container.textContent).toContain('未排入负责人待办 · 待维护核对');
    expect(container.textContent).not.toContain('已排入负责人待办');
  });
});
