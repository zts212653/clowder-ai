# F308 Public CI Under 10 Minutes — Resource-Scope Plan

**Feature:** F308 — `docs/features/F308-full-sync-durable-fast-train.md`
**Goal:** Reduce the target-CI public-test lane/job critical path below 10 minutes without reducing coverage, increasing in-process test concurrency, or assuming that every stateful test shares one global resource.
**Acceptance:** All selected files execute exactly once. A test enters the one global serial lane only through explicit evidence that it uses a cross-VM remote endpoint, shared account, or shared quota. Every other file enters one count-balanced pool across six isolated VMs, one fresh process and one file at a time per VM. Target-CI distributable lanes execute in a Linux network namespace whose only enabled interface is loopback, so unknown Node/native/shell IP-egress paths fail at the kernel boundary. The bounded preload guard additionally rejects its recognized non-loopback surfaces before I/O, including Bash `/dev/tcp` and `/dev/udp` redirections. Local command doubles require an explicit exact executable declaration under the temporary directory. A measured critical path over 600,000 ms fails CI. AC-D6 remains open until three same-selection target artifacts establish p50/p95.

## Evidence and boundary

The accepted single-serial topology selects 2,176 files: 1,648 serial and 528 pure. Post-merge run `35342249618` measured a 25m42.409s serial critical path and a 27m41s serial job.

The previous source audit placed 95 files in a shared lane merely because their source mentioned network or command tokens. Direct inspection found that 63 of those files did not even reference an external host: examples included loopback HTTP servers, mocked `fetch` methods, local filesystem Git remotes, and command strings used as test data. The same audit also separated 1,562 runner-local files from 519 pure files even though the runner executes both groups identically: one fresh Node process per file, sequentially inside each VM.

The revised boundary is behavioral instead of lexical. The shared lane is an explicit registry of proved cross-VM resources; it is empty for the current suite. Each distributable target-CI command runs below a kernel network boundary: a new Linux network namespace enables loopback for local test servers but has no external interface or route, then drops back to the unprivileged runner identity before starting the tests. This covers unknown Node/native/shell IP-egress APIs without guessing source tokens. The bounded preload guard remains defense in depth and gives an earlier typed failure for recognized `fetch`, WebSocket, HTTP(S), TCP/TLS, command, and child-process paths; it also rejects non-loopback or dynamic Bash `/dev/tcp` and `/dev/udp` targets before spawn. A network-command-named test double is allowed only when the test explicitly declares the exact executable and it resolves beneath the system temporary directory. Public shard jobs additionally receive no service credentials, use read-only repository permission, do not persist checkout credentials, and restrict Git transports to local files.

This plan therefore does not claim that all tests are pure. It distinguishes two actual execution scopes:

- `serial-shared`: only files with explicit evidence for a real cross-VM endpoint/account/quota. One global lane.
- `distributable-1…6`: every other file. Separate GitHub VMs provide process/machine isolation; a loopback-only Linux network namespace makes undeclared cross-VM IP use fail closed regardless of API, while the preload guard supplies earlier diagnostics for recognized paths.

Current CI does not consume a timing artifact: it deterministically balances by file count so selection changes cannot invalidate the plan. Exact target run `35439924398` measured a 319.657s nine-lane test critical path over 2,189 files. Replaying those same per-file timings through the current count balancer yields 396.477s with six distributable lanes; adding the run's observed 122.343s slowest-job setup/build overhead projects 518.820s (8m38.820s). This reconciles the implementation with F308's 4–6 distributable-shard boundary while retaining target headroom. It remains a projection until the six-lane target workflow runs, and neither it nor a single target run completes AC-D6.

## Machine contract

The schema-v2 plan contains:

```js
{
  sharedSerialLane: { id: 'serial-shared', files: [...] },
  distributableShards: [
    { id: 'distributable-1', files: [...] },
    // distributable-2 ... distributable-6
  ]
}
```

Required invariants:

1. selected = assigned = observed = unique, with no missing, duplicate, extra, or failed files;
2. every `serial-shared` assignment carries explicit shared-resource evidence for an endpoint/account/quota;
3. every `distributable-*` assignment carries loopback-only kernel-network plus runtime-guard isolation evidence;
4. a forged shared → distributable assignment is rejected by plan validation;
5. every lane runs files sequentially with `--test-concurrency=1`;
6. distributable shard commands enter a new Linux network namespace, enable only loopback, and drop root before executing tests;
7. shard jobs have `contents: read`, `persist-credentials: false`, and no external-service credentials;
8. summary aggregation requires all seven reports and rejects critical path above 600,000 ms.

## TDD and verification

1. Unit tests lock explicit shared-resource evidence → shared, all other files → one six-shard pool, and reject a forged shared → distributable assignment.
2. Guard tests prove loopback/local Git remain usable while a real non-loopback fetch, `gh`, `ssh`, remote `curl`, or Bash pseudo-device target fails before I/O, and mandatory guard state survives child-process environment replacement and options-only overloads.
3. Runner and summary tests lock all seven lanes, schema-v2 reports, exact coverage, provenance, and fail-closed timing.
4. The workflow contract checker locks the lane matrix, loopback-only network namespace with privilege drop, read-only/no-persisted-credentials boundary, exact execution environment, and 10-minute gate.
5. Generate the real plan and verify every assignment exactly once plus the shared-resource evidence boundary.
6. Build as CI and run all seven lanes locally in the feature worktree with runtime Redis absent.
7. Aggregate the reports locally, then run `pnpm check`.
8. Obtain non-author exact-HEAD review before updating the Draft PR; use target CI as the Linux timing authority. Do not merge; maintainer owns merge.

## Not in scope

- raising the 30-minute timeout;
- reducing test selection or deleting assertions;
- global Node test concurrency;
- claiming three-run p50/p95 from one sample;
- bypassing the distributable kernel-network boundary or runtime external-resource guard, or moving explicitly registered shared resources into distributable shards;
- merging same-title tests without proof that inputs, branches, side effects, and assertions are equivalent.
