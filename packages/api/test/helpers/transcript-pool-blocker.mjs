export function held({ flag }) {
  const state = new Int32Array(flag);
  Atomics.store(state, 0, 1);
  Atomics.wait(state, 1, 0, 30000);
}
