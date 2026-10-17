import { createHash } from 'node:crypto';
import type { FrustrationIssue } from '@cat-cafe/shared';
import {
  assertDeploymentCatalog,
  assertFrustrationContract,
  type DeploymentCatalog,
  type FrustrationLinkDraftInput,
  type FrustrationLinkDraftResult,
  type FrustrationSource,
} from '@clowder-ai/plugin-contract';
import type { IFrustrationIssueStore } from '../../cats/services/stores/ports/FrustrationIssueStore.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import type { PublicInvocationVerifierPort } from '../carrier/public-invocation-verifier.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { PluginGrantRecord, PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import { createPluginOwnerThreadHost, type PluginOwnerThreadHost } from './plugin-owner-thread-host.js';
import {
  createPluginParticipantRosterHost,
  type PluginParticipantRosterHost,
  type PluginParticipantRosterServices,
} from './plugin-participant-roster-host.js';
import {
  createPluginPublicInvocationHost,
  type PluginPublicInvocationHost,
  type PluginPublicInvocationServices,
} from './plugin-public-invocation-host.js';
import {
  createPluginSourceFactsHost,
  type PluginNativeContextHost,
  type PluginSourceFactsHost,
} from './plugin-source-facts-host.js';
import type { PluginThreadProjectionDeps } from './plugin-thread-projections.js';

export interface PluginDeploymentServices {
  getRoster(): DeploymentCatalog['roster'];
  getDefaultCatId(): string;
  getReviewPolicy(): DeploymentCatalog['policy'];
}
export interface PluginNeutralHost {
  readonly publicInvocations: PluginPublicInvocationHost;
  readonly sourceFacts: PluginSourceFactsHost;
  readonly nativeContext: PluginNativeContextHost;
  readonly ownerThreads: PluginOwnerThreadHost;
  readonly participantRoster: PluginParticipantRosterHost;
  readonly deployment: { getCatalog(): Promise<DeploymentCatalog> };
  readonly frustration: {
    getSource(issueId: string): Promise<FrustrationSource | null>;
    linkDraft(input: FrustrationLinkDraftInput): Promise<FrustrationLinkDraftResult>;
  };
}
interface Deps {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly assertActivation: () => void;
  readonly inventory: PluginInventoryStore;
  readonly ownerUserId: string | undefined;
  readonly threadStore: IThreadStore | undefined;
  readonly sourceStore: IFrustrationIssueStore | undefined;
  readonly messageStore?: IMessageStore & Partial<Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>>;
  readonly publicInvocations?: PluginPublicInvocationServices;
  readonly verifyPublicInvocation: PublicInvocationVerifierPort['invokePublicInvocationVerifier'];
  readonly deployment: PluginDeploymentServices | undefined;
  readonly participantRoster?: PluginParticipantRosterServices;
  readonly projectPath?: string;
  readonly cats?: PluginThreadProjectionDeps['cats'];
}
function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}
function unavailable(name: string): never {
  throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', `Host ${name} services unavailable`);
}

/** Deliberately excludes private context, actor metadata and navigation/visibility from the revision. */
function projectSource(source: FrustrationIssue): FrustrationSource {
  const signalDetail = Object.fromEntries(
    ['cancelCount', 'windowMs', 'reasonCode', 'publicSummary', 'publicHint']
      .filter((key) => source.signalDetail[key] !== undefined)
      .map((key) => [key, source.signalDetail[key]]),
  );
  const material = {
    issueId: source.issueId,
    status: source.status,
    threadId: source.threadId,
    userId: source.userId,
    signalType: source.signalType,
    signalDetail,
    ...(source.userDescription === undefined ? {} : { userDescription: source.userDescription }),
    recentMessageCount: source.context.recentMessages.length,
  };
  const sourceRevision = createHash('sha256').update(JSON.stringify(material)).digest('hex');
  const result = snapshotPluginProtocolData({
    ...material,
    communityIssueDraftId: source.communityIssueDraftId ?? null,
    sourceRevision,
  });
  assertFrustrationContract('FrustrationSource', result);
  return result;
}

