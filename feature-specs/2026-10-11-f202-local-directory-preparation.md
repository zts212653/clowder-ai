---
feature_ids: [F202]
doc_kind: plan
topics: [plugin-framework, local-directory, dependency-integrity]
architecture-cell: plugin
---

# C1 local source directory preparation

Original requirement: operator094/096 in thread_mu8dg6h7l2x4ohsk requests removal of plugin business from Host, independent plugin packages, and installation by selecting the actual plugin repository directory in a feature worktree. Authority remains the original C1 Host chain and [C1 contract](../docs/plans/2026-09-21-f202-c1-contract.md). This is an internal review checkpoint, not completion of any of those three whole-feature requirements.

Architecture cell: plugin. Map delta: extend existing local admission, archive staging and content-addressed package storage. Why: copying every node_modules member imported development dependencies, exceeded limits, and did not establish a reproducible runtime closure. No second dependency store, activation authority, plugin-specific route or public installation source type is added.

## Implemented boundary

- Preserve `{kind: "local-directory", path}` and existing immutable archive publication, locator, grant and inventory path.
- For package.json sources, inspect source-owned pnpm v9 importer/snapshots and actual dependency resolution before publication. Missing/unsupported lock or unsupported protocols fail explicitly. SemVer uses a direct locked semver 7.7.4 dependency with normal prerelease semantics.
- Every actual dependency node binds its declared importer or snapshot coordinate and physical root, then uses npm pack --ignore-scripts --offline publication semantics on private snapshots. Content provenance is owner-local regardless of registry-shaped lock metadata. No canonical cache is consulted and no network fallback or environment override is used. No source build/install scripts. No package ID special cases or deletion of declaration files to fit budgets.
- Preserve runtime versions, peers, cycles and optional absence during relocation. A source-absent optional dependency that would become visible from an installed ancestor is rejected rather than silently changing runtime semantics.
- Recheck source members, metadata, resolution and lock; bind topology and owner-local provenance in the immutable candidate receipt. Declared lock integrity and actual sealed content digest remain distinct. Final archive passes the shared budget/preflight; failures precede grant and inventory writes.
- Existing standalone local directories without package.json retain their existing bounded copy path.
- Consume the exact reviewed local contract beta.36 archive, update Manager capability enumeration for browser-service and use the existing shipped closure runtime path. This does not implement or activate browser-service.

## Evidence and risk

Latest exact product validation:
`/Users/lang/workspace/github-lab/f202-acceptance/collective-host-93fee434/directory-topology-green-r1/`.
Before/after product source digest: `34756f78e18cb6716462050bcb91af065eb7168c23b6bc9a06dec15b98f9bc14` (before this documentation/commit only).
API/shared build passed; registry/topology 11/11, source admission 6/6, affected admission/materializer/catalog 37/37, zero failures/skips/cancellations. Diff check passed. Prior observed topology RED was 10/11 with the exact missing optional-resolution rejection, while cycle and multiversion positives passed.

Dogfood: actual `clowder-ai-plugins-collective-sol/packages/collective-connector` through production LocalPluginPackageAdmission, seven exact original archives seeded into a batch-only cache, ten-node receipt (seven registry and three local), immutable archive integrity, and installed entrypoint passive import. All six checkpoints passed. Source reads, writes, child/worker creation denied in the passive child; zero network/listener attempts; create/start not called. Memory inventory observes disabled/stopped. This is real-source offline admission, not a real authenticated Manager/browser session.

The prior archive-preflight 21 cases and original archive census remain evidence for its unchanged parser; package-staging factoring is additionally covered by affected admission regressions and the actual directory probe. Beta.36's exact archive pin is sha256 `578d0a2fbdf3b308ad8b7b1b0f56be5ba2fd40593df0a71b67021cc6e7d0b186`; no registry substitute for the unpublished artifact.

