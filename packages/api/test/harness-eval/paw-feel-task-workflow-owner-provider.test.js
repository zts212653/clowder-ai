import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queryTaskItems } from '../../dist/domains/cats/services/stores/ports/TaskQuery.js';
import { PawFeelDirectRepairBindingVerifier } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-binding-verifier.js';
import { PawFeelDirectRepairFederation } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairOutcomeResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-outcome-resolver.js';
import { PawFeelDirectRepairResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-resolver.js';
import { defaultPawFeelSourceToolClassifier } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-source.js';
import {
  F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
  TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/providers/task-workflow-owner-provider.js';
import {
  AUTHORIZATION_MESSAGE,
  BASE_REVISION,
  createFixture,
  gitTruth,
  LOADED_REVISION,
  MAIN_REVISION,
  OWNER_CAT_ID,
  provider,
  providerCustody,
  providerSource,
  resolveBinding,
  SOURCE_MESSAGE,
  sourceProjection,
  sourceVerifier,
} from './helpers/paw-feel-task-workflow-owner-provider-fixture.js';

describe('F313/F160 concrete task-workflow direct-repair owner provider', () => {
  it('routes only the exact list_tasks tool and binds the active owner custody to the immutable source', async () => {
    const sourceToolRef = defaultPawFeelSourceToolClassifier('cat_cafe_list_tasks');
    assert.deepEqual(sourceToolRef, {
      ownerFeatureId: 'F160',
      ownerStateRef: 'mcp-tool:cat_cafe_list_tasks',
    });
    const fixture = createFixture();
    const decision = await provider(fixture).resolveAuthority({
      source: { ...providerSource(), sourceToolRef },
      custody: providerCustody(fixture),
      actionRef: F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
    });
    assert.equal(decision.status, 'authorized');
    assert.equal(decision.authority.ownerCatId, OWNER_CAT_ID);
    assert.equal(decision.authority.targetVersionRef.version, BASE_REVISION);
    assert.equal(decision.authority.targetVersionRef.assetId, 'cat_cafe_list_tasks');

    const wrongAction = await provider(fixture).resolveAuthority({
      source: { ...providerSource(), sourceToolRef },
      custody: providerCustody(fixture),
      actionRef: 'foreign-action',
    });
    assert.equal(wrongAction.status, 'blocked');

    const wrongOwner = await provider(fixture).resolveAuthority({
      source: { ...providerSource(), sourceToolRef },
      custody: { ...providerCustody(fixture), ownerCatId: 'opus' },
      actionRef: F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
    });
    assert.equal(wrongOwner.status, 'blocked');
    assert.equal(wrongOwner.reason, 'owner_mismatch');

    fixture.taskStore.update(fixture.custodyTask.id, { status: 'done' });
    const terminalCustody = await provider(fixture).resolveAuthority({
      source: { ...providerSource(), sourceToolRef },
      custody: providerCustody(fixture),
      actionRef: F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
    });
    assert.equal(terminalCustody.status, 'blocked');
    assert.equal(terminalCustody.reason, 'owner_mismatch');
  });

  it('rejects a missing owner scope or oversized feature ID before reading task storage', async () => {
    let storeReads = 0;
    const taskStore = {
      async listByThread() {
        storeReads += 1;
        return [];
      },
    };

    await assert.rejects(
      queryTaskItems(taskStore, { threadIds: ['default'], ownerUserId: '', featureId: 'F299' }),
      /ownerUserId/u,
    );
    await assert.rejects(
      queryTaskItems(taskStore, {
        threadIds: ['default'],
        ownerUserId: 'owner-1',
        featureId: `F${'1'.repeat(409)}`,
      }),
      /too_big|120|at most/iu,
    );
    assert.equal(storeReads, 0);
  });

  it('closes source → binding → bounded live F299 query → merged-loaded outcome without an outcome store', async () => {
    const fixture = createFixture();
    const verifier = sourceVerifier(fixture.messageStore);
    const admissionProvider = provider(fixture);
    const admissionFederation = new PawFeelDirectRepairFederation([
      { route: TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE, provider: admissionProvider },
    ]);
    const resolver = new PawFeelDirectRepairResolver({
      sourceVerifier: verifier,
      federation: admissionFederation,
      custodyResolver: {
        async resolve(leaseId) {
          return {
            ownerCatId: OWNER_CAT_ID,
            taskId: fixture.custodyTask.id,
            leaseId,
            leaseGeneration: 1,
            custodyEvidenceRef: `action-lease:${leaseId}:generation:1`,
          };
        },
      },
      approvalContinuationResolver: {
        async resolve() {
          throw new Error('existing internal-tool authority must not create Approval');
        },
      },
    });
    const admission = await resolver.resolve({
      projection: sourceProjection(),
      leaseId: 'lease-1',
      actionRef: F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
    });
    assert.equal(admission.status, 'authorized');

    const query = await queryTaskItems(fixture.taskStore, {
      threadIds: ['default', SOURCE_MESSAGE.threadId, 'thread-repair'],
      ownerUserId: 'owner-1',
      featureId: 'F299',
    });
    assert.equal(query.totalMatched, 2);
    assert.equal(query.truncated, false);
    assert.ok(query.queryRef);

    const loadedProvider = provider(
      fixture,
      gitTruth({
        loadedRevision: LOADED_REVISION,
        mainRevision: MAIN_REVISION,
        changedFiles: ['packages/api/src/routes/callback-task-routes.ts'],
      }),
    );
    const loadedFederation = new PawFeelDirectRepairFederation([
      { route: TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE, provider: loadedProvider },
    ]);
    const outcomeResolver = new PawFeelDirectRepairOutcomeResolver({
      bindingVerifier: new PawFeelDirectRepairBindingVerifier({
        sourceVerifier: verifier,
        federation: loadedFederation,
      }),
      terminalResolver: {
        async resolve() {
          return {
            ownerCatId: OWNER_CAT_ID,
            taskTerminalRef: { ownerFeatureId: 'F313', ownerStateRef: `task-terminal:${fixture.custodyTask.id}` },
            leaseTerminalRef: { ownerFeatureId: 'F167', ownerStateRef: 'action-terminal:lease-1', version: '1:2' },
          };
        },
      },
    });
    const outcome = await outcomeResolver.resolve({
      projection: sourceProjection({
        state: 'fix',
        sequence: 2,
        ownerCatId: OWNER_CAT_ID,
        taskId: fixture.custodyTask.id,
        actionLeaseRef: { leaseId: 'lease-1', generation: 1 },
        custodyEvidenceRef: 'action-lease:lease-1:generation:1',
        directRepairBinding: admission.binding,
      }),
      actor: { kind: 'cat', id: OWNER_CAT_ID },
      bindingRef: admission.binding.bindingRef,
      ownerOutcomeRef: query.queryRef,
    });
    assert.equal(outcome.disposition, 'verified_changed');
    assert.deepEqual(outcome.ownerOutcomeRef, query.queryRef);
    assert.ok(outcome.verificationRefs.some((ref) => ref.ownerStateRef.startsWith('task-query:feature:F299:')));
    assert.equal('payload' in outcome, false);
  });

  it('rejects source/auth drift, stale query refs, unrelated Git deltas, and a still-truncated feature query', async () => {
    const cases = [
      createFixture({
        sourceMessage: { ...SOURCE_MESSAGE, content: SOURCE_MESSAGE.content.replace('featureId', 'feature') },
      }),
      createFixture({
        authorization: { ...AUTHORIZATION_MESSAGE, content: `${AUTHORIZATION_MESSAGE.content} changed` },
      }),
    ];
    for (const fixture of cases) {
      await assert.rejects(
        provider(fixture).resolveAuthority({
          source: providerSource(),
          custody: providerCustody(fixture),
          actionRef: F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
        }),
        /source|authorization/i,
      );
    }

    const fixture = createFixture();
    const binding = await resolveBinding(fixture);
    const query = await queryTaskItems(fixture.taskStore, {
      threadIds: ['default', SOURCE_MESSAGE.threadId, 'thread-repair'],
      ownerUserId: 'owner-1',
      featureId: 'F299',
    });
    const otherOwnerQuery = await queryTaskItems(fixture.taskStore, {
      threadIds: ['default', SOURCE_MESSAGE.threadId, 'thread-repair'],
      ownerUserId: 'other-user',
      featureId: 'F299',
    });
    assert.equal(query.totalMatched, 2);
    assert.equal(otherOwnerQuery.totalMatched, 1);
    assert.notDeepEqual(query.queryRef, otherOwnerQuery.queryRef);
    const terminals = {
      taskTerminalRef: { ownerFeatureId: 'F313', ownerStateRef: `task-terminal:${fixture.custodyTask.id}` },
      leaseTerminalRef: { ownerFeatureId: 'F167', ownerStateRef: 'lease-terminal:lease-1' },
    };
    const relevantLoaded = provider(
      fixture,
      gitTruth({
        loadedRevision: LOADED_REVISION,
        mainRevision: MAIN_REVISION,
        changedFiles: ['packages/api/src/domains/cats/services/stores/ports/TaskQuery.ts'],
      }),
    );
    await assert.rejects(
      relevantLoaded.verifyOutcome({
        binding,
        ownerOutcomeRef: {
          ownerFeatureId: 'F160',
          ownerStateRef: `task-query:feature:F299:sha256:${'d'.repeat(64)}`,
          version: '1',
        },
        ...terminals,
      }),
      /query/i,
    );
    await assert.rejects(
      provider(
        fixture,
        gitTruth({ loadedRevision: LOADED_REVISION, mainRevision: MAIN_REVISION, changedFiles: ['README.md'] }),
      ).verifyOutcome({ binding, ownerOutcomeRef: query.queryRef, ...terminals }),
      /delta/i,
    );

    const truncated = createFixture({ extraF299: 50 });
    const truncatedBinding = await resolveBinding(truncated);
    const truncatedQuery = await queryTaskItems(truncated.taskStore, {
      threadIds: ['default', SOURCE_MESSAGE.threadId, 'thread-repair'],
      ownerUserId: 'owner-1',
      featureId: 'F299',
    });
    assert.equal(truncatedQuery.truncated, true);
    const truncatedProvider = provider(
      truncated,
      gitTruth({
        loadedRevision: LOADED_REVISION,
        mainRevision: MAIN_REVISION,
        changedFiles: ['packages/mcp-server/src/tools/callback-tools.ts'],
      }),
    );
    await assert.rejects(
      truncatedProvider.verifyOutcome({
        binding: truncatedBinding,
        ownerOutcomeRef: truncatedQuery.queryRef,
        taskTerminalRef: { ownerFeatureId: 'F313', ownerStateRef: `task-terminal:${truncated.custodyTask.id}` },
        leaseTerminalRef: { ownerFeatureId: 'F167', ownerStateRef: 'lease-terminal:lease-1' },
      }),
      /query|unbounded|truncated/i,
    );
  });
});
