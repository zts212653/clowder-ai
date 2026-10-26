/** Provenance belongs to the worktree-local lifecycle, never a parallel owner registry. */
const text = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 2000 && !/[\r\n\0]/.test(value);
export function validateOrigin(origin) {
  if (origin === undefined) return;
  if (
    !origin ||
    !text(origin.threadId) ||
    origin.threadId.length > 200 ||
    !/^thread_[A-Za-z0-9_-]+$/.test(origin.threadId) ||
    !text(origin.sourceRef) ||
    !['author', 'review', 'alpha', 'scratch'].includes(origin.role) ||
    (origin.userId !== undefined && !text(origin.userId))
  )
    throw new Error('invalid worktree origin');
}
export function originFromEnvironment(env, options = {}) {
  const threadId = options.threadId ?? env.CAT_CAFE_THREAD_ID;
  const sourceRef =
    options.sourceRef ?? (env.CAT_CAFE_INVOCATION_ID ? `invocation:${env.CAT_CAFE_INVOCATION_ID}` : undefined);
  if (!threadId && !sourceRef) return undefined;
  const origin = {
    threadId,
    sourceRef,
    role: options.role ?? 'author',
    ...((options.userId ?? env.CAT_CAFE_USER_ID) ? { userId: options.userId ?? env.CAT_CAFE_USER_ID } : {}),
  };
  validateOrigin(origin);
  return origin;
}
