const saveTails = new Map<string, Promise<unknown>>();

export function enqueueComposerDraftSave<T>(threadId: string, save: () => Promise<T>): Promise<T> {
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
