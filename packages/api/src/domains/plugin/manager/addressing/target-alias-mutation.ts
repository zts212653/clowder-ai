import { AsyncLocalStorage } from 'node:async_hooks';

// Member configuration and plugin inventory have different persistence owners.
// Serialize only their alias mutations in this Host; neither store is duplicated.
const context = new AsyncLocalStorage<{ active: boolean }>();
let tail: Promise<void> = Promise.resolve();

export async function withTargetAliasMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (context.getStore()?.active) return operation();
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const scope = { active: true };
  try {
    return await context.run(scope, operation);
  } finally {
    scope.active = false;
    release();
  }
}
