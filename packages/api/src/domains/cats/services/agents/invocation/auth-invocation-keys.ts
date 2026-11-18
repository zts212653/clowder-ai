/** Callback-auth owner key layout, shared by its backend and read-only commit fences. */
export const AuthInvocationKeys = {
  record: (id: string) => `auth:inv:${id}`,
  latest: (threadId: string, catId: string, purpose?: AuthInvocationPurpose) =>
    `auth:latest:${threadId}:${catId}${purpose ? `:role:${purpose === 'watcher' ? 'watcher' : 'watcher-panel'}` : ''}`,
} as const;

/** Observer roles hold their own latest slot, so a watcher run and the cat's ordinary turn never replace each other. */
export type AuthInvocationPurpose = 'watcher' | 'watcher_panel';

export function authInvocationPurpose(record: {
  toolExecutionPolicy?: { mode: string };
}): AuthInvocationPurpose | undefined {
  const mode = record.toolExecutionPolicy?.mode;
  return mode === 'watcher' || mode === 'watcher_panel' ? mode : undefined;
}