Risk axes: behavior=dependency/member selection; data=immutable candidate and failure-before-inventory; security=hostile files/archives, lock/SRI/currentness, scripts and relocation; contract=existing source shape plus exact beta.36 consumption; irreversible=no release, merge, runtime or production-data mutation.

## Open C1 work, retained by original owners

Host owner retains current-policy durable authenticated Manager/browser directory validation, activation/browser-service/private connector/control wiring and full Host cleanup acceptance. Package owner retains mismatched pins, missing assets and plugin-specific migration gaps. Owner-local installation uses the existing physical runtime closure and does not require registry originals. Historical cache-seeded evidence below is not proof of that corrected no-cache path.

Independent review and mechanical quality checks are pending at the time of writing. Existing directory UI WIP is excluded from this review target and still needs real browser interaction. Human acceptance, fork soak, merge/release and full C1 are not approved. Full requirement completion cannot be inferred from this checkpoint's test counts.

## Directory lifetime review correction (040 → 042)

Independent review of e2e5b29e returned changes_requested: source inspection ran before the 30-second deadline, did not consume caller cancellation, and bounded individual nodes but not total graph work. The standalone directory copy path had the same lifetime gap. The observed directory-lifetime RED is 10 tests / 6 pass / 4 fail. Its dense-graph failure returned npm sentinel exit code 71, proving npm was reached; it must not be described as a pre-npm rejection.

The correction creates one internal operation before the first source read and carries it through read-set verification, graph construction, registry/member attestation, packing and the standalone path. It limits declared edges to 4,096 per candidate and direct filesystem/traversal work to 262,144 steps; streamed directory enumeration also consumes that budget. Existing per-file, metadata, package-instance and shared archive limits remain in force. Delegated archive staging retains its own bounded preflight and consumes the same cancellation signal. Cursor traversal and enqueue deduplication avoid repeated queue shifts; the shared metadata read set is checked at deliberate phase boundaries and once after final member verification, not once per node.

Cancellation stops scheduling new operations. An already-running filesystem syscall is awaited before releasing its handle/staging; no abandoned Promise race or false claim of forcibly cancelling an OS syscall. Cleanup runs even after cancellation. The directory-lifetime-green-r1 batch passed build, source10/10, registry/topology11/11, affected admission37/37, and all six real-directory checkpoints, with zero failures/skips/cancellations. The tested source digest is 812b803b97fea7eae2e4257d08b56abccd82320e66e2cfeb1afde1536ca38f52, including the then-pending evidence wording in this document. Source and exact package inputs were unchanged during execution; the author read the complete logs and verified current source/input/dist hashes. The reviewer’s successor verdict is still pending; this correction does not close the original C1 acceptance gaps.

## Directory installation UI checkpoint

This section supersedes the earlier pending-review and memory-inventory descriptions for the boundaries below. Review053 approved the lifetime correction at HEAD8426b71bff6d8e628868e1aa9619db9763a0851d; that approval did not cover this UI delta.

Settings → 插件集成 now offers 从本地目录安装. Select an already-built plugin package directory on the Host computer; browsing or editing the path invalidates the previous selection until the new directory is successfully loaded. The dialog does not create directories, prevents duplicate submission, shows admission errors, and sends the existing local-directory install request. Installation does not enable the plugin. Host preparation rejects inconsistent source pins or incomplete physical dependencies; it does not require the operator to obtain canonical registry archives.

Architecture cell: plugin / Settings presentation. Map delta: none. The existing DirectoryBrowser and Manager installation API remain authoritative; no new filesystem route, store, grant policy or activation mechanism.

