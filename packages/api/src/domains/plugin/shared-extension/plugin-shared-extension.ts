import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OperationActionResult, PluginManifest } from '@clowder-ai/plugin-contract';
import { z } from 'zod';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { ExecutablePluginPackageRecord, PluginInstanceRecord } from '../host-inventory/types.js';

const PROPOSAL_TTL_MS = 5 * 60_000;
const MAX_SURFACE_BYTES = 512 * 1024;
const MAX_TOOLS = 32;
const MAX_EVENTS = 16;
const SHARED_CAT_ID = 'gpt-pro';
const SHARED_RPC_METHODS = new Set([
  'tools/list',
  'tools/call',
  'events/list',
  'events/subscribe',
  'events/unsubscribe',
]);

const toolDescriptor = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().max(256).optional(),
    description: z.string().max(16_384).optional(),
    inputSchema: z.object({ type: z.literal('object') }).passthrough(),
    outputSchema: z
      .object({ type: z.literal('object') })
      .passthrough()
      .optional(),
    annotations: z.record(z.unknown()).optional(),
    execution: z.record(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .strict();
const eventDescriptor = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(16_384).optional(),
    argumentsSchema: z.record(z.unknown()).optional(),
  })
  .passthrough();
const rpcEnvelope = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    result: z.record(z.unknown()).optional(),
    error: z.record(z.unknown()).optional(),
  })
  .passthrough();

export interface SharedOwnerContext {
  readonly userId: string;
  readonly sessionBindingId?: string;
  readonly operationKey: string;
  readonly actionId: string;
  readonly requestId: string;
  readonly confirmed?: boolean;
  assertWriteCurrent?(): void;
  assertCurrent(): void | Promise<void>;
}

export interface SharedConnectionView {
  readonly deployment:
    | { readonly state: 'configured'; readonly endpoint: string; readonly principal: string }
    | { readonly state: 'missing-endpoint'; readonly principal: string }
    | { readonly state: 'missing-principal' };
  readonly binding: {
    readonly state: 'unbound' | 'active' | 'needs-confirmation' | 'revoked' | 'occupied';
    readonly revision: number;
    readonly scope: { readonly tools: number; readonly events: number };
  };
}

export interface SharedProposalView {
  readonly proposalRef: string;
  readonly expiresAt: number;
  readonly presentation: SharedConfirmationRow;
  readonly connection: SharedConnectionView;
}

export interface SharedConfirmationRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly actions: readonly {
    readonly action: string;
    readonly label: string;
    readonly confirm: string;
    readonly input: { readonly proposalRef: string };
  }[];
}

interface SharedSurface {
  readonly tools: readonly z.infer<typeof toolDescriptor>[];
  readonly events: readonly z.infer<typeof eventDescriptor>[];
  readonly digest: string;
}

interface SharedBindingRecord {
  readonly ownerUserId: string;
  readonly principal: { readonly kind: 'cloud-cat'; readonly logicalId: string };
  readonly instanceId: string;
  readonly lineage: string;
  readonly packageDigest: string;
  readonly approvedSurfaceDigest: string;
  readonly surface: Omit<SharedSurface, 'digest'>;
  readonly revision: number;
  readonly state: 'active' | 'needs-confirmation' | 'revoked';
  readonly authorizedBy: string;
  readonly updatedAt: number;
}

interface SharedProposalRecord {
  readonly proposalRef: string;
  readonly ownerUserId: string;
  readonly principal: { readonly kind: 'cloud-cat'; readonly logicalId: string };
  readonly sessionBindingId: string;
  readonly operationKey: string;
  readonly confirmationActionId: string;
  readonly instanceId: string;
  readonly lineage: string;
  readonly packageDigest: string;
  readonly runtimeGeneration: number;
  readonly surface: SharedSurface;
  readonly expectedSlotRevision: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly state: 'pending' | 'committed' | 'cancelled';
  readonly producerRequestId: string;
  readonly canonicalPresentation: SharedConfirmationRow;
  readonly presentationReady: boolean;
}

interface SharedExtensionState {
  readonly schemaVersion: 1;
  readonly bindings: readonly SharedBindingRecord[];
  readonly proposals: readonly SharedProposalRecord[];
}

const EMPTY_STATE: SharedExtensionState = { schemaVersion: 1, bindings: [], proposals: [] };
const principalRecord = z.object({ kind: z.literal('cloud-cat'), logicalId: z.literal(SHARED_CAT_ID) }).strict();
const surfaceRecord = z
  .object({
    tools: z.array(toolDescriptor).max(MAX_TOOLS),
    events: z.array(eventDescriptor).max(MAX_EVENTS),
  })
  .strict();
const confirmationRowRecord = z
  .object({
    key: z.string(),
    label: z.string(),
    detail: z.string(),
    actions: z.array(
      z
        .object({
          action: z.string(),
          label: z.string(),
          confirm: z.string(),
          input: z.object({ proposalRef: z.string() }).strict(),
        })
        .strict(),
    ),
  })
  .strict();
