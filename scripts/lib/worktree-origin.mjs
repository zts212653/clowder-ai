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

function managedOrigin(env) {
  if (env.CAT_CAFE_WORKTREE_ORIGIN === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(env.CAT_CAFE_WORKTREE_ORIGIN);
  } catch {
    throw new Error('invalid worktree origin metadata');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid worktree origin metadata');
  const origin = { threadId: value.threadId, sourceRef: value.sourceRef, userId: value.userId, role: 'author' };
  validateOrigin(origin);
  return origin;
}

export function originFromEnvironment(env, options = {}) {
  const direct = {
    threadId: options.threadId ?? env.CAT_CAFE_THREAD_ID,
    sourceRef:
      options.sourceRef ?? (env.CAT_CAFE_INVOCATION_ID ? `invocation:${env.CAT_CAFE_INVOCATION_ID}` : undefined),
    userId: options.userId ?? env.CAT_CAFE_USER_ID,
  };
  const source = Object.values(direct).some((value) => value !== undefined) ? direct : managedOrigin(env);
  const { threadId, sourceRef, userId } = source ?? {};
  if (!threadId && !sourceRef) return undefined;
  const origin = {
    threadId,
    sourceRef,
    role: options.role ?? 'author',
    ...(userId ? { userId } : {}),
  };
  validateOrigin(origin);
  return origin;
}
