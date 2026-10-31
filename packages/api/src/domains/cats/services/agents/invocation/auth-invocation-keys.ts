/** Callback-auth owner key layout, shared by its backend and read-only commit fences. */
export const AuthInvocationKeys = {
  record: (id: string) => `auth:inv:${id}`,
  latest: (threadId: string, catId: string) => `auth:latest:${threadId}:${catId}`,
} as const;