const bindingRecord = z
  .object({
    ownerUserId: z.string().min(1),
    principal: principalRecord,
    instanceId: z.string().min(1),
    lineage: z.string().min(1),
    packageDigest: z.string().min(1),
    approvedSurfaceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    surface: surfaceRecord,
    revision: z.number().int().positive(),
    state: z.enum(['active', 'needs-confirmation', 'revoked']),
    authorizedBy: z.string().min(1),
    updatedAt: z.number().finite(),
  })
  .strict();
const proposalRecord = z
  .object({
    proposalRef: z.string().min(1),
    ownerUserId: z.string().min(1),
    principal: principalRecord,
    sessionBindingId: z.string().min(1),
    operationKey: z.string().min(1),
    confirmationActionId: z.string().min(1),
    instanceId: z.string().min(1),
    lineage: z.string().min(1),
    packageDigest: z.string().min(1),
    runtimeGeneration: z.number().int().nonnegative(),
    surface: surfaceRecord.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    expectedSlotRevision: z.number().int().nonnegative(),
    issuedAt: z.number().finite(),
    expiresAt: z.number().finite(),
    state: z.enum(['pending', 'committed', 'cancelled']),
    producerRequestId: z.string().min(1),
    canonicalPresentation: confirmationRowRecord,
    presentationReady: z.boolean(),
  })
  .strict();
const persistedState = z
  .object({ schemaVersion: z.literal(1), bindings: z.array(bindingRecord), proposals: z.array(proposalRecord) })
  .strict();

export interface PluginSharedExtensionStore {
  snapshot(): Promise<SharedExtensionState>;
  update<T>(
    operation: (state: SharedExtensionState) => { readonly state: SharedExtensionState; readonly result: T },
  ): Promise<T>;
}

function cloneState(state: SharedExtensionState): SharedExtensionState {
  return structuredClone(state);
}

export class MemoryPluginSharedExtensionStore implements PluginSharedExtensionStore {
  private state = cloneState(EMPTY_STATE);
  private queue = Promise.resolve();

  async snapshot(): Promise<SharedExtensionState> {
    await this.queue;
    return cloneState(this.state);
  }

  update<T>(
    operation: (state: SharedExtensionState) => { readonly state: SharedExtensionState; readonly result: T },
  ): Promise<T> {
    let result!: T;
    const run = this.queue.then(() => {
      const next = operation(cloneState(this.state));
      this.state = cloneState(next.state);
      result = next.result;
    });
    this.queue = run.catch(() => undefined);
    return run.then(() => structuredClone(result));
  }
}

const fileQueues = new Map<string, Promise<void>>();
function queueFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(path, settled);
  settled.finally(() => {
    if (fileQueues.get(path) === settled) fileQueues.delete(path);
  });
  return current;
}

export class FilePluginSharedExtensionStore implements PluginSharedExtensionStore {
  constructor(private readonly path: string) {}

  snapshot(): Promise<SharedExtensionState> {
    return queueFile(this.path, () => this.read());
  }

  update<T>(
    operation: (state: SharedExtensionState) => { readonly state: SharedExtensionState; readonly result: T },
  ): Promise<T> {
    return queueFile(this.path, async () => {
      const next = operation(await this.read());
      await this.write(next.state);
      return structuredClone(next.result);
    });
  }

