import { describe, expect, it, vi } from 'vitest';
import {
  createFirstMessageAdmissionController,
  type FirstMessageAdmissionDependencies,
  type FirstMessageAdmissionPhase,
  type PendingNewConversationIntent,
} from '../first-message-admission';

function intent(overrides: Partial<PendingNewConversationIntent> = {}): PendingNewConversationIntent {
  return {
    v: 1,
    createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
    messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
    projectPath: '/work/cafe',
    preferredCats: ['codex-sol'],
    creationStarted: false,
    ...overrides,
  };
}

function harness(seed = intent()) {
  let current = seed;
  const phases: FirstMessageAdmissionPhase[] = [];
  const createThread = vi.fn<FirstMessageAdmissionDependencies['createThread']>(async () => ({ id: 'thread-created' }));
  const sendMessage = vi.fn<FirstMessageAdmissionDependencies['sendMessage']>(async () => true);
  const persistIntent = vi.fn(async (next: PendingNewConversationIntent) => {
    current = next;
  });
  const complete = vi.fn(async () => undefined);
  const navigate = vi.fn();
  const controller = createFirstMessageAdmissionController({
    readIntent: () => current,
    persistIntent,
    createThread,
    sendMessage,
    complete,
    navigate,
    onPhaseChange: (phase) => phases.push(phase),
  });
  return {
    controller,
    createThread,
    sendMessage,
    persistIntent,
    complete,
    navigate,
    phases,
    current: () => current,
  };
}

describe('F322 new-conversation first-message admission', () => {
  it('serializes a double submit into one create and one first message', async () => {
    const h = harness();
    let releaseCreate: ((value: { id: string }) => void) | undefined;
    h.createThread.mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => (releaseCreate = resolve)));

    const first = h.controller.send({ content: '第一句' });
    const second = h.controller.send({ content: '第一句' });
    await Promise.resolve();
    expect(h.createThread).toHaveBeenCalledOnce();
    releaseCreate?.({ id: 'thread-created' });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(h.createThread).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledWith(
      { content: '第一句' },
      'thread-created',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.navigate).toHaveBeenCalledOnce();
  });

  it('persists a known create result before sending and reuses it after send failure', async () => {
    const h = harness();
    h.sendMessage.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(h.controller.send({ content: '保留我' })).resolves.toBe(false);
    expect(h.current()).toMatchObject({ creationStarted: true, createdThreadId: 'thread-created' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();

    await expect(h.controller.send({ content: '保留我' })).resolves.toBe(true);
    expect(h.createThread).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('persists an accepted message before cleanup and resumes cleanup without resending', async () => {
    const h = harness();
    h.complete.mockRejectedValueOnce(new Error('indexeddb unavailable'));

    await expect(h.controller.send({ content: '只发送一次' })).resolves.toBe(true);
    expect(h.current()).toMatchObject({
      createdThreadId: 'thread-created',
      messageAccepted: true,
    });
    expect(h.sendMessage).toHaveBeenCalledOnce();

    const resumed = createFirstMessageAdmissionController({
      readIntent: h.current,
      persistIntent: h.persistIntent,
      createThread: h.createThread,
      sendMessage: h.sendMessage,
      complete: h.complete,
      navigate: h.navigate,
      onPhaseChange: (phase) => h.phases.push(phase),
    });
    await expect(resumed.send({ content: '不会再次发送' })).resolves.toBe(true);

    expect(h.createThread).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.navigate).toHaveBeenCalledTimes(2);
  });

  it('keeps the same create key after an ambiguous create failure so server replay can reconcile', async () => {
    const h = harness();
    h.createThread.mockRejectedValueOnce(new TypeError('network lost')).mockResolvedValueOnce({ id: 'same-thread' });

    await expect(h.controller.send({ content: '别重复建对话' })).resolves.toBe(false);
    expect(h.current()).toMatchObject({
      creationStarted: true,
      createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
    });

    await expect(h.controller.send({ content: '别重复建对话' })).resolves.toBe(true);
    expect(h.createThread).toHaveBeenCalledTimes(2);
    expect(h.createThread.mock.calls.map((call) => call[0].createIdempotencyKey)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(h.sendMessage).toHaveBeenCalledWith(expect.anything(), 'same-thread', expect.any(String));
  });

  it('unlocks project and cat choices after a definitive pre-create rejection', async () => {
    const h = harness();
    h.createThread.mockRejectedValueOnce(Object.assign(new Error('project path rejected'), { optionsMayChange: true }));

    await expect(h.controller.send({ content: '换个项目再试' })).resolves.toBe(false);

    expect(h.current()).toMatchObject({ creationStarted: false });
    expect(h.current().createdThreadId).toBeUndefined();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.phases).toEqual(['creating', 'create_rejected']);
  });

  it('reports truthful create and send phases without completing a failed admission', async () => {
    const createFailure = harness();
    createFailure.createThread.mockRejectedValueOnce(new Error('offline'));
    await expect(createFailure.controller.send({ content: 'a' })).resolves.toBe(false);
    expect(createFailure.phases).toEqual(['creating', 'create_failed']);

    const sendFailure = harness(intent({ createdThreadId: 'existing', creationStarted: true }));
    sendFailure.sendMessage.mockResolvedValueOnce(false);
    await expect(sendFailure.controller.send({ content: 'b' })).resolves.toBe(false);
    expect(sendFailure.phases).toEqual(['sending', 'send_failed']);
    expect(sendFailure.complete).not.toHaveBeenCalled();
  });
});
