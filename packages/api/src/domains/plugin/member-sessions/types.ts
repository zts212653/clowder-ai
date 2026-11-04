import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import type { PluginCallContext } from '../carrier/plugin-call-context.js';
import type { PluginOwnerOperationContext } from '../carrier/plugin-owner-operation-context.js';
import type { PluginPrivateStoragePort } from '../host-surface/plugin-private-storage.js';

export interface MemberMemoryReference {
  readonly sourceRef: string;
  readonly revision: string;
}
export interface MemberAccountSelection {
  readonly accountRef: string;
  readonly authType: 'oauth' | 'api_key';
  readonly expectedRevision?: string;
}
/** Non-secret actual execution inputs. Credential material never enters this contract. */
export interface MemberRuntimeSnapshot {
  readonly clientId: string;
  readonly model: string;
  readonly carrier: string;
  readonly account: {
    readonly accountRef: string;
    readonly authType: 'oauth' | 'api_key';
    readonly accountRevision: string;
  };
}
export interface PrepareMemberSession {
  readonly threadId: string;
  readonly catId: string;
  readonly contributionId: string;
  readonly identity: string;
  readonly accountSelection?: MemberAccountSelection;
  readonly memory: readonly MemberMemoryReference[];
}
export type CreateMemberSession = Omit<PrepareMemberSession, 'threadId'> & { readonly title: string };
/** Stable business identity for a protected thread. This is not an execution grant. */
export interface EnsureMemberThread {
  readonly catId: string;
  readonly contributionId: string;
  readonly identity: string;
  readonly title: string;
  readonly creationKey: string;
}
export interface MemberResourceDescription {
  readonly schema: 'host.member-resources.v1';
  readonly catId: string;
  readonly runtime?: Pick<MemberRuntimeSnapshot, 'clientId' | 'model' | 'carrier'>;
  readonly defaultAccountRef?: string;
  readonly available: boolean;
  readonly reason?: string;
  readonly accounts: readonly {
    readonly accountRef: string;
    readonly displayName: string;
    readonly authType: 'oauth' | 'api_key';
    readonly accountRevision?: string;
    readonly available: boolean;
    readonly reason?: string;
    readonly selection?: MemberAccountSelection;
  }[];
  readonly memory: readonly (MemberMemoryReference & { readonly bytes: number })[];
}
export interface MemberThreadBinding {
  readonly schema: 'host.member-thread.v1';
  readonly threadId: string;
  readonly sessionId: string;
  readonly ownerUserId: string;
  readonly pluginInstanceId: string;
  readonly catId: string;
  readonly creationDigest: string;
}
export interface MemberSessionScope {
  /** Host activation version; not supplied in prepare/execute business input. */
  readonly activationId?: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly ownerUserId: string;
  readonly assertCurrent: () => Promise<void>;
}
export interface MemberSessionGrant extends PrepareMemberSession {
  readonly activationId?: string;
  readonly schema: 'host.member-session.v1';
  readonly sessionId: string;
  readonly ownerUserId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly ownerRequestId: string;
  readonly prepareDigest: string;
  readonly generation: number;
  readonly revoked: boolean;
  readonly runtime: MemberRuntimeSnapshot;
  readonly consumedCursor: number;
  readonly hasConsumedInput: boolean;
  readonly executions: Readonly<Record<string, MemberSessionExecution>>;
}
export type MemberSessionRecord = MemberSessionGrant;
export interface ExecuteMemberSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly executionId: string;
  readonly semanticCursor: number;
  readonly content: string;
}
export interface MemberSessionExecution {
  readonly executionId: string;
  readonly inputDigest: string;
  readonly semanticCursor: number;
  readonly content: string;
  readonly phase: 'admitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  /** Durable admission fence. Legacy missing values leave dispatch uncertain. */
  readonly dispatchStarted?: boolean;
  /** Read-only Host proof for an archived generation; never a child outcome. */
  readonly admissionState?: 'not_dispatched';
  readonly messageId?: string;
  readonly invocationId?: string;
  readonly responseMessageId?: string;
}
export type MemberExecutionLookup = Pick<ExecuteMemberSession, 'sessionId' | 'generation' | 'executionId'>;
export type MemberSessionSummary = Omit<
  MemberSessionGrant,
  'executions' | 'prepareDigest' | 'ownerRequestId' | 'hasConsumedInput'
