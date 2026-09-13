/**
 * A ref-keyed store: an object whose KEYS are persisted data — account refs and
 * credential refs read out of JSON — not identifiers this codebase chose.
 *
 * R19 P1. A plain `{}` gives those data keys the whole Object.prototype for
 * free, and every ordinary way of using a record then means something else:
 *
 *   `ref in store`      → true for toString, constructor, valueOf, __proto__,
 *                         hasOwnProperty … on a store that has never held them.
 *                         The runtime→workspace migration read that as "already
 *                         present", skipped the entry, and still wrote the
 *                         completion marker — a persisted account silently
 *                         dropped, with durable evidence saying the migration
 *                         was complete, so the preflight never runs again.
 *   `store[ref]`        → returns an inherited function instead of undefined.
 *   `store[ref] = v`    → for `__proto__` this invokes the prototype SETTER, so
 *                         the value is swallowed and the key never appears in
 *                         the file that gets written.
 *
 * A null prototype removes the shadow those three cast, at the point the
 * container is created rather than at each of the thirteen places that use one.
 * That ordering matters: guarding the use sites is a list somebody has to keep
 * complete forever, and the fourteenth site is written by whoever adds the next
 * feature. There is no key JSON can hold that a null-prototype object inherits.
 *
 * Note that plain assignment IS safe here, and that is a property of the
 * container, not of the syntax: `Object.create(null)` has no `__proto__`
 * accessor to trigger, so `store['__proto__'] = v` creates an ordinary own
 * property. JSON.stringify, Object.entries/keys/values, `in` and `delete` all
 * behave normally — only inheritance is gone.
 *
 * The one thing that silently undoes it is `{ ...store }`, which returns a
 * normal object. Copy with refStore(store) instead.
 */
export function refStore<T>(source?: Record<string, T> | null): Record<string, T> {
  const store = Object.create(null) as Record<string, T>;
  if (source) {
    // Object.assign uses [[Set]]; a source own-key "__proto__" would be swallowed
    // even on a null-prototype target. defineProperty keeps ref keys as data.
    for (const key of Object.keys(source)) {
      Object.defineProperty(store, key, {
        value: source[key as keyof typeof source],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return store;
}
