# Collective browser journey migration

Status: **migration pending; installed Collective package and full journeys have not been verified**.
Host test-lane cleanup is not a Collective migration acceptance result.

Ownership correction (2026-10-10): this inventory belongs exclusively to Collective W4,
not GitHub operations/Community W3. The GitHub package's 494 passing tests do not cover it.
Host handoff `thread_mu8dg6h7l2x4ohsk#0001791601831711-000145-8fd85acf`
incorrectly asked the GitHub W3 holder to consume these journeys; that instruction is withdrawn.

The old W4 placeholder task `0001791444719401-000215-c2f02070` was canceled before dispatch
or implementation. Its `done` status means superseded, not migrated, as explicitly recorded in
`thread_mrkn6povq4zzgh45#0001791444756075-000217-8e12d91a`.
No active Collective implementation owner was verified in the current F202 task query.
The package aggregate task `0001789822127811-001843-1c2133b0` remains owned by
`cat-eqdvbcxw` (Sol); ownership/scheduling belongs to that existing aggregate responsibility.
This inventory neither assigns new implementation work nor expands GitHub W3. Until an explicit
Collective handoff is accepted, these 21 files remain pending under the C1 migration chain.

Source correction (2026-10-10, aggregate260 → Host264): both business migration and browser
journeys use the preserved pre-deletion feature snapshot
`ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7`, not main. The previously recorded
`bb9f9f08ec574ee8888fbde9819ff95da96bb614` predates the three Collective packages,
introduced by `9f6ac206988f635feddd18d8b0ed517bb7ab2b1a`; it cannot supply this migration.
The existing 21 browser source blobs and pending status are unchanged. This corrects the source
coordinate under the existing aggregate; it does not assign an implementation writer or move C2. The adjacent JSON manifest records every movable
journey/fixture, its exact source blob and behavior. Retrieve a test with
`git show <browserSourceCommit>:<path>` from the Host repository, then move it into the Collective
plugin package test suite. Git preserves the source; no runtime or persistent data is changed.

These 14 full-stack journey entrypoints and seven dedicated fixtures directly compose the retired
Host Service/connector/routes or seed their private stores. They are removed from Host, not skipped
or replaced with success mocks. Thirteen were in `@cat-cafe/web test:browser`; the appearance
journey was a separate manual entrypoint. The plugin package must provide the runtime through
installation, then adapt test composition and HTTP edges:

- Install/start packaged Collective with isolated private storage and authentication.
- Exercise the preserved Client through generic Host plugin forwarding and package-owned endpoints;
  do not restore Host Collective routes or provision a Host-owned Service.
- Use SDK task/thread/message/send at the owner edge. Retain revocation, restart, replay, artifact,
  policy and multi-human authority assertions from the original journeys.
- Validate the Host launch surface and iframe appearance handshake against the installed package.

C2 production UI and Client code stay in Host. Pure Client conversation rendering coverage,
the frontend-only asset fixture, and shared Next/browser/default-entry harnesses are retained. They
do not prove the removed package integration journeys. No newly passing/skipped test count may be
used to claim those journeys are complete. Package migration, installed-package browser execution,
and operator acceptance remain outstanding.
