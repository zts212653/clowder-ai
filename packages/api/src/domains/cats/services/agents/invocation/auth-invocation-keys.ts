/** Callback-auth owner key layout, shared by its backend and read-only commit fences. */
export const AuthInvocationKeys = {
  record: (id: string) => `auth:inv:${id}`,
  latest: (threadId: string, catId: string, purpose?: 'watcher') =>
    `auth:latest:${threadId}:${catId}${purpose ? ':role:watcher' : ''}`,
} as const;

export function authInvocationPurpose(record: { toolExecutionPolicy?: { mode: string } }): 'watcher' | undefined {
  return record.toolExecutionPolicy?.mode === 'watcher' ? 'watcher' : undefined;
}