>;
export interface PluginMemberSessions {
  prepare(input: PrepareMemberSession): Promise<MemberSessionSummary>;
  execute(input: ExecuteMemberSession): Promise<MemberSessionExecution>;
  get(sessionId: string): Promise<MemberSessionSummary | null>;
  getExecution(input: MemberExecutionLookup): Promise<MemberSessionExecution | null>;
  revoke(sessionId: string): Promise<MemberSessionSummary>;
}
export interface MemberSessionWake {
  readonly threadId: string;
  readonly identity: string;
  readonly idempotencyKey: string;
  readonly content: string;
  readonly wake: { readonly catId: string; readonly exact: true };
}
export interface MemberSessionServices {
  /** Canonical direct-human source verification. Native callers cannot provide this verifier. */
  readonly assertOwnerDelegation?: (caller: PluginCallContext, scope: MemberSessionScope) => Promise<void>;
  readonly storage: Pick<PluginPrivateStoragePort, 'get' | 'compareAndSet'>;
  readonly canonicalExecution?: MemberCanonicalExecutionSources;
  readonly threadCreation?: {
    readonly store: Pick<IThreadStore, 'ensureOwnedThread'>;
    workspace(scope: MemberSessionScope, catId: string): Promise<string>;
  };
  readonly describeResources?: (catId: string, scope: MemberSessionScope) => Promise<MemberResourceDescription>;
  assertInstallation(scope: MemberSessionScope, contributionId: string): Promise<void>;
  assertThread(ownerUserId: string, threadId: string, catId: string): Promise<void>;
  resolveRuntime(
    input: PrepareMemberSession | MemberSessionGrant,
    scope: MemberSessionScope,
  ): Promise<MemberRuntimeSnapshot>;
  resolveMemory(
    ref: MemberMemoryReference,
    scope: MemberSessionScope & { catId: string },
  ): Promise<MemberMemoryReference & { readonly text: string }>;
  readonly messaging: {
    findSent(
      input: { threadId: string; idempotencyKey: string },
      scope: MemberSessionScope,
    ): Promise<{
      readonly threadId: string;
      readonly messageId: string;
      readonly content: string;
      readonly routedCatIds: readonly string[];
      readonly deliveryStatus?: 'queued' | 'delivered' | 'canceled';
    } | null>;
    /** The adapter must recheck scope.assertCurrent at actual admission after its awaits. */
    send(input: MemberSessionWake, scope: MemberSessionScope): Promise<unknown>;
  };
}
export type OwnerMemberRequest = Pick<PluginOwnerOperationContext, 'requestId' | 'assertCurrent'>;

/** Host-only coordinates; a package cannot choose a child or write its outcome. */
export interface MemberExecutionClaim {
  readonly sessionId: string;
  readonly generation: number;
  readonly executionId: string;
  readonly invocationId: string;
  readonly responseMessageId: string;
}
export interface MemberCanonicalExecutionSources {
  readonly turns: Pick<ITurnExecutionStore, 'get'> & Partial<Pick<ITurnExecutionStore, 'listBySource'>>;
  readonly messages: Pick<IMessageStore, 'getById'> & Partial<Pick<IMessageStore, 'getByIdempotencyKey'>>;
}
export interface HostMemberExecutions {
  claim(input: MemberExecutionClaim): Promise<MemberSessionExecution>;
  assertCurrent(input: MemberExecutionClaim): Promise<void>;
  /** Reads canonical terminal truth; accepts no caller-supplied status. */
  settle(input: MemberExecutionClaim): Promise<MemberSessionExecution>;
}
