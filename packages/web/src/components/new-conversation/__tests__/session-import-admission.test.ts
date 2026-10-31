import { expect, it, vi } from 'vitest';
import { createFirstMessageAdmissionController, type PendingNewConversationIntent } from '../first-message-admission';
import { createSessionImportAdmissionController } from '../session-import-admission';

const selection = {
  sessionId: 'native-id',
  catId: 'codex61-sol',
  projectPath: '/original',
  firstPrompt: 'fix imports',
};
function harness() {
  let current: PendingNewConversationIntent = {
    v: 1,
    createIdempotencyKey: 'stable-create',
    messageIdempotencyKey: 'stable-message',
    preferredCats: [],
    creationStarted: false,
    pinned: true,
  };
  const deps = {
    readIntent: () => current,
    persistIntent: vi.fn(async (v: PendingNewConversationIntent) => {
      current = v;
    }),
    createThread: vi.fn(async () => ({ id: 'created' })),
    bind: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    navigate: vi.fn(),
  };
  return { deps, read: () => current };
}
it('bind failure can resume after refresh with one thread and preserves the selected project, cat and pin', async () => {
  const h = harness();
  h.deps.bind.mockRejectedValueOnce(new Error('network'));
  await expect(createSessionImportAdmissionController(h.deps).importSession(selection)).rejects.toThrow('network');
  expect(h.read().createdThreadId).toBe('created');
  await createSessionImportAdmissionController(h.deps).importSession(selection);
  expect(h.deps.createThread).toHaveBeenCalledTimes(1);
  expect(h.read()).toMatchObject({
    projectPath: '/original',
    preferredCats: ['codex61-sol'],
    pinned: true,
    importAccepted: true,
  });
  expect(h.deps.navigate).toHaveBeenCalledWith('created');
});
it('cannot send a first message into a pending import before the binding completes', async () => {
  const h = harness();
  await h.deps.persistIntent({
    ...h.read(),
    sessionImport: selection,
    creationStarted: true,
    createdThreadId: 'created',
  });
  const sendMessage = vi.fn(async () => true);
  const normal = createFirstMessageAdmissionController({ ...h.deps, sendMessage });
  expect(await normal.send({ content: 'draft stays here' })).toBe(false);
  expect(sendMessage).not.toHaveBeenCalled();
});

it('failed binding leaves a visible failure phase and can release the pending intent without deleting the created conversation', async () => {
  const h = harness();
  const phases: string[] = [];
  const resetIntent = vi.fn(async () => {
    await h.deps.persistIntent({
      ...h.read(),
      creationStarted: false,
      createdThreadId: undefined,
      sessionImport: undefined,
    });
  });
  h.deps.bind.mockRejectedValue(new Error('locked'));
  const controller = createSessionImportAdmissionController({
    ...h.deps,
    onPhaseChange: (p) => phases.push(p),
    resetIntent,
  });
  await expect(controller.importSession(selection)).rejects.toThrow('locked');
  expect(phases.at(-1)).toBe('import_failed');
  await controller.cancel();
  expect(resetIntent).toHaveBeenCalledOnce();
  expect(h.deps.navigate).not.toHaveBeenCalled();
});
