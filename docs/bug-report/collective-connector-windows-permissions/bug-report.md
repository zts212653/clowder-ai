# Collective Connector cannot start on Windows

## What happened?

The installed `@cat-cafe/collective-connector` 0.1.0 enters activation `error` / runtime `stopped` when enabled or repaired on Windows. The Host inventory exposes `UNEXPECTED_RUNTIME_FAILURE`; opening the credential store directly identifies the cause before any Service request:

```text
Collective Connector data directory permissions must be private (mode 0700): <connector-data-directory>
```

## Steps to reproduce

Base: upstream `b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4`.

1. Use Windows and Node 24; install dependencies and build `@cat-cafe/shared`.
2. Create an isolated directory and set its Windows DACL to grant only the current user access, with inheritance disabled.
3. Call `ConnectorPersistence.open(directory)` from `packages/collective-connector/src/persistence.ts`, or enable the official Connector from Hub.
4. Observe rejection of directory permissions. Node reports mode `0666` for a normal Windows directory, including one protected with a private Windows ACL.

The added focused test can reproduce this directly:

```text
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/collective-connector exec vitest run src/__tests__/persistence.test.ts
Base RED: 3 failed, 2 passed. Both a newly created store and an existing private DACL directory fail at the POSIX directory-mode check.
```

## Expected behavior

The Host Connector starts with a genuinely private Windows credential store. Other users' access, reparse points and insecure state files must still be rejected. Repair does not start or take ownership of a remote Collective Service.

## Environment

- OS: Windows, native Node processes on NTFS
- Node: v24.18.0
- Connector: 0.1.0
- Browser: not needed to reproduce the persistence failure

## Mechanism and scope

`mkdir(..., { mode: 0700 })` and checking `stat.mode` do not implement Windows DACL privacy. The second native Windows blocker is the directory `open(..., 'r')` after rename: an isolated probe returns `EPERM`. File fsync and same-directory rename can still run.

Proposed fix: retain POSIX mode checks on Unix; use native Windows DACL creation/validation and reject reparse points on Windows; keep file fsync plus atomic rename and perform the parent-directory fsync only on platforms that support it. Existing permissive directories must not be silently rewritten or accepted.

Architecture cell: collective-runtime

Map delta: none

Why: ConnectorPersistence remains the sole owner of the Host's credential state; its native platform security checks and commit mechanism are corrected without moving ownership or changing the state schema.

Canonical source: `packages/collective-connector/src/persistence.ts#ConnectorPersistence`

Consumer evidence: `rg -n 'ConnectorPersistence|assertPrivateDirectory' packages/collective-connector/src packages/api/src/domains/plugin/builtin-runtime` identifies the Connector and its builtin Host runtime.

Claim guard: private Windows credentials remain private on create, transaction and reopen; adding public DACL access or substituting a directory link must reject without writing credentials.

Tips exemption: repairs an existing Connector lifecycle and adds no new user action or discovery surface.

## Primary references

- [Node filesystem permissions on Windows](https://nodejs.org/api/fs.html#fschmodpath-mode-callback)
- [Microsoft DirectorySecurity API](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity?view=netframework-4.8.1)

No runtime credentials or production state were changed during diagnosis.

## Fix and validation

Tracking issue: [#1555](https://github.com/zts212653/clowder-ai/issues/1555), accepted by the upstream maintainer.

The Windows helper uses the built-in Windows PowerShell executable and .NET Framework filesystem ACL APIs, launched with `windowsHide: true`, `-NoProfile` and `-NonInteractive`. Directory creation supplies a protected DACL at creation time. Validation permits the current process user, SYSTEM and built-in Administrators; it rejects other Allow grants, untrusted ownership, null DACLs, inherited directory security and leaf reparse points. Existing insecure ACLs are never rewritten. Paths are passed as environment data to fixed script source, not interpolated into shell code.

Windows commits still flush the credential file and atomically rename it within the private directory. The unsupported parent-directory open/fsync is omitted specifically on Windows; this does not claim the same parent-directory power-loss guarantee as Unix. ACL checks currently launch a native helper process per verification, which adds startup/commit latency. The path security boundary assumes trusted Host ancestors; it does not claim protection against malicious ancestor-directory replacement.

Validation performed in the feature worktree, not the live Host:

- Windows Node v24.18.0: `vitest run src/__tests__/persistence.test.ts` — 7/7 pass, covering create/transaction/reopen, existing private directory, broad directory/file grants, unchanged rejected ACL, directory junction rejection, privacy loss before transaction, and literal quoted/shell-shaped paths.
- Linux Node v24.18.0 in WSL, copied package source/build artifacts and isolated npm dependencies: complete Connector Vitest suite — 22/22 pass, including real isolated Service pairing, verified Agent/human messages, ACK, replay/restart, credential permissions and reply custody.
- Native Windows Host integration: `node --test packages/api/test/plugin-builtin-runtime-supervisor.test.js packages/api/test/plugin-collective-runtime-composition.test.js` — 3/3 pass, including actual builtin Connector lifecycle enable to `healthy` and disable to `stopped` with isolated Host state.
- Connector build and lint, API `tsc` / `tsc --noEmit`, targeted Biome and `git diff --check` pass.
- Independent fresh-context security review: no blocking P1/P2; the P3 request to compare the rejected directory ACL before/after has been implemented and exercised.

The upstream full API build command remains blocked on Windows by the pre-existing Collective Client `clean` command (`rm -rf dist`, unavailable in the default Windows script shell). Direct scoped TypeScript compilation and the above Host tests pass; this is not represented as a full API build or full public-suite pass.

The reported live directory was empty and permissive, so startup will still require owner-controlled ACL correction and activation of the reviewed repair in the live Host. Those production actions were not performed as part of feature-worktree validation.
