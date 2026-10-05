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
