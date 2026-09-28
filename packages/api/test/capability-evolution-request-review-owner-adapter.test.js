import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evolutionAssetReviewV1Schema } from '@cat-cafe/shared';
import {
  PROGRAM_ADAPTER_CAPABILITIES,
  ProgramAdapterRegistry,
} from '../dist/infrastructure/capability-evolution/adapters/program-adapter-registry.js';

// Lazy import — adapter is compiled alongside other adapters
const adapterModule = await import(
  '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-adapter.js'
);
const { createRequestReviewOwnerAdapter, REQUEST_REVIEW_OWNER_FEATURE_ID } = adapterModule;
const { extractRequestReviewMutableAnchor, requestReviewSemanticVersion, requestReviewSemanticVersionFromAnchor } =
  await import('../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-port.js');

const FAKE_BLOB_OID_SKILL = 'a'.repeat(40);
const FAKE_PARENT_BLOB_OID_SKILL = 'b'.repeat(40);
const FAKE_HEAD_OID = 'c'.repeat(40);
const FAKE_PARENT_COMMIT_OID = 'd'.repeat(40);
const CURRENT_ANCHOR = [
  'Review-Subject-Ref: <pr:owner/repo#N>',
  'Accepted-Source-Ref: <exact anchor>',
  'Accepted-Revision: <exact revision>',
  'Feature 以 canonical docs/features/F*.md 为 anchor。',
].join('\n');
const CURRENT_SKILL_SOURCE = [
  '---',
  'name: request-review',
  '---',
  'Review-Subject-Ref: <pr:owner/repo#N>',
  'Accepted-Source-Ref: <exact anchor>',
  'Accepted-Revision: <exact revision>',
  'Scope: immutable',
  '',
  'Feature 以 canonical docs/features/F*.md 为 anchor。',
  '',
  'immutable guard',
].join('\n');
const CURRENT_SEMANTIC_VERSION = requestReviewSemanticVersion(CURRENT_SKILL_SOURCE);
const PARENT_ANCHOR = 'Accepted-Source-Ref: <free prose>';
const PARENT_SEMANTIC_VERSION = requestReviewSemanticVersionFromAnchor(PARENT_ANCHOR);

/** Canonical asset identity per F314:227 */
const CANONICAL_ASSET_KIND = 'skill';
const CANONICAL_ASSET_ID = 'cat-cafe-skills/request-review/SKILL.md';

/** Minimal port stub — returns deterministic Git OIDs, all pinned to commit */
function stubPort(overrides = {}) {
  return {
    gitBlobOidAt: async (_commitOid, filePath) => {
      if (filePath.includes('SKILL.md')) return FAKE_BLOB_OID_SKILL;
      throw new Error(`unexpected file: ${filePath}`);
    },
    gitHeadOid: async () => FAKE_HEAD_OID,
    listFileHistoryAt: async () => [
      {
        commitOid: FAKE_HEAD_OID,
        blobOid: FAKE_BLOB_OID_SKILL,
        committedAt: '2026-09-12T09:00:00.000Z',
        subject: 'current accepted-source anchor',
      },
    ],
    readMutableAcceptedSourceAt: async (_commitOid, filePath) => {
      if (filePath.includes('SKILL.md')) {
        return CURRENT_ANCHOR;
      }
      throw new Error(`unexpected file: ${filePath}`);
    },
    readSkillFileAt: async (_commitOid, filePath) => {
      if (filePath.includes('SKILL.md')) return CURRENT_SKILL_SOURCE;
      throw new Error(`unexpected file: ${filePath}`);
    },
    ...overrides,
  };
}

const programRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c',
};
const objectRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability:development-process-harness-effectiveness',
};

