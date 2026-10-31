# MCP servers exit silently through the desktop workspace junction

The operator reported that `cat_cafe_get_thread_context` was unavailable even after restart.
All six managed MCP capabilities were already enabled, their files existed, and the Codex
launch configuration included them. The missing tools were not an enablement-setting issue.

Launching the installed servers through the desktop workspace's `packages` junction exited
with code 0 before an MCP handshake. Launching the same six files by physical installation
path successfully listed 135 tools, including `cat_cafe_get_thread_context`.

Node canonicalizes the main module URL but leaves the launch alias in `process.argv[1]`.
Each entrypoint compared resolved path strings and incorrectly treated the junction launch
as an ordinary import. Windows casing differences were another instance of the same bug.

Nine MCP entrypoints now share a native-realpath execution guard. The six managed stdio
families, legacy entrypoint and protocol/remote entrypoints retain their existing startup,
registration and authentication behavior. Missing paths and ordinary imports remain inert.
`realpathSync.native` is intentional: on Windows, the non-native implementation can retain
the input path's casing and still fail an identity comparison.

Validation:

- Six regression tests cover physical launch, a real junction/symlink child-process launch,
  ordinary imports, missing/unrelated paths, Windows casing and all nine entrypoint wirings.
- Red: junction launch returned `IMPORTED`, and casing identity failed. Green: 6/6 pass.
- Six real MCP `initialize` / `tools/list` handshakes through an isolated junction pass after
  applying only the guard change to copies of the installed artifacts: 86 collab, 22 memory,
  12 signals, 6 limb, 8 audio and 1 finance tool.
- Targeted strict TypeScript and Biome checks pass. Independent review approved and separately
  reran the six regression tests. No production session or database is used by the probes.

The repair does not change MCP capability settings, credential handling or tool allowlists.
The current CLI invocation's tool inventory cannot be replaced in place; subsequent managed
invocations start the repaired MCP entrypoints.
