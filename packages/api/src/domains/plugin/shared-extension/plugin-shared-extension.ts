import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { ExecutablePluginPackageRecord, PluginInstanceRecord } from '../host-inventory/types.js';

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

interface SharedExtensionState {
  readonly schemaVersion: 1;
  readonly bindings: readonly SharedBindingRecord[];
  /** Retain opaque pre-release records on disk; they grant no authority. */
  readonly proposals: readonly unknown[];
}

const EMPTY_STATE: SharedExtensionState = { schemaVersion: 1, bindings: [], proposals: [] };
const principalRecord = z.object({ kind: z.literal('cloud-cat'), logicalId: z.literal(SHARED_CAT_ID) }).strict();
const surfaceRecord = z
  .object({
    tools: z.array(toolDescriptor).max(MAX_TOOLS),
    events: z.array(eventDescriptor).max(MAX_EVENTS),
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
const persistedState = z
  .object({ schemaVersion: z.literal(1), bindings: z.array(bindingRecord), proposals: z.array(z.unknown()) })
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
    super(
      code === 'shared_surface_changed'
        ? `${code}: The legacy shared connection cannot authorize changed tools. Restore the previously approved plugin version and enable it again, or generate a Server URL in Dot settings, add that connection in ChatGPT and send its subscription message.`
        : code,
    );
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

function lineage(record: ExecutablePluginPackageRecord): string {
  const provenance = record.provenance;
  if (!provenance) return `digest:${record.packageDigest}`;
  if (provenance.kind === 'catalog') return `catalog:${provenance.catalogId}:${provenance.packageName}`;
  if (provenance.kind === 'git') return `git:${provenance.url}:${provenance.packageName ?? ''}`;
  return `${provenance.kind}:${provenance.packageName ?? ''}:${record.packageDigest}`;
}

export class PluginSharedExtensionService {
  private readonly now: () => number;

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
    },
  ) {
    this.now = options.now ?? Date.now;
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

  /** Preserve the pre-plugin shared /mcp behavior after the owner-fenced legacy import.
   * This is not exposed to packages: the migration coordinator supplies the verified
   * owner and exact package digest. The same installation is recovered only when the
   * published surface is byte-for-byte the already approved surface. */
  async adoptVerifiedLegacy(input: {
    readonly instanceId: string;
    readonly expectedPackageDigest: string;
    readonly ownerUserId: string;
    readonly evidenceRef: string;
    readonly assertCurrent?: () => void;
  }): Promise<SharedConnectionView | null> {
    input.assertCurrent?.();
    if (!(await this.availablePrincipal(input.ownerUserId))) return null;
    const key = bindingKey(input.ownerUserId);
    const observed = (await this.options.store.snapshot()).bindings.find((candidate) => recordKey(candidate) === key);
    const basis = await this.basis(input.instanceId);
    if (basis.packageRecord.pluginId !== 'official.chatgpt-dot') fail(403, 'legacy_dot_installation_required');
    if (basis.packageRecord.packageDigest !== input.expectedPackageDigest) fail(409, 'shared_installation_changed');
    const runtimeGeneration = basis.instance.lifecycleRevision;
    const surface = await this.surface(basis.instance);
    await this.basis(input.instanceId, basis.packageRecord.packageDigest, runtimeGeneration);
    if (!(await this.availablePrincipal(input.ownerUserId))) return null;
    const principal = { kind: 'cloud-cat' as const, logicalId: SHARED_CAT_ID };
    const result = await this.options.store.update((state) => {
      input.assertCurrent?.();
      const existing = state.bindings.find((candidate) => recordKey(candidate) === key);
      if (observed ? !existing || !sameBinding(existing, observed) : existing) fail(409, 'shared_slot_changed');
      if (
        existing &&
        existing.state !== 'revoked' &&
        (existing.lineage !== basis.lineage || existing.instanceId !== input.instanceId)
      ) {
        fail(409, 'shared_slot_occupied');
      }
      if (existing?.state === 'revoked') {
        return { state, result: this.view(existing, surface) };
      }
      if (existing && existing.approvedSurfaceDigest !== surface.digest) {
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
    if (result.binding.state === 'needs-confirmation') fail(409, 'shared_surface_changed');
    return result;
  }

  async handle(secret: string, rpc: Readonly<Record<string, unknown>>): Promise<unknown> {
    const verified = await this.options.keys.verify(secret);
    if (!verified.ok || verified.record.catId !== SHARED_CAT_ID) fail(403, 'shared_principal_rejected');
    const state = await this.options.store.snapshot();
    const binding = state.bindings.find((candidate) => recordKey(candidate) === bindingKey(verified.record.userId));
    if (!binding || binding.state === 'revoked') fail(404, 'shared_extension_not_bound');
    if (binding.state === 'needs-confirmation') fail(409, 'shared_surface_changed');
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
