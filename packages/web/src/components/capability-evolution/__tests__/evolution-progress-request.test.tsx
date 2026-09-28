import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityEvolutionProgramDetail } from '../CapabilityEvolutionProgramDetail';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';
import { useEvolutionProgressRequests } from '../journey/evolution-progress-request';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [{ id: 'codex-sol', displayName: 'Sol' }] }) }));

describe('operator can ask the initiating cat to advance the existing Program', () => {
  let host: HTMLDivElement;
  let root: Root;
  let projection: EvolutionProgramProjection;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useEvolutionProgressRequests.setState({ records: {}, pending: {}, errors: {} });
    useEvolutionReading.setState({ programs: {} });
    projection = programFixture('instrumenting');
    projection.origin = { threadId: 'thread-origin', title: '评估准备', createdByCatId: 'codex-sol' };
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path === '/api/cats') return Response.json({ cats: [{ id: 'codex-sol' }] });
      if (path === '/api/messages')
        return Response.json({ status: 'queued', userMessageId: 'request-1' }, { status: 202 });
      if (path.includes('/asset-review'))
        return Response.json({ error: 'owner_version_review_unavailable' }, { status: 422 });
      return Response.json(projection);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render() {
    await act(async () =>
      root.render(
        <CapabilityEvolutionProgramDetail
          projection={projection}
          onClose={() => undefined}
          onOpenProgram={() => undefined}
        />,
      ),
    );
  }
  function primary() {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '请猫猫推进评估');
    expect(button, 'preparation needs an action, not just a larger reading pane').toBeDefined();
    if (!button) throw new Error('missing progress action');
    return button;
  }
  it('sends one explicit continuation to the source cat/thread and exposes the durable queued receipt', async () => {
    await render();
    expect(api.fetch.mock.calls.filter(([path]) => path === '/api/messages')).toHaveLength(0);
    const button = primary();
    await act(async () => {
      button.click();
      button.click();
    });
    const writes = api.fetch.mock.calls.filter(([path]) => path === '/api/messages');
    expect(writes).toHaveLength(1);
    const request = JSON.parse(writes[0]?.[1].body);
    expect(request.threadId).toBe('thread-origin');
    expect(request.content).toMatch(/^@codex-sol\n/);
    expect(request.content).toContain(projection.program.programId);
    expect(request.content).toContain('推进');
    expect(request.messageDisposition).toBe('continue_current');
    expect(request.deliveryMode).toBeUndefined();
    expect(host.textContent).toContain('已排队');
    expect(host.querySelector('a[data-testid="evolution-progress-receipt"]')?.getAttribute('href')).toContain(
      'thread-origin',
    );
    expect(projection.program.stage).toBe('instrumenting');
    expect(api.fetch.mock.calls.some(([path]) => path.endsWith('/commands'))).toBe(false);
    const remind = [...host.querySelectorAll('button')].find((item) => item.textContent === '再提醒一次');
    if (!remind) throw new Error('an explicit reminder must remain possible if progress stalls');
    await act(async () => {
      remind.click();
      remind.click();
    });
    const reminders = api.fetch.mock.calls.filter(([path]) => path === '/api/messages');
    expect(reminders).toHaveLength(2);
    expect(JSON.parse(reminders[1]?.[1].body).idempotencyKey).not.toBe(request.idempotencyKey);
  });
  it('does not send when the source is absent, paused, or has changed before the click', async () => {
    projection.origin = undefined;
    await render();
    expect(host.textContent).toContain('尚未找到可联系的发起猫猫');
    expect(host.textContent).not.toContain('请猫猫推进评估');
    projection.origin = { threadId: 'thread-origin', title: '评估准备', createdByCatId: 'codex-sol' };
    projection.program.lifecycle = 'paused';
    await render();
    expect(host.textContent).not.toContain('请猫猫推进评估');
    projection.program.lifecycle = 'active';
    await render();
    const changed = structuredClone(projection);
    changed.program.sequence += 1;
    api.fetch.mockImplementation(async () => Response.json(changed));
    await act(async () => primary().click());
    expect(host.textContent).toContain('项目已更新');
    expect(api.fetch.mock.calls.some(([path]) => path === '/api/messages')).toBe(false);
  });
  it('retries an uncertain delivery with the same durable id and keeps the receipt after reload', async () => {
    let attempts = 0;
    const accepted = new Set<string>();
    api.fetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/cats') return Response.json({ cats: [{ id: 'codex-sol' }] });
      if (path === '/api/messages') {
        attempts += 1;
        accepted.add(JSON.parse(String(options?.body)).idempotencyKey);
        if (attempts === 1) throw new TypeError('connection lost after write');
        return Response.json({ status: 'duplicate', userMessageId: 'request-1' });
      }
      return Response.json(projection);
    });
    await render();
    await act(async () => primary().click());
    expect(host.textContent).toContain('网络暂时中断');
    const saved = JSON.parse(localStorage.getItem('f311-progress-requests-v1')!);
    saved.state.records.unrelatedBrokenRecord = { clientMessageId: 'not-a-valid-id' };
    await act(async () => useEvolutionProgressRequests.setState({ records: {}, pending: {}, errors: {} }));
    localStorage.setItem('f311-progress-requests-v1', JSON.stringify(saved));
    await act(async () => useEvolutionProgressRequests.persist.rehydrate());
    await act(async () => primary().click());
    const writes = api.fetch.mock.calls.filter(([path]) => path === '/api/messages');
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]?.[1].body).idempotencyKey).toBe(JSON.parse(writes[1]?.[1].body).idempotencyKey);
    expect(accepted.size).toBe(1);
    await act(async () => useEvolutionProgressRequests.persist.rehydrate());
    await render();
    expect(host.textContent).toContain('推进请求已送达');
    expect(host.textContent).not.toContain('请猫猫推进评估');
    expect(attempts).toBe(2);
  });
  it('refuses a foreign source or unavailable contact without falling back to another cat', async () => {
    await render();
    const foreign = structuredClone(projection);
    foreign.program.workspaceId = 'user:other';
    api.fetch.mockImplementation(async () => Response.json(foreign));
    await act(async () => primary().click());
    expect(host.textContent).toContain('项目已更新');
    api.fetch.mockImplementation(async (path: string) =>
      Response.json(
        path === '/api/cats'
          ? { cats: [{ id: 'codex-sol', roster: { available: false } }, { id: 'opus5' }] }
          : projection,
      ),
    );
    await act(async () => primary().click());
    expect(host.textContent).toContain('发起猫猫当前不可用');
    expect(api.fetch.mock.calls.some(([path]) => path === '/api/messages')).toBe(false);
  });
});