Dogfood evidence: `/Users/lang/workspace/github-lab/f202-acceptance/collective-host-93fee434/directory-browser-durable-r2/`. Actual Next Settings UI and production Fastify session, directory-browse, Manager admission, local grant policy and FilePluginInventoryStore ran on batch-owned ports5182/5183. All13 checkpoints passed (one browser test, zero failures/skips/cancellations): invalid navigation cannot install a stale path; actual repo Collective source installs with HTTP201; the exact source request is observed; reload retains installed/disabled/stopped; a fresh FileStore reads the same persisted snapshot. Author inspected screenshots. The first batch exposed a harness Response.status call error and long-path clipping; both were corrected, with an actual geometry assertion for input/navigation containment. Original failed evidence is retained.

Source,12939 compiled artifacts and package inputs remained unchanged during the successful run. Seven exact original registry archives were preseeded into this batch only. No Redis, OAuth or plugin activation occurred. The existing rows renderer automatically attempted recovery/list four times; the acceptance guard rejected all four before plugin invocation. Unregistered shell reads returned404 and the unwired documentation port503. These are explicit boundaries, not claims that the full application or owner-operation experience passed. All owned browser/server resources exited; evidence caches and inventory remain retained.

The UI has six regression cases within the prior90-test related suite; fresh mechanical/related validation and independent UI review are pending for this checkpoint. Current-policy browser validation, full app/browser-service activation and disabled operation presentation remain with the Host owner. The full package matrix, Host business cleanup, human acceptance, soak and release remain open under C1. This is an internal review checkpoint, not delivery of the whole migration.


## Owner-local source policy correction (112 → 117)

S10 in the C1 contract (lines626–633 and650–652) binds content trust to admission source, explicitly including raw local-directory and its existing pnpm physical closure. Later operator messages reaffirm local development/modification followed by offline directory selection and an unverified source label. Review112 confirmed this scope; the earlier requirement to prove every registry-shaped dependency against an original registry archive over-constrained that authority. Original tarball SRI proof remains necessary for catalog provenance, not for owner-local admission.

This revision removes canonical-cache attestation from local-directory preparation. All actual graph nodes use the same publication selection, private member sealing and offline pack path. The private receipt is version2: its top level and every node declare contentProvenance=owner-local; lockIntegrity is a declaration from the source-owned lock, while packDigest and member digests bind actual sealed bytes. Public source, inventory trust, shipped closure and catalog admission remain unchanged. Version/importer/snapshot/protocol checks, peer/cycle/multiversion/optional topology, source currentness, budgets and cancellation remain required.

The independently executed directory-owner-policy-red batch observed11 tests:3 pass/8 fail/0 skip. Failures were the old receipt version and canonical-cache requirements; transitive version mismatch, prerelease exclusion and optional relocation rejection remained green. GREEN is now observed; independent review of this policy revision is pending. Historical seeded-cache and browser evidence is retained without being promoted to no-cache evidence. Human acceptance, activation, soak and full C1 remain open.


Policy GREEN evidence: `directory-owner-policy-green-r1` under the dedicated F202 acceptance root. API/shared build, source10/10, policy/topology11/11, archive-budget21/21 and affected admission/catalog/materializer37/37 all passed with zero failures/skips/cancellations. Actual Collective source admission passed all6 checks starting with an empty package cache, without reading or seeding original tarballs. All10 receipt nodes declare owner-local provenance;7 lock integrities are recorded as declarations, and AJV peer coordinates remain exact. Passive installed import denied source reads, writes, child/worker creation; network/listen attempts and create/start calls were zero. Only the final candidate remains in the batch package store. Source/inputs/harness remained exact;7 expected source/distribution dist artifacts changed, and12,939 total artifacts were rechecked. The executor's summary said8 changed artifacts; execution.json establishes7. Isolated test caches remain retained (reported TMP2.8MiB), not a claim of zero residue.

The delegated executor also attempted a nonexistent watch.mjs, which failed MODULE_NOT_FOUND without running a second validation. This orchestration failure is retained separately from the actual successful seven-stage run; future result detectors must exist and be frozen before registration. No original log was overwritten. This revision removes the mistaken production canonical-cache prerequisite, not the remaining current-policy browser/activation/full-app and C1 obligations.
