export function busy(input: { milliseconds: number; id?: string; startedFlag?: SharedArrayBuffer }) {
  const started = Date.now();
  if (input.startedFlag) Atomics.store(new Int32Array(input.startedFlag), 0, 1);
  while (Date.now() - started < input.milliseconds) {
    /* intentional isolated CPU load */
  }
  return { started, ended: Date.now(), id: input.id };
}
export function fail() {
  throw new Error('fixture failure');
}

/** A deterministic pool blocker, released by this test's parent, never by elapsed host time. */
export function held(input: { flag: SharedArrayBuffer }) {
  const flag = new Int32Array(input.flag);
  Atomics.store(flag, 0, 1);
  Atomics.wait(flag, 1, 0, 10_000);
  return { ended: Date.now() };
}