  private async read(): Promise<SharedExtensionState> {
    try {
      const parsed = persistedState.safeParse(JSON.parse(await readFile(this.path, 'utf8')));
      if (!parsed.success) throw new Error('Invalid shared extension store');
      return cloneState(parsed.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneState(EMPTY_STATE);
      throw error;
    }
  }

  private async write(state: SharedExtensionState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export class PluginSharedExtensionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function fail(statusCode: number, code: string): never {
  throw new PluginSharedExtensionError(statusCode, code);
}

function assertApprovedRpc(binding: SharedBindingRecord, rpc: Readonly<Record<string, unknown>>): string {
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  if (!SHARED_RPC_METHODS.has(method)) fail(400, 'shared_method_not_approved');
  if (method === 'tools/call') {
    const name = (rpc.params as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !binding.surface.tools.some((candidate) => candidate.name === name)) {
      fail(400, 'shared_tool_not_approved');
    }
  }
  if (method === 'events/subscribe' || method === 'events/unsubscribe') {
    const name = (rpc.params as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !binding.surface.events.some((candidate) => candidate.name === name)) {
      fail(400, 'shared_event_not_approved');
    }
  }
  return method;
}

function sameBinding(left: SharedBindingRecord, right: SharedBindingRecord): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    left.principal.logicalId === right.principal.logicalId &&
    left.instanceId === right.instanceId &&
    left.lineage === right.lineage &&
    left.packageDigest === right.packageDigest &&
    left.approvedSurfaceDigest === right.approvedSurfaceDigest &&
    left.revision === right.revision &&
    left.state === right.state &&
    left.authorizedBy === right.authorizedBy
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function bindingKey(ownerUserId: string, logicalId = SHARED_CAT_ID): string {
  return `${ownerUserId}\u0000${logicalId}`;
}

function recordKey(record: Pick<SharedBindingRecord, 'ownerUserId' | 'principal'>): string {
  return bindingKey(record.ownerUserId, record.principal.logicalId);
}

function pruneProposals(state: SharedExtensionState, now: number): readonly SharedProposalRecord[] {
  const activeAuthorizations = new Set(
    state.bindings.filter((binding) => binding.state === 'active').map((binding) => binding.authorizedBy),
  );
  return state.proposals.filter(
    (proposal) => proposal.expiresAt > now || activeAuthorizations.has(proposal.proposalRef),
  );
}

function lineage(record: ExecutablePluginPackageRecord): string {
  const provenance = record.provenance;
  if (!provenance) return `digest:${record.packageDigest}`;
  if (provenance.kind === 'catalog') return `catalog:${provenance.catalogId}:${provenance.packageName}`;
  if (provenance.kind === 'git') return `git:${provenance.url}:${provenance.packageName ?? ''}`;
  return `${provenance.kind}:${provenance.packageName ?? ''}:${record.packageDigest}`;
}

type OperationField = Extract<NonNullable<PluginManifest['configuration']>[number], { readonly kind: 'operation' }>;

function operation(manifest: PluginManifest, key: string): OperationField | undefined {
  return manifest.configuration?.find(
    (field): field is OperationField => field.kind === 'operation' && field.key === key,
  );
}

function exact(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function surfaceSummary(surface: SharedSurface): string {
  const tools = surface.tools.length === 0 ? '无' : surface.tools.map((item) => item.name).join('、');
  const events = surface.events.length === 0 ? '无' : surface.events.map((item) => item.name).join('、');
  return `工具（${surface.tools.length}）：${tools}；事件（${surface.events.length}）：${events}`;
}

function assertOwnerWriteCurrent(owner: SharedOwnerContext): void {
  if (owner.assertWriteCurrent) owner.assertWriteCurrent();
  else void owner.assertCurrent();
}

export class PluginSharedExtensionService {
  private readonly now: () => number;
  private readonly generateRef: () => string;

  constructor(
    private readonly options: {
      readonly store: PluginSharedExtensionStore;
      readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
      readonly keys: {
        verify(
          secret: string,
        ): Promise<
          | { readonly ok: true; readonly record: { readonly catId: string; readonly userId: string } }
          | { readonly ok: false; readonly reason: string }
        >;
        list(filter: { readonly catId?: string; readonly userId?: string; readonly includeRevoked?: boolean }): Promise<
          readonly {
            readonly catId: string;
            readonly userId: string;
            readonly revokedAt?: number | null;
            readonly expiresAt?: number | null;
            readonly graceUntil?: number;
          }[]
        >;
      };
      readonly publicEndpoint: () => string | undefined;
      readonly handle: (instanceId: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>;
      readonly now?: () => number;
      readonly generateRef?: () => string;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.generateRef = options.generateRef ?? (() => `shared_${randomUUID().replaceAll('-', '')}`);
  }

  private async availablePrincipal(ownerUserId: string) {
    const keys = await this.options.keys.list({ catId: SHARED_CAT_ID, userId: ownerUserId });
    const now = this.now();
    return keys.some(
      (key) =>
        key.catId === SHARED_CAT_ID &&
        key.userId === ownerUserId &&
        (key.revokedAt === undefined || key.revokedAt === null) &&
        (key.graceUntil !== undefined
          ? now <= key.graceUntil
          : key.expiresAt === undefined || key.expiresAt === null || now <= key.expiresAt),
    )
      ? { kind: 'cloud-cat' as const, logicalId: SHARED_CAT_ID }
      : undefined;
  }

  private async principal(ownerUserId: string) {
    const principal = await this.availablePrincipal(ownerUserId);
    if (!principal) fail(409, 'shared_principal_unavailable');
    return principal;
  }

  private requireOwner(owner: SharedOwnerContext): asserts owner is SharedOwnerContext & { sessionBindingId: string } {
    if (!owner.userId || !owner.sessionBindingId) fail(403, 'shared_owner_session_required');
  }

  private async installationBasis(instanceId: string, expectedPackageDigest?: string, expectedRevision?: number) {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginInstanceId === instanceId && candidate.lifecycleState === 'installed',
    );
    const packageRecord = snapshot.packages.find(
      (candidate): candidate is ExecutablePluginPackageRecord =>
        candidate.packageDigest === instance?.packageDigest && candidate.manifest !== null,
    );
    if (
      !instance ||
      !packageRecord ||
      (expectedPackageDigest !== undefined && expectedPackageDigest !== packageRecord.packageDigest) ||
      (expectedRevision !== undefined && instance.lifecycleRevision !== expectedRevision)
    ) {
      fail(409, 'shared_installation_changed');
    }
    return { instance, packageRecord, lineage: lineage(packageRecord) };
  }

  private async basis(instanceId: string, expectedPackageDigest?: string, expectedRevision?: number) {
    const basis = await this.installationBasis(instanceId, expectedPackageDigest, expectedRevision);
    if (
      basis.instance.activationState !== 'enabled' ||
      !['healthy', 'degraded'].includes(basis.instance.runtimeState)
    ) {
      fail(409, 'shared_runtime_unavailable');
    }
    return basis;
  }

  private async call(instance: PluginInstanceRecord, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const result = await this.options.handle(instance.pluginInstanceId, {
      method: 'POST',
      headers: {},
      body,
    });
    const parsed = z.object({ status: z.number().int(), body: z.unknown() }).passthrough().safeParse(result);
    if (!parsed.success || parsed.data.status !== 200) fail(409, 'shared_runtime_unavailable');
    return parsed.data.body;
  }

  private async surface(instance: PluginInstanceRecord): Promise<SharedSurface> {
    const [toolsRaw, eventsRaw] = await Promise.all([
      this.call(instance, { jsonrpc: '2.0', id: 'shared-tools', method: 'tools/list', params: {} }),
      this.call(instance, { jsonrpc: '2.0', id: 'shared-events', method: 'events/list', params: {} }),
    ]);
    const toolsEnvelope = rpcEnvelope.safeParse(toolsRaw);
    const eventsEnvelope = rpcEnvelope.safeParse(eventsRaw);
    const tools = z
      .object({ resultType: z.literal('complete').optional(), tools: z.array(toolDescriptor).max(MAX_TOOLS) })
      .strict()
      .safeParse(toolsEnvelope.success && toolsEnvelope.data.result);
    const events = z
      .object({ resultType: z.literal('complete').optional(), events: z.array(eventDescriptor).max(MAX_EVENTS) })
      .strict()
      .safeParse(eventsEnvelope.success && eventsEnvelope.data.result);
    if (!tools.success || !events.success) fail(409, 'shared_surface_invalid');
    const sortedTools = [...tools.data.tools].sort((left, right) => left.name.localeCompare(right.name));
    const sortedEvents = [...events.data.events].sort((left, right) => left.name.localeCompare(right.name));
    if (
      new Set(sortedTools.map((item) => item.name)).size !== sortedTools.length ||
      new Set(sortedEvents.map((item) => item.name)).size !== sortedEvents.length ||
      Buffer.byteLength(JSON.stringify([sortedTools, sortedEvents])) > MAX_SURFACE_BYTES
    ) {
      fail(409, 'shared_surface_invalid');
    }
    return { tools: sortedTools, events: sortedEvents, digest: digest({ tools: sortedTools, events: sortedEvents }) };
  }

  private async assertDispatchAuthority(
    secret: string,
    binding: SharedBindingRecord,
    expectedRuntimeGeneration: number,
  ): Promise<PluginInstanceRecord> {
    const [basis, state, verified] = await Promise.all([
      this.basis(binding.instanceId),
      this.options.store.snapshot(),
      this.options.keys.verify(secret),
    ]);
    if (
      basis.lineage !== binding.lineage ||
      basis.packageRecord.packageDigest !== binding.packageDigest ||
      basis.instance.lifecycleRevision !== expectedRuntimeGeneration
    ) {
      fail(409, 'shared_installation_changed');
    }
    if (
      !verified.ok ||
      verified.record.catId !== SHARED_CAT_ID ||
      verified.record.userId !== binding.ownerUserId ||
      !state.bindings.some((candidate) => candidate.state === 'active' && sameBinding(candidate, binding))
    ) {
      fail(409, 'shared_slot_changed');
    }
    return basis.instance;
  }

  private deployment(principalAvailable: boolean): SharedConnectionView['deployment'] {
    if (!principalAvailable) return { state: 'missing-principal' };
    const endpoint = this.options.publicEndpoint();
    return endpoint
      ? { state: 'configured', endpoint, principal: SHARED_CAT_ID }
      : { state: 'missing-endpoint', principal: SHARED_CAT_ID };
  }

  private view(
    binding: SharedBindingRecord | undefined,
    surface?: SharedSurface,
    options: { readonly principalAvailable?: boolean; readonly occupied?: boolean } = {},
  ): SharedConnectionView {
    return {
      deployment: this.deployment(options.principalAvailable ?? true),
      binding: {
        state: options.occupied ? 'occupied' : (binding?.state ?? 'unbound'),
        revision: binding?.revision ?? 0,
        scope: {
          tools: surface?.tools.length ?? binding?.surface.tools.length ?? 0,
          events: surface?.events.length ?? binding?.surface.events.length ?? 0,
        },
      },
    };
  }

  private currentBinding(
    binding: SharedBindingRecord | undefined,
    instanceId: string,
    currentLineage: string,
    currentPackageDigest: string,
  ): { readonly binding?: SharedBindingRecord; readonly occupied: boolean } {
    if (!binding) return { occupied: false };
    if (binding.state === 'revoked') {
      return binding.instanceId === instanceId ? { binding, occupied: false } : { occupied: false };
    }
    if (binding.instanceId !== instanceId) return { occupied: true };
    if (binding.lineage !== currentLineage || binding.packageDigest !== currentPackageDigest) {
      return { binding: { ...binding, state: 'needs-confirmation' }, occupied: false };
    }
    return { binding, occupied: false };
  }

  async status(instanceId: string, owner: SharedOwnerContext): Promise<SharedConnectionView> {
    this.requireOwner(owner);
    await owner.assertCurrent();
    const principal = await this.availablePrincipal(owner.userId);
    if (!principal) return this.view(undefined, undefined, { principalAvailable: false });
    const [state, basis] = await Promise.all([this.options.store.snapshot(), this.installationBasis(instanceId)]);
    const binding = state.bindings.find(
      (candidate) => recordKey(candidate) === bindingKey(owner.userId, principal.logicalId),
    );
    const current = this.currentBinding(binding, instanceId, basis.lineage, basis.packageRecord.packageDigest);
    return this.view(current.binding, undefined, { occupied: current.occupied });
  }

  async prepare(
    instanceId: string,
    expectedPackage: ExecutablePluginPackageRecord,
    owner: SharedOwnerContext,
    input: { readonly confirmationActionId: string },
  ): Promise<SharedProposalView> {
    this.requireOwner(owner);
    await owner.assertCurrent();
    const principal = await this.availablePrincipal(owner.userId);
    if (!principal) {
      const connection = this.view(undefined, undefined, { principalAvailable: false });
      return {
        proposalRef: '',
        expiresAt: this.now(),
        presentation: {
          key: 'shared-principal-unavailable',
          label: '当前实例还没有可用的猫咖云端连接',
          detail: '登录 ChatGPT 不会自动建立连接。请先恢复原共享 /mcp 入口，再回来准备；当前不会生成配对或订阅说明。',
          actions: [],
        },
        connection,
      };
    }
    if (!this.options.publicEndpoint()) {
      return {
        proposalRef: '',
        expiresAt: this.now(),
        presentation: {
          key: 'shared-endpoint-unavailable',
          label: '当前实例还没有可用的猫咖云端入口',
          detail: '请由本实例主人恢复共享 /mcp 的公开 HTTPS 入口；当前不会发现插件能力、生成授权候选或创建配对。',
          actions: [],
        },
        connection: this.view(undefined),
      };
    }
    const basis = await this.basis(instanceId, expectedPackage.packageDigest);
    const runtimeGeneration = basis.instance.lifecycleRevision;
    const declared = operation(basis.packageRecord.manifest, owner.operationKey);
    const confirmation = declared?.actions.find(
      (candidate) =>
        candidate.id === input.confirmationActionId &&
        candidate.render === 'row' &&
        typeof candidate.confirm === 'string',
    );
    if (!declared || !confirmation) fail(400, 'shared_confirmation_action_invalid');
    const surface = await this.surface(basis.instance);
    const currentPrincipal = await this.availablePrincipal(owner.userId);
    if (!currentPrincipal || currentPrincipal.logicalId !== principal.logicalId) {
      return {
        proposalRef: '',
        expiresAt: this.now(),
        presentation: {
          key: 'shared-principal-unavailable',
          label: '当前实例还没有可用的猫咖云端连接',
          detail: '登录 ChatGPT 不会自动建立连接。请先恢复原共享 /mcp 入口，再回来准备；当前不会生成配对或订阅说明。',
          actions: [],
        },
        connection: this.view(undefined, undefined, { principalAvailable: false }),
      };
    }
    if (!this.options.publicEndpoint()) {
      return {
        proposalRef: '',
        expiresAt: this.now(),
        presentation: {
          key: 'shared-endpoint-unavailable',
          label: '当前实例还没有可用的猫咖云端入口',
          detail: '请由本实例主人恢复共享 /mcp 的公开 HTTPS 入口；当前不会发现插件能力、生成授权候选或创建配对。',
          actions: [],
        },
        connection: this.view(undefined),
      };
    }
    await this.basis(instanceId, basis.packageRecord.packageDigest, runtimeGeneration);
    await owner.assertCurrent();
    const now = this.now();
    const current = await this.options.store.snapshot();
    const slot = current.bindings.find(
      (candidate) => recordKey(candidate) === bindingKey(owner.userId, principal.logicalId),
    );
    const projected = this.currentBinding(slot, instanceId, basis.lineage, basis.packageRecord.packageDigest);
    const occupied = slot?.state === 'revoked' ? undefined : slot;
    if (occupied && occupied.instanceId !== instanceId) fail(409, 'shared_slot_occupied');
    if (
      occupied?.state === 'active' &&
      occupied.instanceId === instanceId &&
      occupied.packageDigest === basis.packageRecord.packageDigest &&
      occupied.approvedSurfaceDigest === surface.digest
    ) {
      return {
        proposalRef: '',
        expiresAt: now,
        presentation: {
          key: 'already-bound',
          label: '已连接到现有猫咖云端连接',
          detail: `已批准 ${surfaceSummary(surface)}。`,
          actions: [],
        },
        connection: this.view(projected.binding, surface, { occupied: projected.occupied }),
      };
    }
    const proposalRef = this.generateRef();
    const canonicalPresentation: SharedConfirmationRow = {
      key: proposalRef,
      label: '连接到现有猫咖云端连接',
      detail: `将公开此安装的 ${surfaceSummary(surface)}；插件不能读取猫咖连接凭据。`,
      actions: [
        {
          action: input.confirmationActionId,
          label: confirmation.label,
          confirm: `确认把当前安装的 ${surfaceSummary(surface)}，连接到现有猫咖云端连接？`,
          input: { proposalRef },
        },
      ],
    };
    const proposal: SharedProposalRecord = {
      proposalRef,
      ownerUserId: owner.userId,
      principal,
      sessionBindingId: owner.sessionBindingId,
      operationKey: owner.operationKey,
      confirmationActionId: input.confirmationActionId,
      instanceId,
      lineage: basis.lineage,
      packageDigest: basis.packageRecord.packageDigest,
      runtimeGeneration,
      surface,
      expectedSlotRevision: slot?.revision ?? 0,
      issuedAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
      state: 'pending',
      producerRequestId: owner.requestId,
      canonicalPresentation,
      presentationReady: false,
    };
    await this.options.store.update((state) => {
      assertOwnerWriteCurrent(owner);
      if (!this.options.publicEndpoint()) fail(409, 'shared_endpoint_unavailable');
      return { state: { ...state, proposals: [...pruneProposals(state, now), proposal] }, result: undefined };
    });
    await owner.assertCurrent();
    return {
      proposalRef,
      expiresAt: proposal.expiresAt,
      presentation: canonicalPresentation,
      connection: this.view(projected.binding, surface, { occupied: projected.occupied }),
    };
  }

  async validatePresentation(input: {
    readonly instanceId: string;
    readonly owner: SharedOwnerContext;
    readonly result: OperationActionResult;
  }): Promise<void> {
    this.requireOwner(input.owner);
    await input.owner.assertCurrent();
    await this.options.store.update((state) => {
      assertOwnerWriteCurrent(input.owner);
      const scoped = state.proposals.filter(
        (proposal) =>
          proposal.instanceId === input.instanceId &&
          proposal.ownerUserId === input.owner.userId &&
          proposal.sessionBindingId === input.owner.sessionBindingId &&
          proposal.operationKey === input.owner.operationKey,
      );
      const candidates = scoped.filter(
        (proposal) => proposal.state === 'pending' && proposal.producerRequestId === input.owner.requestId,
      );
      const rowsData =
        input.result.render === 'rows' &&
        input.result.data &&
        typeof input.result.data === 'object' &&
        Array.isArray((input.result.data as { rows?: unknown }).rows)
          ? (input.result.data as { rows: unknown[]; validUntil?: unknown })
          : undefined;
      const rows = rowsData?.rows ?? [];
      const actions = rows.flatMap((row) => {
        if (!row || typeof row !== 'object' || !Array.isArray((row as { actions?: unknown }).actions)) return [];
        return (row as { actions: unknown[] }).actions.filter(
          (action): action is { action?: unknown; input?: { proposalRef?: unknown } } =>
            Boolean(action) && typeof action === 'object',
        );
      });
      const scopedActionIds = new Set(scoped.map((proposal) => proposal.confirmationActionId));
      const referencesSharedConfirmation = actions.some(
        (action) =>
          (typeof action.action === 'string' && scopedActionIds.has(action.action)) ||
          typeof action.input?.proposalRef === 'string',
      );
      if (candidates.length === 0) {
        if (referencesSharedConfirmation) fail(502, 'invalid_shared_confirmation_presentation');
        return { state, result: undefined };
      }
      if (
        !referencesSharedConfirmation ||
        candidates.length !== rows.length ||
        candidates.some((proposal) => rowsData?.validUntil !== proposal.expiresAt) ||
        candidates.some((proposal) => !rows.some((row) => exact(row, proposal.canonicalPresentation)))
      ) {
        fail(502, 'invalid_shared_confirmation_presentation');
      }
      return {
        state: {
          ...state,
          proposals: state.proposals.map((proposal) =>
            candidates.some((candidate) => candidate.proposalRef === proposal.proposalRef)
              ? { ...proposal, presentationReady: true }
              : proposal,
          ),
        },
        result: undefined,
      };
    });
    await input.owner.assertCurrent();
  }

  async bind(
    instanceId: string,
    expectedPackage: ExecutablePluginPackageRecord,
    owner: SharedOwnerContext,
    proposalRef: string,
  ): Promise<SharedConnectionView> {
    this.requireOwner(owner);
    if (!owner.confirmed) fail(403, 'shared_owner_confirmation_required');
    await owner.assertCurrent();
    const principal = await this.principal(owner.userId);
    if (!this.options.publicEndpoint()) fail(409, 'shared_endpoint_unavailable');
    const basis = await this.basis(instanceId, expectedPackage.packageDigest);
    const runtimeGeneration = basis.instance.lifecycleRevision;
    const surface = await this.surface(basis.instance);
    await this.basis(instanceId, basis.packageRecord.packageDigest, runtimeGeneration);
    const now = this.now();
    const result = await this.options.store.update((state) => {
      assertOwnerWriteCurrent(owner);
      if (!this.options.publicEndpoint()) fail(409, 'shared_endpoint_unavailable');
      const proposal = state.proposals.find((candidate) => candidate.proposalRef === proposalRef);
      if (!proposal) fail(409, 'shared_proposal_missing');
      const matches =
        proposal.ownerUserId === owner.userId &&
        proposal.principal.logicalId === principal.logicalId &&
        proposal.sessionBindingId === owner.sessionBindingId &&
        proposal.operationKey === owner.operationKey &&
        proposal.confirmationActionId === owner.actionId &&
        proposal.instanceId === instanceId &&
        proposal.lineage === basis.lineage &&
        proposal.packageDigest === basis.packageRecord.packageDigest &&
        proposal.runtimeGeneration === runtimeGeneration &&
        proposal.surface.digest === surface.digest;
      const key = bindingKey(owner.userId, principal.logicalId);
      const existing = state.bindings.find((candidate) => recordKey(candidate) === key);
      if (
        matches &&
        proposal.presentationReady &&
        proposal.state === 'committed' &&
        existing?.state === 'active' &&
        existing.authorizedBy === proposalRef &&
        existing.instanceId === instanceId &&
        existing.packageDigest === basis.packageRecord.packageDigest &&
        existing.approvedSurfaceDigest === surface.digest
      ) {
        return { state, result: this.view(existing, surface) };
      }
      if (!matches || !proposal.presentationReady || proposal.expiresAt <= now || proposal.state !== 'pending') {
        fail(409, 'shared_proposal_stale');
      }
      if ((existing?.revision ?? 0) !== proposal.expectedSlotRevision) fail(409, 'shared_slot_contended');
      const binding: SharedBindingRecord = {
        ownerUserId: owner.userId,
        principal,
        instanceId,
        lineage: basis.lineage,
        packageDigest: basis.packageRecord.packageDigest,
        approvedSurfaceDigest: surface.digest,
        surface: { tools: surface.tools, events: surface.events },
        revision: (existing?.revision ?? 0) + 1,
        state: 'active',
        authorizedBy: proposalRef,
        updatedAt: now,
      };
      return {
        state: {
          ...state,
          bindings: [...state.bindings.filter((candidate) => recordKey(candidate) !== key), binding],
          proposals: state.proposals.map((candidate) =>
            candidate.proposalRef === proposalRef ? { ...candidate, state: 'committed' } : candidate,
          ),
        },
        result: this.view(binding, surface),
      };
    });
    await owner.assertCurrent();
    return result;
  }

  /** Preserve the pre-plugin shared /mcp behavior after the owner-fenced legacy import.
   * This is not exposed to packages: the migration coordinator supplies the verified
   * owner and exact package digest. A same-lineage reinstall is adopted only when the
   * published surface is byte-for-byte the already approved surface. */
  async adoptVerifiedLegacy(input: {
    readonly instanceId: string;
    readonly expectedPackageDigest: string;
    readonly ownerUserId: string;
    readonly evidenceRef: string;
  }): Promise<SharedConnectionView | null> {
    if (!(await this.availablePrincipal(input.ownerUserId))) return null;
    const basis = await this.basis(input.instanceId);
    if (basis.packageRecord.packageDigest !== input.expectedPackageDigest) fail(409, 'shared_installation_changed');
    const runtimeGeneration = basis.instance.lifecycleRevision;
    const surface = await this.surface(basis.instance);
    await this.basis(input.instanceId, basis.packageRecord.packageDigest, runtimeGeneration);
    const principal = { kind: 'cloud-cat' as const, logicalId: SHARED_CAT_ID };
    return this.options.store.update((state) => {
      const key = bindingKey(input.ownerUserId, principal.logicalId);
      const existing = state.bindings.find((candidate) => recordKey(candidate) === key);
      if (existing && existing.state !== 'revoked' && existing.lineage !== basis.lineage) {
        fail(409, 'shared_slot_occupied');
      }
      if (existing?.state === 'revoked') {
        return { state, result: this.view(existing, surface) };
      }
      if (existing?.state === 'needs-confirmation') {
        if (existing.instanceId === input.instanceId && existing.packageDigest === basis.packageRecord.packageDigest) {
          return { state, result: this.view(existing, surface) };
        }
        const changed: SharedBindingRecord = {
          ...existing,
          instanceId: input.instanceId,
          lineage: basis.lineage,
          packageDigest: basis.packageRecord.packageDigest,
          revision: existing.revision + 1,
          updatedAt: this.now(),
        };
        return {
          state: {
            ...state,
            bindings: [...state.bindings.filter((candidate) => recordKey(candidate) !== key), changed],
          },
          result: this.view(changed, surface),
        };
      }
      if (existing?.state === 'active' && existing.approvedSurfaceDigest !== surface.digest) {
        const changed: SharedBindingRecord = {
          ...existing,
          instanceId: input.instanceId,
          lineage: basis.lineage,
          packageDigest: basis.packageRecord.packageDigest,
          state: 'needs-confirmation',
          revision: existing.revision + 1,
          updatedAt: this.now(),
        };
        return {
          state: {
            ...state,
            bindings: [...state.bindings.filter((candidate) => recordKey(candidate) !== key), changed],
          },
          result: this.view(changed, surface),
        };
      }
      const binding: SharedBindingRecord = {
        ownerUserId: input.ownerUserId,
        principal,
        instanceId: input.instanceId,
        lineage: basis.lineage,
        packageDigest: basis.packageRecord.packageDigest,
        approvedSurfaceDigest: surface.digest,
        surface: { tools: surface.tools, events: surface.events },
        revision: (existing?.revision ?? 0) + 1,
        state: 'active',
        authorizedBy: input.evidenceRef,
        updatedAt: this.now(),
      };
      return {
        state: { ...state, bindings: [...state.bindings.filter((candidate) => recordKey(candidate) !== key), binding] },
        result: this.view(binding, surface),
      };
    });
  }

  async unbind(instanceId: string, owner: SharedOwnerContext, expectedRevision: number): Promise<SharedConnectionView> {
    this.requireOwner(owner);
    if (!owner.confirmed) fail(403, 'shared_owner_confirmation_required');
    await owner.assertCurrent();
    const principal = await this.principal(owner.userId);
    const result = await this.options.store.update((state) => {
      assertOwnerWriteCurrent(owner);
      const key = bindingKey(owner.userId, principal.logicalId);
      const existing = state.bindings.find((candidate) => recordKey(candidate) === key);
      if (!existing || existing.instanceId !== instanceId || existing.revision !== expectedRevision) {
        fail(409, 'shared_slot_changed');
      }
      const revoked: SharedBindingRecord = {
        ...existing,
        revision: existing.revision + 1,
        state: 'revoked',
        updatedAt: this.now(),
      };
      return {
        state: { ...state, bindings: [...state.bindings.filter((candidate) => recordKey(candidate) !== key), revoked] },
        result: this.view(revoked),
      };
    });
    await owner.assertCurrent();
    return result;
  }

  async handle(secret: string, rpc: Readonly<Record<string, unknown>>): Promise<unknown> {
    const verified = await this.options.keys.verify(secret);
    if (!verified.ok || verified.record.catId !== SHARED_CAT_ID) fail(403, 'shared_principal_rejected');
    const state = await this.options.store.snapshot();
    const binding = state.bindings.find(
      (candidate) => recordKey(candidate) === bindingKey(verified.record.userId) && candidate.state === 'active',
    );
    if (!binding) fail(404, 'shared_extension_not_bound');
    assertApprovedRpc(binding, rpc);
    const basis = await this.basis(binding.instanceId);
    const runtimeGeneration = basis.instance.lifecycleRevision;
    if (basis.lineage !== binding.lineage || basis.packageRecord.packageDigest !== binding.packageDigest) {
      fail(409, 'shared_installation_changed');
    }
    const surface = await this.surface(basis.instance);
    if (surface.digest !== binding.approvedSurfaceDigest) {
      await this.options.store.update((current) => ({
        state: {
          ...current,
          bindings: current.bindings.map((candidate) =>
            sameBinding(candidate, binding)
              ? { ...candidate, state: 'needs-confirmation', revision: candidate.revision + 1, updatedAt: this.now() }
              : candidate,
          ),
        },
        result: undefined,
      }));
      fail(409, 'shared_surface_changed');
    }
    const currentInstance = await this.assertDispatchAuthority(secret, binding, runtimeGeneration);
    const response = await this.call(currentInstance, rpc);
    await this.assertDispatchAuthority(secret, binding, runtimeGeneration);
    return response;
  }
}
