export function reserve(store, key, amount, limit) {
  return store.withLock(key, async () => {
    const used = await store.get(key);
    if (used + amount > limit) return false;
    await store.set(key, used + amount);
    return true;
  });
}