describe('F100 request-review owner adapter', () => {
  describe('descriptor and registry integration', () => {
    it('registers without error alongside another adapter', () => {
      const registry = new ProgramAdapterRegistry();
      const blocked = async () => ({ status: 'blocked', code: 'owner_route_unavailable' });
      // Register a non-overlapping microduck adapter first
      registry.register({
        descriptor: {
          schemaVersion: 1,
          adapterId: 'microduck-owner-v1',
          adapterOwnerRef: { ownerFeatureId: 'F202', ownerStateRef: 'adapter:microduck-owner-v1', version: '1' },
          targetOwnerFeatureId: 'microduck-owner',
          targetStateRefPrefix: 'simulator:',
          capabilities: PROGRAM_ADAPTER_CAPABILITIES,
        },
        observe: blocked,
        permission: blocked,
        mutate: blocked,
        verify: blocked,
        writeback: blocked,
        freshOutcome: blocked,
        rollback: blocked,
      });
      const requestReviewAdapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      registry.register(requestReviewAdapter);

      const resolution = registry.resolve(objectRef);
      assert.equal(resolution.status, 'resolved');
      assert.equal(resolution.adapter, requestReviewAdapter);
    });

    // Finding 2: narrowed prefix — only resolves for the exact capability
    it('resolves only for F100 capability:development-process-harness-effectiveness', () => {
      const registry = new ProgramAdapterRegistry();
      const requestReviewAdapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      registry.register(requestReviewAdapter);

      // Exact match resolves
      assert.equal(registry.resolve(objectRef).status, 'resolved');
      // Different capability under same feature does NOT resolve (narrowed prefix)
      assert.equal(
        registry.resolve({ ownerFeatureId: 'F100', ownerStateRef: 'capability:something-else' }).status,
        'blocked',
      );
      // Different feature ID does NOT resolve
      assert.equal(
        registry.resolve({
          ownerFeatureId: 'F999',
          ownerStateRef: 'capability:development-process-harness-effectiveness',
        }).status,
        'blocked',
      );
    });

    it('exports the correct feature ID constant', () => {
      assert.equal(REQUEST_REVIEW_OWNER_FEATURE_ID, 'F100');
    });
  });

  describe('required owner operations', () => {
    const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });

    for (const op of ['observe', 'permission', 'mutate', 'verify', 'writeback', 'freshOutcome', 'rollback']) {
      it(`${op} fails closed when the production owner action surface is unavailable`, async () => {
        const result = await adapter[op]({});
        assert.equal(result.status, 'blocked');
        assert.equal(result.code, 'owner_runtime_unavailable');
      });
    }

    it('delegates all seven verbs through the late-bound owner action surface', async () => {
      const calls = [];
      const actions = Object.fromEntries(
        ['observe', 'permission', 'mutate', 'verify', 'writeback', 'freshOutcome', 'rollback'].map((operation) => [
          operation,
          async (input) => {
            calls.push({ operation, input });
            return { status: 'ok', operation };
          },
        ]),
      );
      let active;
      const wired = createRequestReviewOwnerAdapter({ port: stubPort(), resolveActions: () => active });
      assert.equal((await wired.observe({ phase: 'before-wiring' })).code, 'owner_runtime_unavailable');
      active = actions;
      for (const operation of Object.keys(actions)) {
        assert.deepEqual(await wired[operation]({ operation }), { status: 'ok', operation });
      }
      assert.equal(calls.length, 7);
    });
  });

  describe('versionReview', () => {
    it('produces a schema-valid resolved response', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const input = { programRef, objectRef };
      const result = await adapter.versionReview(input);

      // Must pass the Zod schema
      const parsed = evolutionAssetReviewV1Schema.safeParse(result);
      assert.equal(parsed.success, true, `schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);

      assert.equal(result.status, 'resolved');
      assert.equal(result.schemaVersion, 1);
      assert.deepEqual(result.programRef, programRef);
      assert.deepEqual(result.objectRef, objectRef);
    });

    // Finding 1: single canonical asset with correct kind/id per F314:227
    it('includes exactly one current version ref with canonical asset identity', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const result = await adapter.versionReview({ programRef, objectRef });

      assert.equal(result.status, 'resolved');
      assert.equal(result.currentVersionRefs.length, 1, 'expected exactly one canonical asset');

      const ref = result.currentVersionRefs[0];
      assert.equal(ref.version, CURRENT_SEMANTIC_VERSION);
      assert.equal(ref.assetKind, CANONICAL_ASSET_KIND, 'assetKind must be "skill" per F314:227');
      assert.equal(ref.assetId, CANONICAL_ASSET_ID, 'assetId must be the SKILL.md path per F314:227');
      assert.equal(ref.ownerFeatureId, 'F100');
    });

    it('includes a version catalog with the single current version', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const result = await adapter.versionReview({ programRef, objectRef });

      assert.equal(result.status, 'resolved');
      assert.equal(result.versions.length, 1, 'expected exactly one version entry');

      const entry = result.versions[0];
      assert.equal(entry.versionRef.assetId, CANONICAL_ASSET_ID);
      assert.equal(entry.versionRef.version, CURRENT_SEMANTIC_VERSION);
      assert.deepEqual(entry.parentEdges, []);
    });

    it('returns distinct historical versions with canonical parent edges', async () => {
      const adapter = createRequestReviewOwnerAdapter({
        port: stubPort({
          listFileHistoryAt: async () => [
            {
              commitOid: FAKE_HEAD_OID,
              blobOid: FAKE_BLOB_OID_SKILL,
              committedAt: '2026-09-12T09:00:00.000Z',
              subject: 'current accepted-source anchor',
            },
            {
              commitOid: 'e'.repeat(40),
              blobOid: FAKE_BLOB_OID_SKILL,
              committedAt: '2026-09-12T08:00:00.000Z',
              subject: 'unrelated commit with identical bytes',
            },
            {
              commitOid: FAKE_PARENT_COMMIT_OID,
              blobOid: FAKE_PARENT_BLOB_OID_SKILL,
              committedAt: '2026-09-11T09:00:00.000Z',
              subject: 'previous accepted-source anchor',
            },
          ],
          readMutableAcceptedSourceAt: async (commitOid) =>
            commitOid === FAKE_PARENT_COMMIT_OID ? PARENT_ANCHOR : CURRENT_ANCHOR,
        }),
      });

      const result = await adapter.versionReview({ programRef, objectRef });
      assert.equal(result.status, 'resolved');
      assert.equal(result.versions.length, 2, 'identical file bytes must not create a second asset version');
      assert.equal(result.versions[0].versionRef.version, CURRENT_SEMANTIC_VERSION);
      assert.equal(result.versions[1].versionRef.version, PARENT_SEMANTIC_VERSION);
      assert.deepEqual(result.versions[0].parentEdges[0].parentVersionRef, result.versions[1].versionRef);
      assert.match(result.versions[0].parentEdges[0].edgeRef.ownerStateRef, /git-parent:/);
      assert.deepEqual(result.versions[1].parentEdges, []);
    });

    it('reads an historical selected version and compares its mutable anchor to current bytes', async () => {
      const reads = [];
      const adapter = createRequestReviewOwnerAdapter({
        port: stubPort({
          listFileHistoryAt: async () => [
            {
              commitOid: FAKE_HEAD_OID,
              blobOid: FAKE_BLOB_OID_SKILL,
              committedAt: '2026-09-12T09:00:00.000Z',
              subject: 'current accepted-source anchor',
            },
            {
              commitOid: FAKE_PARENT_COMMIT_OID,
              blobOid: FAKE_PARENT_BLOB_OID_SKILL,
              committedAt: '2026-09-11T09:00:00.000Z',
              subject: 'previous accepted-source anchor',
            },
          ],
          readMutableAcceptedSourceAt: async (commitOid) => {
            reads.push(commitOid);
            return commitOid === FAKE_PARENT_COMMIT_OID
              ? 'Accepted-Source-Ref: <free prose>'
              : 'Accepted-Source-Ref: <exact anchor>';
          },
        }),
      });
      const selectedVersionRef = {
        ownerFeatureId: 'F100',
        ownerStateRef: `skill:${CANONICAL_ASSET_ID}`,
        version: PARENT_SEMANTIC_VERSION,
        assetKind: CANONICAL_ASSET_KIND,
        assetId: CANONICAL_ASSET_ID,
      };

      const result = await adapter.versionReview({ programRef, objectRef, selectedVersionRef });
      assert.equal(result.status, 'resolved');
      assert.equal(result.selected.diff.status, 'available');
      assert.deepEqual(new Set(reads), new Set([FAKE_HEAD_OID, FAKE_PARENT_COMMIT_OID]));
      assert.match(result.selected.diff.summary, /free prose/);
      assert.match(result.selected.diff.summary, /exact anchor/);
      assert.match(result.selected.diff.rawDiffRef.ownerStateRef, new RegExp(FAKE_PARENT_COMMIT_OID));
    });

    it('excludes pre-template source history from the semantic experiment catalog', async () => {
      const adapter = createRequestReviewOwnerAdapter({
        port: stubPort({
          listFileHistoryAt: async () => [
            {
              commitOid: FAKE_HEAD_OID,
              blobOid: FAKE_BLOB_OID_SKILL,
              committedAt: '2026-09-12T09:00:00.000Z',
              subject: 'current accepted-source anchor',
            },
            {
              commitOid: FAKE_PARENT_COMMIT_OID,
              blobOid: FAKE_PARENT_BLOB_OID_SKILL,
              committedAt: '2026-01-01T09:00:00.000Z',
              subject: 'before accepted-source template existed',
            },
          ],
          readMutableAcceptedSourceAt: async (commitOid) => {
            if (commitOid === FAKE_PARENT_COMMIT_OID) throw new Error('anchor absent');
            return 'Accepted-Source-Ref: <exact anchor>';
          },
        }),
      });
      const selectedVersionRef = {
        ownerFeatureId: 'F100',
        ownerStateRef: `skill:${CANONICAL_ASSET_ID}`,
        version: PARENT_SEMANTIC_VERSION,
        assetKind: CANONICAL_ASSET_KIND,
        assetId: CANONICAL_ASSET_ID,
      };
      const result = await adapter.versionReview({ programRef, objectRef, selectedVersionRef });
      assert.equal(result.status, 'unavailable');
      assert.equal(result.blockers[0].code, 'owner_version_not_found');
    });

    it('carries typed blockers for missing adoption/applied-use proof', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const result = await adapter.versionReview({ programRef, objectRef });

      assert.equal(result.status, 'resolved');
      assert.ok(result.blockers.length > 0, 'expected at least one typed blocker');
      const codes = result.blockers.map((b) => b.code);
      assert.ok(codes.includes('adoption_proof_unavailable'), 'expected adoption_proof_unavailable blocker');
      assert.ok(codes.includes('applied_use_proof_unavailable'), 'expected applied_use_proof_unavailable blocker');
    });

    it('projects exact-version evidence, adoption, and actual use from the F100 ledger', async () => {
      const currentVersionRef = {
        ownerFeatureId: 'F100',
        ownerStateRef: `skill:${CANONICAL_ASSET_ID}`,
        version: CURRENT_SEMANTIC_VERSION,
        assetKind: CANONICAL_ASSET_KIND,
        assetId: CANONICAL_ASSET_ID,
      };
      const reservationId = 'reservation-ledger-1';
      const evidenceEvents = [
        ['comparison_baseline', 'baseline'],
        ['candidate_independent_verification', 'independent'],
        ['post_adoption_observation', 'observation'],
      ].map(([role, suffix], index) => ({
        schemaVersion: 1,
        eventId: `evidence:${suffix}`,
        type: 'evidence_linked',
        occurredAt: `2026-09-12T10:0${index}:00.000Z`,
        proposalId: 'proposal-1',
        assetVersionRef: currentVersionRef,
        role,
        evidenceRef: { ownerFeatureId: 'F192', ownerStateRef: `evidence:${suffix}` },
        proofRef: { ownerFeatureId: 'F267', ownerStateRef: `proof:${suffix}` },
        status: 'verified',
      }));
      const ledger = {
        async read() {
          return [
            ...evidenceEvents,
            {
              schemaVersion: 1,
              eventId: 'intervention:proposal-1',
              type: 'intervention_changed',
              occurredAt: '2026-09-12T10:03:00.000Z',
              proposalId: 'proposal-1',
              receiptRef: { ownerFeatureId: 'F100', ownerStateRef: 'intervention:proposal-1' },
              assetVersionRef: currentVersionRef,
              mainCommitSha: '9'.repeat(40),
              loadedRuntimeRef: { ownerFeatureId: 'F100', ownerStateRef: 'runtime:alpha', version: '9'.repeat(40) },
              changedAt: '2026-09-12T10:03:00.000Z',
              loadedAt: '2026-09-12T10:04:00.000Z',
            },
            {
              schemaVersion: 1,
              eventId: `use-reservation:${reservationId}`,
              type: 'use_reserved',
              occurredAt: '2026-09-12T10:05:00.000Z',
              reservationId,
              assetVersionRef: currentVersionRef,
              userId: 'owner-1',
              invocationId: 'inv-author',
              threadId: 'thread-review',
              authorCatId: 'codex-sol',
              reviewerCatId: 'codex-terra',
              reviewSubjectRef: 'pr:owner/cat-cafe#4512',
              reviewedHeadSha: '9'.repeat(40),
              acceptedSourceRef: 'docs/features/F314-development-episode-alignment-experiment.md',
              acceptedRevision: '8'.repeat(40),
              consumerRef: { ownerFeatureId: 'F100', ownerStateRef: 'consumer:request-review-local-review-v1' },
            },
            {
              schemaVersion: 1,
              eventId: `use-dispatch:${reservationId}`,
              type: 'use_dispatch_bound',
              occurredAt: '2026-09-12T10:06:00.000Z',
              reservationId,
              requestMessageId: 'message-request',
              reviewerInvocationId: 'inv-reviewer',
              deliveryStatus: 'attested',
              deliveredAssetVersionRef: currentVersionRef,
              deliveredPackageRevision: `sha256:${'7'.repeat(64)}`,
              deliveryProofRef: {
                ownerFeatureId: 'F100',
                ownerStateRef: 'request-review-delivery:reservation-ledger-1',
              },
            },
            {
              schemaVersion: 1,
              eventId: `use-terminal:${reservationId}`,
              type: 'use_recorded',
              occurredAt: '2026-09-12T10:07:00.000Z',
              reservationId,
              reviewMessageId: 'message-review',
              use: 'applied',
              proofRef: { ownerFeatureId: 'F100', ownerStateRef: `request-review-use:${reservationId}` },
            },
          ];
        },
      };
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort(), ledger });
      const result = await adapter.versionReview({ programRef, objectRef, selectedVersionRef: currentVersionRef });

      assert.equal(result.status, 'resolved');
      assert.equal(evolutionAssetReviewV1Schema.safeParse(result).success, true);
      assert.deepEqual(
        result.selected.evidence.map((item) => item.role),
        ['comparison_baseline', 'candidate_independent_verification', 'post_adoption_observation'],
      );
      assert.equal(result.selected.uses.length, 1);
      assert.equal(result.selected.uses[0].use, 'applied');
      assert.equal(result.selected.uses[0].invocationRef.ownerStateRef, 'inv:inv-reviewer');
      assert.equal(
        result.blockers.some((blocker) => blocker.code === 'adoption_proof_unavailable'),
        false,
      );
      assert.equal(
        result.blockers.some((blocker) => blocker.code === 'applied_use_proof_unavailable'),
        false,
      );
    });

    it('includes sourceRef and currentProofRef with Git HEAD OID', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const result = await adapter.versionReview({ programRef, objectRef });

      assert.equal(result.status, 'resolved');
      assert.ok(result.sourceRef.ownerStateRef.includes('request-review'), 'sourceRef should reference request-review');
      assert.ok(result.currentProofRef.ownerStateRef.includes(FAKE_HEAD_OID), 'proof should include HEAD OID');
    });

    it('returns unavailable when the port throws', async () => {
      const errorPort = stubPort({
        gitBlobOidAt: async () => {
          throw new Error('git not available');
        },
      });
      const adapter = createRequestReviewOwnerAdapter({ port: errorPort });
      const result = await adapter.versionReview({ programRef, objectRef });

      const parsed = evolutionAssetReviewV1Schema.safeParse(result);
      assert.equal(parsed.success, true, `schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);

      assert.equal(result.status, 'unavailable');
      assert.ok(result.blockers.length > 0);
      assert.equal(result.blockers[0].code, 'owner_read_failed');
    });

    it('populates selected when selectedVersionRef matches current', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const selectedVersionRef = {
        ownerFeatureId: 'F100',
        ownerStateRef: `skill:${CANONICAL_ASSET_ID}`,
        version: CURRENT_SEMANTIC_VERSION,
        assetKind: CANONICAL_ASSET_KIND,
        assetId: CANONICAL_ASSET_ID,
      };
      const result = await adapter.versionReview({ programRef, objectRef, selectedVersionRef });

      assert.equal(result.status, 'resolved');
      assert.ok(result.selected, 'expected selected to be populated');
      assert.deepEqual(result.selected.versionRef, selectedVersionRef);
      assert.equal(result.selected.diff.status, 'available');
    });

    // Finding 3: unknown versions return typed unavailable, not fabricated into catalog
    it('returns unavailable with owner_version_not_found when selected version is not in catalog', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const unknownVersion = {
        ownerFeatureId: 'F100',
        ownerStateRef: `skill:${CANONICAL_ASSET_ID}`,
        version: 'f'.repeat(40),
        assetKind: CANONICAL_ASSET_KIND,
        assetId: CANONICAL_ASSET_ID,
      };
      const result = await adapter.versionReview({ programRef, objectRef, selectedVersionRef: unknownVersion });

      // Must return typed unavailable, NOT fabricate the unknown version into the catalog
      const parsed = evolutionAssetReviewV1Schema.safeParse(result);
      assert.equal(parsed.success, true, `schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);

      assert.equal(result.status, 'unavailable', 'unknown version must produce unavailable, not resolved');
      assert.equal(result.blockers[0].code, 'owner_version_not_found');
    });

    // Regression: suffix capability leaks through registry startsWith() — adapter must guard exact objectRef
    it('returns unavailable for suffix-matching objectRef that leaks through registry prefix', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const suffixObjectRef = {
        ownerFeatureId: 'F100',
        ownerStateRef: 'capability:development-process-harness-effectiveness-shadow',
      };
      const result = await adapter.versionReview({ programRef, objectRef: suffixObjectRef });

      const parsed = evolutionAssetReviewV1Schema.safeParse(result);
      assert.equal(parsed.success, true, `schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);

      assert.equal(result.status, 'unavailable', 'suffix objectRef must be rejected at adapter boundary');
      assert.equal(result.blockers[0].code, 'object_scope_mismatch');
    });

    // Regression: selectedVersionRef with same assetId/version but wrong ownerStateRef must not match
    it('returns unavailable when selectedVersionRef has matching assetId/version but wrong ownerStateRef', async () => {
      const adapter = createRequestReviewOwnerAdapter({ port: stubPort() });
      const alteredRef = {
        ownerFeatureId: 'F100',
        ownerStateRef: 'skill:wrong',
        version: CURRENT_SEMANTIC_VERSION,
        assetKind: CANONICAL_ASSET_KIND,
        assetId: CANONICAL_ASSET_ID,
      };
      const result = await adapter.versionReview({ programRef, objectRef, selectedVersionRef: alteredRef });

      const parsed = evolutionAssetReviewV1Schema.safeParse(result);
      assert.equal(parsed.success, true, `schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);

      assert.equal(result.status, 'unavailable', 'partial identity match must not resolve');
      assert.equal(result.blockers[0].code, 'owner_version_not_found');
    });

    // Finding 4: dirty-worktree regression — port must read from pinned commit, not working tree
    it('passes commitOid to port methods, preventing dirty-worktree drift', async () => {
      const capturedCalls = { blobOidAt: [], readMutableAcceptedSourceAt: [] };

      const spyPort = stubPort({
        gitBlobOidAt: async (commitOid, filePath) => {
          capturedCalls.blobOidAt.push({ commitOid, filePath });
          return FAKE_BLOB_OID_SKILL;
        },
        readMutableAcceptedSourceAt: async (commitOid, filePath) => {
          capturedCalls.readMutableAcceptedSourceAt.push({ commitOid, filePath });
          return 'mutable content from pinned commit';
        },
      });

      const adapter = createRequestReviewOwnerAdapter({ port: spyPort });
      const selectedVersionRef = {
        ownerFeatureId: 'F100',
        ownerStateRef: `skill:${CANONICAL_ASSET_ID}`,
        version: CURRENT_SEMANTIC_VERSION,
        assetKind: CANONICAL_ASSET_KIND,
        assetId: CANONICAL_ASSET_ID,
      };
      await adapter.versionReview({ programRef, objectRef, selectedVersionRef });

      // Verify gitBlobOidAt was called with the HEAD OID (pinned commit)
      assert.ok(capturedCalls.blobOidAt.length > 0, 'gitBlobOidAt should have been called');
      for (const call of capturedCalls.blobOidAt) {
        assert.equal(call.commitOid, FAKE_HEAD_OID, 'blob OID must be resolved against pinned HEAD');
      }

      // Verify mutable anchor content was read from the pinned HEAD, not the working tree.
      assert.ok(capturedCalls.readMutableAcceptedSourceAt.length > 0, 'mutable anchor reader should be called');
      for (const call of capturedCalls.readMutableAcceptedSourceAt) {
        assert.equal(call.commitOid, FAKE_HEAD_OID, 'file content must be read from pinned HEAD, not working tree');
      }
    });

    it('extracts only the semantic accepted-source anchor even when surrounding line numbers drift', () => {
      const content = [
        '# shifted header',
        ...Array.from({ length: 17 }, (_, index) => `unrelated-${index}`),
        'Review-Subject-Ref: <pr:owner/repo#N>',
        'Request-Review-Consumption-Handle: <opaque>',
        'Accepted-Source-Ref: <canonical source>',
        'Accepted-Revision: <exact revision>',
        'Scope: must not enter the variable',
        '',
        'Feature 以 canonical docs/features/F*.md 为 anchor；消息 source 以',
        'threadId#messageId 自身为 revision。',
        '',
        'reviewer 用 deterministic guard 校验 — immutable fence',
      ].join('\n');
      const extracted = extractRequestReviewMutableAnchor(content);
      assert.match(extracted, /Request-Review-Consumption-Handle/);
      assert.match(extracted, /threadId#messageId/);
      assert.doesNotMatch(extracted, /Scope:/);
      assert.doesNotMatch(extracted, /immutable fence/);
    });

    it('derives one experiment version from the semantic anchor, not unrelated skill metadata', () => {
      const common = [
        'Review-Subject-Ref: <pr:owner/repo#N>',
        'Request-Review-Consumption-Handle: <opaque>',
        'Accepted-Source-Ref: <canonical source>',
        'Accepted-Revision: <exact revision>',
        '',
        'Feature 以 canonical docs/features/F*.md 为 anchor；消息 source 以',
        'threadId#messageId 自身为 revision。',
      ].join('\n');
      const before = `---\ntips_exempt: old\n---\n${common}\nimmutable guard A`;
      const after = `---\ntips_exempt: renewed\n---\n${common}\nimmutable guard A`;

      assert.equal(requestReviewSemanticVersion(before), requestReviewSemanticVersion(after));
      assert.match(requestReviewSemanticVersion(before), /^[a-f0-9]{64}$/);
    });
  });
});
