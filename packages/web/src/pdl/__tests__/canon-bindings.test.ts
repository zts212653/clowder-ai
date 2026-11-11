import { workCommandSchema } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { item, record, update } from '@/components/workbench/content-review/__tests__/asset-canon.fixtures';
import { apiFetch } from '@/utils/api-client';
import { useCanonBindings } from '../useCanonBindings';
import { act, cleanup, renderHook } from './hook-host';
import { useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let current: typeof item, writes: Record<string, unknown>[], fail: boolean, notices: (typeof update)[];
beforeEach(() => {
  window.clowderChat = { dataOk: vi.fn(), dataError: vi.fn() } as unknown as typeof window.clowderChat;
  current = structuredClone(item);
  writes = [];
  fail = false;
  notices = [structuredClone(update)];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    expect(path).toBe('/api/works/command');
    const body = JSON.parse(String(init?.body)) as { threadId: string; command: Record<string, unknown> };
    expect(body.threadId).toBe('source-thread');
    expect(workCommandSchema.safeParse(body.command).success).toBe(true);
    const command = body.command;
    if (command.action === 'read-context') return response(record);
    if (command.action === 'list-assets')
      return response({
        items: [current, update.replacement],
        updates: notices,
        snapshot: 'frozen',
        nextAfter: undefined,
      });
    if (command.action === 'read-asset') return response(current);
    if (command.action === 'read-asset-history') return response({ history: [], decisions: [] });
    writes.push(command);
    if (fail) {
      fail = false;
      return response({ error: 'unknown' }, 503);
    }
    if (command.action === 'set-asset-status') {
      current = {
        ...current,
        record: { ...current.record, status: command.status as 'experimental', revision: current.record.revision + 1 },
      };
      return response({ item: current });
    }
    if (command.action === 'decide-asset-update') {
      notices = [];
      return response({ ok: true });
    }
    return response({ ok: true });
  });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open() {
  const workbench: { canon?: unknown } = {},
    modify = vi.fn();
  const hook = renderHook(() =>
    useOwnerProjection('canon', useCanonBindings('source-thread', workbench, modify, true), { ws: workbench }),
  );
  await act(() =>
    hook.result.current.action('assetCanonRead', {
      reference: record.reference as unknown as string,
      indexedVersionRef: item.record.indexedVersionRef,
    }),
  );
  return { ...hook, workbench, modify };
}
it('retries a failed status command with the same operation and both owner revisions intact', async () => {
  const hook = await open();
  hook.result.current.state.current!.reason = 'Human judgment';
  fail = true;
  await act(async () => {
    await expect(hook.result.current.action('canonAssetStatus', { v: 'experimental' })).rejects.toThrow();
  });
  expect(hook.result.current.project().assetCanon?.detail?.status).toBeNull();
  await act(() => hook.result.current.action('canonAssetStatus', { v: 'experimental' }));
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toMatchObject({
    action: 'set-asset-status',
    expectedRevision: 0,
    context: { reference: record.reference, metadataRevision: 3 },
    reason: 'Human judgment',
  });
  expect(hook.result.current.project().assetCanon?.detail?.status).toBe('experimental');
});
it('writes keep decisions with the original notice identity and only removes them after owner reread', async () => {
  const hook = await open();
  hook.result.current.state.current!.reason = 'Keep this production version';
  await act(() => hook.result.current.action('assetCanonUpdate', { decision: 'keep_this_version' }));
  expect(writes[0]).toMatchObject({
    action: 'decide-asset-update',
    reference: record.reference,
    noticeScope: update.noticeScope,
    updateFingerprint: update.updateFingerprint,
    expectedDecisionRevision: update.decisionRevision,
  });
  expect(hook.result.current.project().assetCanon?.detail?.update).toBeNull();
});
