type ComposerDraftSave = () => Promise<boolean>;

const saveTails = new Map<string, Promise<boolean>>();

export function enqueueComposerDraftSave(threadId: string, save: ComposerDraftSave): Promise<boolean> {
  const previous = saveTails.get(threadId) ?? Promise.resolve(true);
  const next = previous.catch(() => false).then(save);
  saveTails.set(threadId, next);
  const release = () => {
    if (saveTails.get(threadId) === next) saveTails.delete(threadId);
  };
  void next.then(release, release);
  return next;
}

export async function waitForComposerDraftSaves(threadId: string): Promise<void> {
  await saveTails.get(threadId)?.catch(() => false);
}
