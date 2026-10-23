import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { captureChatReadingRef, readChatReadingRef } from '@/utils/chat-scroll-memory';
import type { ChatReadingPort } from '../../thread-chat/useThreadChatReadingPort';
import { SettingsReadingBridge } from '../settings-reading-bridge';
import { readSettingsReadingSession, startSettingsReadingSession } from '../settings-reading-session';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
function reader(ownerId = 'old-owner', threadId = 'origin'): ChatReadingPort {
  return {
    threadId,
    ownerId,
    captureReadingRef: vi.fn(() =>
      captureChatReadingRef({
        threadId,
        position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'origin-message', viewportOffsetPx: 42 } },
      }),
    ),
    restoreReadingRef: vi.fn(async () => ({
      status: 'settled' as const,
      exact: true,
      position: { top: 320, anchor: 'offset' as const },
    })),
    releaseReadingRef: vi.fn(() => true),
    navigateToMessage: vi.fn(async () => ({ status: 'unavailable' as const })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const admitted = () => Response.json({ status: 'available', updated: false, target: { threadId: 'origin' } });
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('Settings bridge uses the remounted original reading owner', () => {
  let bridge: SettingsReadingBridge;
  const push = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
    vi.mocked(apiFetch).mockReset().mockResolvedValue(admitted());
    bridge = new SettingsReadingBridge(push);
    bridge.setRoute('/thread/origin', true);
  });
  afterEach(() => {
    bridge.dispose();
    vi.restoreAllMocks();
  });
  function enter() {
    const old = reader();
    const unmount = bridge.registerReadingPort(old, () => 'Actual origin title');
    bridge.captureBeforeSettings();
    const source = bridge.getSnapshot().source;
    expect(source).not.toBeNull();
    bridge.setRoute('/settings', true);
    unmount();
    if (!source) throw new Error('source capture failed');
    return { old, source };
  }

  it('records which reader interrupted a return and links its single notice consumption', async () => {
    const { source } = enter();
    await bridge.returnToSource(source.id);
    bridge.setRoute('/thread/origin', true);
    const restore = deferred<Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>>();
    const next = reader('replacement-owner');
    next.restoreReadingRef = vi.fn(() => restore.promise);
    const unregister = bridge.registerReadingPort(next, () => 'private origin title');
    unregister();
    const view = bridge.getSnapshot();
    expect(bridge.consumeNotice(view)).toBe('interrupted');
    expect(bridge.consumeNotice(view)).toBeNull();
    restore.resolve({ status: 'interrupted' });
    await tick();
    const records = JSON.parse(localStorage.getItem('cat-cafe:connection-diagnostics:v1') ?? '[]') as Array<{
      kind: string;
      bridgeId?: string;
      phase?: string;
      cause?: string;
      notice?: string;
      noticeSeq?: number;
    }>;
    const created = records.findLast((record) => record.kind === 'settings_return' && record.phase === 'created');
    expect(created).toBeDefined();
    const own = records.filter((record) => record.bridgeId === created?.bridgeId);
    expect(own).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'cancel', cause: 'reader_unregistered' }),
        expect.objectContaining({ phase: 'notice', notice: 'interrupted' }),
      ]),
    );
    const consumed = own.filter((record) => record.phase === 'consumed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.noticeSeq).toBe(own.findLast((record) => record.phase === 'notice')?.noticeSeq);
    expect(JSON.stringify(own)).not.toContain('private origin title');
  });

  it('captures the actual source once at the settings entry, without copying a draft', () => {
    const old = reader();
    bridge.registerReadingPort(old, () => 'Actual origin title');
    expect(old.captureReadingRef).not.toHaveBeenCalled();
    bridge.captureBeforeSettings();
    expect(old.captureReadingRef).toHaveBeenCalledOnce();
    expect(bridge.getSnapshot().source?.label).toBe('Actual origin title');
    expect(readSettingsReadingSession()).toEqual(bridge.getSnapshot().source);
  });

  it('retires an abandoned trip before a later cold Settings entry, including its reading ref', () => {
    const { source } = enter();
    bridge.setRoute('/thread/other', true);
    expect(readSettingsReadingSession()).toBeNull();
    expect(readChatReadingRef(source.readingRef)).toBeUndefined();
    const cold = new SettingsReadingBridge(push);
    cold.setRoute('/settings', true);
    expect(cold.getSnapshot().source).toBeNull();
    cold.dispose();
  });

  it('retires an unattempted trip after a full document departure to another conversation', () => {
    const { source } = enter();
    bridge.dispose();
    const cold = new SettingsReadingBridge(push);
    cold.setRoute('/thread/other', true);
    expect(readSettingsReadingSession()).toBeNull();
    expect(readChatReadingRef(source.readingRef)).toBeUndefined();
    cold.dispose();
  });

  it('retains an attempted, rejected trip across departure and cold Settings for explicit retry', async () => {
    const { source } = enter();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await bridge.returnToSource(source.id);
    bridge.setRoute('/thread/other', true);
    const cold = new SettingsReadingBridge(push);
    cold.setRoute('/settings', true);
    expect(cold.getSnapshot().source?.id).toBe(source.id);
    expect(readChatReadingRef(source.readingRef)).toBeDefined();
    expect(push).not.toHaveBeenCalled();
    cold.dispose();
  });

  it('a second tab cannot replace, cancel or consume the first tab association', async () => {
    const first = new SettingsReadingBridge(push, 'tab-a');
    first.setRoute('/thread/origin', true);
    first.registerReadingPort(reader(), () => 'Origin A');
    first.captureBeforeSettings();
    first.setRoute('/settings', true);
    const source = first.getSnapshot().source;
    if (!source) throw new Error('tab A did not capture');
    const pending = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    const returning = first.returnToSource(source.id);
    const second = new SettingsReadingBridge(vi.fn(), 'tab-b');
    second.setRoute('/settings', true);
    expect(second.getSnapshot().source).toBeNull();
    second.setRoute('/thread/other', true);
    second.registerReadingPort(reader('other-owner', 'other'), () => 'Origin B');
    second.captureBeforeSettings();
    second.setRoute('/settings', true);
    first.storageChanged();
    expect(first.getSnapshot().source?.id).toBe(source.id);
    expect(first.getSnapshot().returning).toBe(true);
    expect(readChatReadingRef(source.readingRef)).toBeDefined();
    pending.resolve(admitted());
    await returning;
    expect(push).toHaveBeenCalledWith('/thread/origin');
    first.dispose();
    second.dispose();
  });

  it('rehydrates the saved Settings origin after the initial classic hydration snapshot becomes v2', () => {
    const { source } = enter();
    const cold = new SettingsReadingBridge(push);
    try {
      cold.setRoute('/settings', false);
      expect(cold.getSnapshot().source).toBeNull();
      cold.setRoute('/settings', true);
      expect(cold.getSnapshot().source).toEqual(source);
      expect(readSettingsReadingSession()).toEqual(source);
    } finally {
      cold.dispose();
    }
  });

  it('does not reuse a retryable A source when a later B entry cannot capture its reader', async () => {
    const { source } = enter();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await bridge.returnToSource(source.id);
    bridge.setRoute('/thread/other', true);
    bridge.captureBeforeSettings();
    bridge.setRoute('/settings', true);
    expect(bridge.getSnapshot().source).toBeNull();
    expect(readSettingsReadingSession()).toBeNull();
    expect(readChatReadingRef(source.readingRef)).toBeUndefined();
  });

  it('does not capture an unknown title, a different thread, a global route or classic', () => {
    const old = reader();
    bridge.registerReadingPort(old, () => '   ');
    bridge.captureBeforeSettings();
    bridge.registerReadingPort(reader('other', 'other'), () => 'Other title');
    bridge.captureBeforeSettings();
    bridge.setRoute('/memory', true);
    bridge.registerReadingPort(old, () => 'Origin');
    bridge.captureBeforeSettings();
    bridge.setRoute('/thread/origin', false);
    bridge.registerReadingPort(old, () => 'Origin');
    bridge.captureBeforeSettings();
    expect(old.captureReadingRef).not.toHaveBeenCalled();
    expect(bridge.getSnapshot().source).toBeNull();
  });

  it('admits the source freshly and waits for its new port, never calling the unmounted owner', async () => {
    const { old, source } = enter();
    await bridge.returnToSource(source.id);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/evidence/navigation-source?threadId=origin',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(push).toHaveBeenCalledWith('/thread/origin');
    expect(old.restoreReadingRef).not.toHaveBeenCalled();
    bridge.setRoute('/thread/origin', true);
    const next = reader('remounted');
    bridge.registerReadingPort(next, () => 'Actual origin title');
    await tick();
    expect(next.restoreReadingRef).toHaveBeenCalledWith(source.readingRef, expect.any(AbortSignal), { refresh: true });
    expect(bridge.getSnapshot().source).toBeNull();
    expect(readChatReadingRef(source.readingRef)).toBeUndefined();
  });

  it('keeps the source and stays in Settings when admission is revoked', async () => {
    const { old, source } = enter();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await bridge.returnToSource(source.id);
    expect(push).not.toHaveBeenCalled();
    expect(old.restoreReadingRef).not.toHaveBeenCalled();
    expect(bridge.getSnapshot().source?.id).toBe(source.id);
    expect(bridge.getSnapshot().notice).toBe('unavailable');
  });

  it('cannot route after a user leaves Settings during admission', async () => {
    const { source } = enter();
    const pending = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    const returning = bridge.returnToSource(source.id);
    bridge.setRoute('/thread/other', true);
    pending.resolve(admitted());
    await returning;
    expect(push).not.toHaveBeenCalled();
    expect(bridge.getSnapshot().returning).toBe(false);
  });

  it('does not let an old return or completion consume a newly captured source', async () => {
    const { source } = enter();
    await bridge.returnToSource(source.id);
    bridge.setRoute('/thread/origin', true);
    const pending = deferred<Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>>();
    const next = reader('remounted');
    vi.mocked(next.restoreReadingRef).mockReturnValueOnce(pending.promise);
    bridge.registerReadingPort(next, () => 'Actual origin title');
    bridge.captureBeforeSettings();
    const fresh = bridge.getSnapshot().source;
    if (!fresh) throw new Error('replacement source capture failed');
    pending.resolve({
      status: 'settled',
      exact: true,
      position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'origin-message', viewportOffsetPx: 42 } },
    });
    await tick();
    await bridge.returnToSource(source.id);
    expect(fresh.id).not.toBe(source.id);
    expect(bridge.getSnapshot().source?.id).toBe(fresh.id);
    expect(readSettingsReadingSession()?.id).toBe(fresh.id);
  });

  it('cancels an in-flight restore when its port unmounts and retains a retryable reference', async () => {
    const { source } = enter();
    await bridge.returnToSource(source.id);
    bridge.setRoute('/thread/origin', true);
    const pending = deferred<Awaited<ReturnType<ChatReadingPort['restoreReadingRef']>>>();
    const next = reader('remounted');
    vi.mocked(next.restoreReadingRef).mockReturnValueOnce(pending.promise);
    const unmount = bridge.registerReadingPort(next, () => 'Actual origin title');
    unmount();
    pending.resolve({
      status: 'settled',
      exact: true,
      position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'origin-message', viewportOffsetPx: 42 } },
    });
    await tick();
    expect(bridge.getSnapshot().source?.id).toBe(source.id);
    expect(readChatReadingRef(source.readingRef)).toBeDefined();
    expect(bridge.getSnapshot().notice).toBe('interrupted');
  });

  it('restores only after exact success and reports non-exact restoration as unavailable', async () => {
    const { source } = enter();
    await bridge.returnToSource(source.id);
    bridge.setRoute('/thread/origin', true);
    const next = reader('remounted');
    vi.mocked(next.restoreReadingRef).mockResolvedValueOnce({
      status: 'settled',
      exact: false,
      position: { top: 10, anchor: 'offset' },
    });
    bridge.registerReadingPort(next, () => 'Actual origin title');
    await tick();
    expect(bridge.getSnapshot().source?.id).toBe(source.id);
    expect(bridge.getSnapshot().notice).toBe('unavailable');
  });

  it('rehydrates the association for explicit return, without navigating on a cold Settings load', () => {
    const { source } = enter();
    const cold = new SettingsReadingBridge(push);
    cold.setRoute('/settings', true);
    expect(cold.getSnapshot().source?.id).toBe(source.id);
    expect(push).not.toHaveBeenCalled();
    cold.dispose();
  });

  it('does not duplicate admission while a return is already pending', async () => {
    const { source } = enter();
    const pending = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    const first = bridge.returnToSource(source.id);
    await bridge.returnToSource(source.id);
    expect(apiFetch).toHaveBeenCalledOnce();
    pending.resolve(admitted());
    await first;
    expect(push).toHaveBeenCalledOnce();
  });

  it('reports an unsaved owner checkpoint and keeps it usable in this mounted navigation', () => {
    const previousRef = captureChatReadingRef({
      threadId: 'previous',
      position: { top: 12, anchor: 'offset', messageAnchor: { messageId: 'previous-message', viewportOffsetPx: 42 } },
    });
    if (!previousRef) throw new Error('previous source fixture did not capture');
    const previous = startSettingsReadingSession({
      threadId: 'previous',
      label: 'Previous',
      readingRef: previousRef.ref,
    });
    const old = reader();
    const capture = old.captureReadingRef;
    vi.mocked(old.captureReadingRef).mockImplementation(() => {
      const point = captureChatReadingRef({
        threadId: 'origin',
        position: { top: 320, anchor: 'offset', messageAnchor: { messageId: 'origin-message', viewportOffsetPx: 42 } },
      });
      return point ? { ...point, persisted: false } : null;
    });
    bridge.registerReadingPort(old, () => 'Actual origin title');
    bridge.captureBeforeSettings();
    expect(capture).toHaveBeenCalledOnce();
    expect(bridge.getSnapshot().source?.threadId).toBe('origin');
    expect(bridge.getSnapshot().persisted).toBe(false);
    expect(bridge.getSnapshot().notice).toBe('not-saved');
    expect(readSettingsReadingSession()?.id).toBe(previous.session.id);
  });

  it('does not start admission when the durable explicit-attempt marker cannot be written', async () => {
    const { source } = enter();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    await bridge.returnToSource(source.id);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(bridge.getSnapshot().notice).toBe('save-failed');
    expect(readSettingsReadingSession()?.id).toBe(source.id);
  });

  it('does not claim a completed clear when metadata removal fails', async () => {
    const { source } = enter();
    await bridge.returnToSource(source.id);
    bridge.setRoute('/thread/origin', true);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    bridge.registerReadingPort(reader('remounted'), () => 'Actual origin title');
    await tick();
    expect(bridge.getSnapshot().source?.id).toBe(source.id);
    expect(bridge.getSnapshot().notice).toBe('clear-failed');
    expect(readSettingsReadingSession()?.id).toBe(source.id);
  });

  it('a same-scope storage replacement cancels a stale admission and rereads that scope association', async () => {
    const { source } = enter();
    const pending = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    const returning = bridge.returnToSource(source.id);
    const ref = captureChatReadingRef({
      threadId: 'other',
      position: { top: 20, anchor: 'offset', messageAnchor: { messageId: 'other-message', viewportOffsetPx: 42 } },
    });
    if (!ref) throw new Error('other source fixture did not capture');
    const newer = startSettingsReadingSession({ threadId: 'other', label: 'Other', readingRef: ref.ref });
    bridge.storageChanged();
    pending.resolve(admitted());
    await returning;
    expect(push).not.toHaveBeenCalled();
    expect(bridge.getSnapshot().source?.id).toBe(newer.session.id);
  });
});
