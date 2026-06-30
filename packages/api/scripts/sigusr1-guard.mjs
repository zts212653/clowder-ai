// SIGUSR1 inspector guard — loaded via NODE_OPTIONS=--import in the `dev` script
// so EVERY Node process in the `tsx watch` tree installs this listener: both the
// watcher PARENT process and the spawned app CHILD process. Installing any
// SIGUSR1 listener overrides Node's default "open the V8 inspector on SIGUSR1"
// behavior, which on Node 24 + tsx can crash a process with
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING on debugger attach/detach (the crash
// that took 3002 down with ELIFECYCLE exit 1).
//
// The built/prod runtime (`pnpm start` -> `node dist/index.js`, a single process
// with no NODE_OPTIONS wrapper) is covered separately by the equivalent guard in
// src/index.ts. This module covers the dev/watch path that guard cannot reach.
//
// Review provenance: codex (砚砚) blocking finding on 0bd7698bf — the src/index.ts
// guard only runs in the app child, never in the `tsx watch` parent; signalling
// the parent still opened 9229. NODE_OPTIONS propagates the guard to both.
process.on('SIGUSR1', () => {
  console.warn('[api] Ignoring SIGUSR1 — inspector auto-open suppressed (NODE_OPTIONS guard)');
});