/** One activation's neutral ports. The plugin never receives these authority dependencies. */
export async function createPluginNeutralHost(deps: Deps): Promise<PluginNeutralHost> {
  const initial = await deps.inventory.snapshot();
  const instance = initial.instances.find((item) => item.pluginInstanceId === deps.pluginInstanceId);
  const grant = initial.grants.find((item) => item.pluginInstanceId === deps.pluginInstanceId);
  if (!instance || !grant || instance.packageDigest !== deps.packageDigest) refuse('Neutral installation unavailable');
  const pkg = initial.packages.find((item) => item.packageDigest === deps.packageDigest);
  if (!pkg) refuse('Neutral package unavailable');
  const manifest = structuredClone(pkg.manifest);
  const lifecycleRevision = instance.lifecycleRevision;
  const grantRevision = grant.grantRevision;
  function check(
    current: PluginInstanceRecord | undefined,
    grants: PluginGrantRecord | undefined,
    pkg: PluginPackageRecord | undefined,
    capabilities: readonly string[],
  ): void {
    deps.assertActivation();
    if (
      !current ||
      !grants ||
      current.lifecycleState !== 'installed' ||
      current.activationState !== 'enabled' ||
      current.configReadiness !== 'ready' ||
      current.packageDigest !== deps.packageDigest ||
      current.lifecycleRevision !== lifecycleRevision ||
      grants.grantRevision !== grantRevision ||
      pkg?.packageState !== 'installed' ||
      capabilities.some((capability) => !grants.effectiveGrants.some((g) => g === capability))
    )
      refuse('Neutral installation or capability is no longer current');
  }
  async function current(capabilities: readonly string[]): Promise<void> {
    deps.assertActivation();
    const snapshot = await deps.inventory.snapshot();
    check(
      snapshot.instances.find((i) => i.pluginInstanceId === deps.pluginInstanceId),
      snapshot.grants.find((g) => g.pluginInstanceId === deps.pluginInstanceId),
      snapshot.packages.find((p) => p.packageDigest === deps.packageDigest),
      capabilities,
    );
  }
  function inTransaction(tx: PluginInventoryTransaction, capabilities: readonly string[]): void {
    check(
      tx.instances.get(deps.pluginInstanceId),
      tx.grants.get(deps.pluginInstanceId),
      tx.packages.get(deps.packageDigest),
      capabilities,
    );
  }
  function principal(write: boolean) {
    if (!deps.ownerUserId || !deps.threadStore || !deps.sourceStore) unavailable('frustration');
    const owner = currentPluginOwnerRequestContext(deps.pluginInstanceId);
    const native = currentPluginCallContext(deps.pluginInstanceId);
    if (owner) {
      if (owner.userId !== deps.ownerUserId || (write && owner.operation !== 'write'))
        refuse('Owner source authority required');
      return {
        assertCurrent: () => owner.assertCurrent(),
        threadId: undefined,
        allowReplace: owner.operation === 'write',
        store: deps.sourceStore,
        threads: deps.threadStore,
      };
    }
    if (!native?.assertInvocationCurrent || !native.invocationId || native.userId !== deps.ownerUserId)
      refuse('Source requires a current owner request or native invocation');
    // The invocation-only fence must not reacquire the inventory lock during a source write.
    const assertInvocationCurrent = native.assertInvocationCurrent;
    return {
      assertCurrent: () => assertInvocationCurrent(),
      threadId: native.threadId,
      allowReplace: false,
      store: deps.sourceStore,
      threads: deps.threadStore,
    };
  }
  async function owned(source: FrustrationIssue, caller: ReturnType<typeof principal>): Promise<void> {
    if (source.userId !== deps.ownerUserId || (caller.threadId !== undefined && source.threadId !== caller.threadId))
      refuse('Source does not belong to this caller');
    const thread = await caller.threads.get(source.threadId);
    await caller.assertCurrent();
    if (!thread || thread.createdBy !== deps.ownerUserId) refuse('Source thread does not belong to this owner');
  }
  const read = ['frustration.read'];
  const write = ['frustration.read', 'frustration.link'];
  return Object.freeze({
    publicInvocations: createPluginPublicInvocationHost({
      pluginInstanceId: deps.pluginInstanceId,
      packageDigest: deps.packageDigest,
      lifecycleRevision,
      grantRevision,
      manifest,
      effectiveGrants: grant.effectiveGrants,
      ownerUserId: deps.ownerUserId,
      messages: deps.messageStore,
      threads: deps.threadStore,
      services: deps.publicInvocations,
      verify: deps.verifyPublicInvocation,
      assertCurrent: current,
    }),
    ...createPluginSourceFactsHost({
      queue: deps.publicInvocations?.queue,
      pluginInstanceId: deps.pluginInstanceId,
      ownerUserId: deps.ownerUserId,
      messageStore: deps.messageStore,
      threadStore: deps.threadStore,
      assertCurrent: current,
    }),
    participantRoster: createPluginParticipantRosterHost({
      pluginInstanceId: deps.pluginInstanceId,
      ownerUserId: deps.ownerUserId,
      manifest,
      effectiveGrants: Object.freeze([...grant.effectiveGrants]),
      services: deps.participantRoster,
      assertCurrent: current,
    }),
    ownerThreads: createPluginOwnerThreadHost({
      pluginInstanceId: deps.pluginInstanceId,
      ownerUserId: deps.ownerUserId,
      threadStore: deps.threadStore,
      projectPath: deps.projectPath,
      cats: deps.cats,
      assertCurrent: current,
    }),
    deployment: Object.freeze({
      getCatalog: async () => {
        if (!deps.deployment) unavailable('deployment');
        await current(['deployment.read']);
        const roster = Object.fromEntries(
          Object.entries(deps.deployment.getRoster()).map(([id, cat]) => [
            id,
            { family: cat.family, available: cat.available, lead: cat.lead },
          ]),
        );
        const policy = deps.deployment.getReviewPolicy();
        const result = snapshotPluginProtocolData({
          roster,
          defaultCatId: deps.deployment.getDefaultCatId(),
          policy: {
            requireDifferentFamily: policy.requireDifferentFamily,
            preferActiveInThread: policy.preferActiveInThread,
            preferLead: policy.preferLead,
            excludeUnavailable: policy.excludeUnavailable,
          },
        });
        assertDeploymentCatalog(result);
        await current(['deployment.read']);
        return result;
      },
    }),
    frustration: Object.freeze({
      getSource: async (issueId: string) => {
        assertFrustrationContract('FrustrationSourceId', issueId);
        const caller = principal(false);
        await caller.assertCurrent();
        await current(read);
        const source = await caller.store.getById(issueId);
        if (source) await owned(source, caller);
        const result = source ? projectSource(source) : null;
        await current(read);
        await caller.assertCurrent();
        return result;
      },
      linkDraft: async (input: FrustrationLinkDraftInput) => {
        const value = snapshotPluginProtocolData(input);
        assertFrustrationContract('FrustrationLinkDraftInput', value);
        const caller = principal(true);
        await caller.assertCurrent();
        await current(write);
        const source = await caller.store.getById(value.issueId);
        if (source) await owned(source, caller);
        const projected = source ? projectSource(source) : null;
        const result: FrustrationLinkDraftResult = await deps.inventory.transaction(async (tx) => {
          inTransaction(tx, write);
          await caller.assertCurrent();
          if (!source || !projected) return { outcome: 'missing' };
          await owned(source, caller);
          if (source.status !== 'confirmed') return { outcome: 'not_confirmed' };
          if (projected.sourceRevision !== value.sourceRevision) return { outcome: 'stale_source' };
          const receipt = await caller.store.compareAndSetCommunityIssueDraft(
            {
              issueId: value.issueId,
              expectedSource: source,
              expectedDraftId: value.expectedDraftId,
              draftId: value.draftId,
              allowReplace: caller.allowReplace,
            },
            async () => {
              deps.assertActivation();
              await caller.assertCurrent();
            },
          );
          await caller.assertCurrent();
          deps.assertActivation();
          return receipt.outcome === 'linked' || receipt.outcome === 'already_linked'
            ? { outcome: receipt.outcome, draftId: value.draftId, sourceRevision: value.sourceRevision }
            : { outcome: receipt.outcome };
        });
        await current(write);
        await caller.assertCurrent();
        assertFrustrationContract('FrustrationLinkDraftResult', result);
        return Object.freeze(result);
      },
    }),
  });
}
