import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginNativeActionTarget } from '../../cats/services/types.js';
import {
  FilePluginCapabilityKeyring,
  type IssuedPluginCapabilityToken,
} from '../capability-token/plugin-capability-token.js';
import { type PluginCallContext, withPluginCallContext } from '../carrier/plugin-call-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';

export class NativePluginActionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface NativeCredentialFile {
  readonly v: 1;
  readonly token: string;
  readonly tokenId: string;
  readonly instanceId: string;
  readonly capabilityId: string;
  readonly bootId: string;
  readonly activationId: string;
  readonly expiresAt: number;
  readonly refreshRecommendedAt: number;
}

interface Connection {
  readonly contributionId: string;
  readonly activationId: string;
  readonly credentialFile: string;
  currentToken: string;
  currentTokenId: string;
  currentExpiresAt: number;
  currentRefreshRecommendedAt: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

interface Binding {
  readonly instanceId: string;
  readonly admission: PluginRuntimeAdmission;
  readonly connections: ReadonlyMap<string, Connection>;
  readonly invoke: (method: string, input: unknown) => Promise<unknown>;
}

export interface NativePluginActionsOptions {
  readonly tokens?: FilePluginCapabilityKeyring;
  readonly credentialRoot?: string;
  readonly bootId?: string;
  readonly nativeTtlSeconds?: number;
  readonly refreshGraceMs?: number;
  readonly now?: () => number;
}

const temporaryRoots = new Set<string>();
let temporaryCleanupRegistered = false;

function defaultRuntimeRoot(): string {
  const root = join(tmpdir(), `clowder-plugin-native-${process.pid}-${randomUUID()}`);
  temporaryRoots.add(root);
  if (!temporaryCleanupRegistered) {
    temporaryCleanupRegistered = true;
    process.once('exit', () => {
      for (const candidate of temporaryRoots) rmSync(candidate, { recursive: true, force: true });
    });
  }
  return root;
}

function schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(1, delayMs));
  timer.unref?.();
  return timer;
}

/** A native MCP transport can call only actions belonging to its exact current local activation. */
export class NativePluginActions {
  readonly #bindings = new Map<string, Binding>();
  readonly #tokens = new Map<string, { readonly binding: Binding; readonly connection: Connection }>();
  readonly #generations = new Map<string, number>();
  readonly #tokensCodec: FilePluginCapabilityKeyring;
  readonly #credentialRoot: string;
  readonly #bootId: string;
  readonly #nativeTtlSeconds: number;
  readonly #refreshGraceMs: number;
  readonly #now: () => number;
  readonly #cleanupPreviousBoots: boolean;
  #prepareRoot?: Promise<void>;

  constructor(
    private readonly admission: (instanceId: string) => Promise<PluginRuntimeAdmission>,
    options: NativePluginActionsOptions = {},
  ) {
    const runtimeRoot = options.credentialRoot ?? defaultRuntimeRoot();
    this.#credentialRoot = runtimeRoot;
    this.#bootId = options.bootId ?? randomUUID();
    this.#tokensCodec =
      options.tokens ?? new FilePluginCapabilityKeyring({ path: join(runtimeRoot, 'capability-keyring.json') });
    this.#nativeTtlSeconds = options.nativeTtlSeconds ?? 60 * 60;
    this.#refreshGraceMs = options.refreshGraceMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#cleanupPreviousBoots = options.credentialRoot !== undefined;
  }

  generation(instanceId: string): number {
    if (!this.#generations.has(instanceId)) this.#generations.set(instanceId, 0);
    return this.#generations.get(instanceId) ?? 0;
  }

  async activate(admission: PluginRuntimeAdmission, generation: number, invoke: Binding['invoke']): Promise<void> {
    const instanceId = admission.instance.pluginInstanceId;
    if (generation !== this.generation(instanceId) || this.#bindings.has(instanceId)) {
      throw new NativePluginActionError(409, 'Plugin activation changed during startup');
    }
    await this.#ensureBootRoot();
    const connections = new Map<string, Connection>();
    try {
      for (const contribution of admission.packageRecord.manifest.contributions ?? []) {
        if (contribution.type !== 'mcp') continue;
        const activationId = randomUUID();
        const issued = await this.#tokensCodec.issueNative({
          instanceId,
          capabilityId: contribution.id,
          ttlSeconds: this.#nativeTtlSeconds,
          bootId: this.#bootId,
          activationId,
        });
        const credentialFile = this.#credentialPath(instanceId, contribution.id, activationId);
        await this.#writeCredential(credentialFile, instanceId, contribution.id, activationId, issued);
        connections.set(contribution.id, {
          contributionId: contribution.id,
          activationId,
          credentialFile,
          currentToken: issued.token,
          currentTokenId: issued.tokenId,
          currentExpiresAt: issued.expiresAt,
          currentRefreshRecommendedAt: issued.refreshRecommendedAt,
        });
      }
      if (generation !== this.generation(instanceId) || this.#bindings.has(instanceId)) {
        throw new NativePluginActionError(409, 'Plugin activation changed during startup');
      }
      const binding: Binding = {
        instanceId,
        admission: structuredClone(admission),
        connections,
        invoke,
      };
      this.#bindings.set(instanceId, binding);
      for (const connection of connections.values()) {
        this.#tokens.set(connection.currentToken, { binding, connection });
        process.env[this.environmentKey(instanceId, connection.contributionId, 'CREDENTIAL_FILE')] =
          connection.credentialFile;
        process.env[this.environmentKey(instanceId, connection.contributionId, 'PATH')] = '/api/plugin-runtime/action';
        this.#scheduleRefresh(binding, connection);
      }
    } catch (error) {
      await Promise.allSettled(
        [...connections.values()].map((connection) => rm(connection.credentialFile, { force: true })),
      );
      throw error;
    }
  }

  /** Resolve policy coordinates from the active Host-issued token, not package-supplied identity. */
  target(token: string): PluginNativeActionTarget | undefined {
    const active = this.#tokens.get(token);
    if (!active) return undefined;
    return Object.freeze({
      instanceId: active.binding.instanceId,
      contributionId: active.connection.contributionId,
    });
  }

  environment(instanceId: string, contributionId: string): Readonly<Record<string, string>> {
    const connection = this.#bindings.get(instanceId)?.connections.get(contributionId);
    if (!connection) return {};
    return {
      CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE: connection.credentialFile,
      CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
    };
  }

  /** Durable MCP registration stores a stable env reference; each request reads the current file. */
  environmentReferences(instanceId: string, contributionId: string): Readonly<Record<string, string>> {
    if (!this.#bindings.get(instanceId)?.connections.has(contributionId)) return {};
    return {
      CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE: `\${${this.environmentKey(instanceId, contributionId, 'CREDENTIAL_FILE')}}`,
      CLOWDER_PLUGIN_ACTION_PATH: `\${${this.environmentKey(instanceId, contributionId, 'PATH')}}`,
    };
  }

  private environmentKey(instanceId: string, contributionId: string, field: 'CREDENTIAL_FILE' | 'PATH'): string {
    const id = createHash('sha256')
      .update(JSON.stringify([instanceId, contributionId]))
      .digest('hex')
      .toUpperCase();
    return `CLOWDER_PLUGIN_${id}_ACTION_${field}`;
  }

  deactivate(instanceId: string): void {
    this.#generations.set(instanceId, this.generation(instanceId) + 1);
    const binding = this.#bindings.get(instanceId);
    if (binding) {
      for (const connection of binding.connections.values()) {
        if (connection.refreshTimer) clearTimeout(connection.refreshTimer);
        if (connection.graceTimer) clearTimeout(connection.graceTimer);
        for (const [token, active] of this.#tokens) {
          if (active.binding === binding && active.connection === connection) this.#tokens.delete(token);
        }
        rmSync(connection.credentialFile, { force: true });
        const fileKey = this.environmentKey(instanceId, connection.contributionId, 'CREDENTIAL_FILE');
        if (process.env[fileKey] === connection.credentialFile) delete process.env[fileKey];
      }
    }
    this.#bindings.delete(instanceId);
  }

  deactivateAll(): void {
    for (const id of new Set([...this.#generations.keys(), ...this.#bindings.keys()])) this.deactivate(id);
  }

  async call(token: string, method: string, input: unknown, caller: PluginCallContext): Promise<unknown> {
    const active = this.#tokens.get(token);
    if (!active) throw new NativePluginActionError(401, 'Plugin connection is not active');
    const { binding, connection } = active;
    try {
      await this.#tokensCodec.verifyNative(token, {
        instanceId: binding.instanceId,
        capabilityId: connection.contributionId,
        bootId: this.#bootId,
        activationId: connection.activationId,
      });
    } catch {
      throw new NativePluginActionError(401, 'Plugin connection is not active');
    }
    let finished = false;
    const checkCaller = caller.assertCurrent.bind(caller);
    const checkInvocation = (caller.assertInvocationCurrent ?? caller.assertCurrent).bind(caller);
    const assertActiveInvocation = () => {
      if (finished || this.#bindings.get(binding.instanceId) !== binding)
        throw new NativePluginActionError(409, 'Plugin call is no longer current');
    };
    const assertInvocationCurrent = async () => {
      assertActiveInvocation();
      await checkInvocation();
      assertActiveInvocation();
    };
    const assertCurrent = async () => {
      await assertInvocationCurrent();
      await checkCaller();
      const current = await this.admission(binding.instanceId);
      if (
        finished ||
        this.#bindings.get(binding.instanceId) !== binding ||
        current.instance.activationState !== 'enabled' ||
        current.instance.lifecycleState !== 'installed' ||
        current.instance.configReadiness !== 'ready' ||
        current.instance.packageDigest !== binding.admission.instance.packageDigest
      )
        throw new NativePluginActionError(409, 'Plugin call is no longer current');
      await checkCaller();
      await assertInvocationCurrent();
    };
    const checkWrite = caller.assertWriteCurrent?.bind(caller);
    const context = Object.freeze({
      ...caller,
      assertCurrent,
      assertInvocationCurrent,
      ...(checkWrite
        ? {
            assertWriteCurrent: () => {
              assertActiveInvocation();
              checkWrite();
            },
          }
        : {}),
      nativeAction: Object.freeze({ id: randomUUID(), contributionId: connection.contributionId, method }),
    });
    await assertCurrent();
    try {
      const result = await withPluginCallContext(binding.instanceId, context, () => binding.invoke(method, input));
      await assertCurrent();
      return result;
    } finally {
      finished = true;
    }
  }

  async #ensureBootRoot(): Promise<void> {
    if (!this.#prepareRoot) {
      this.#prepareRoot = (async () => {
        await mkdir(this.#credentialRoot, { recursive: true, mode: 0o700 });
        await chmod(this.#credentialRoot, 0o700);
        if (this.#cleanupPreviousBoots) {
          for (const entry of await readdir(this.#credentialRoot)) {
            if (entry !== this.#bootId) await rm(join(this.#credentialRoot, entry), { recursive: true, force: true });
          }
        }
        const bootRoot = join(this.#credentialRoot, this.#bootId);
        await mkdir(bootRoot, { recursive: true, mode: 0o700 });
        await chmod(bootRoot, 0o700);
      })();
    }
    return this.#prepareRoot;
  }

  #credentialPath(instanceId: string, contributionId: string, activationId: string): string {
    const name = createHash('sha256')
      .update(JSON.stringify([instanceId, contributionId, activationId]))
      .digest('hex');
    return join(this.#credentialRoot, this.#bootId, `${name}.json`);
  }

  async #writeCredential(
    path: string,
    instanceId: string,
    capabilityId: string,
    activationId: string,
    issued: IssuedPluginCapabilityToken,
  ): Promise<void> {
    const payload: NativeCredentialFile = {
      v: 1,
      token: issued.token,
      tokenId: issued.tokenId,
      instanceId,
      capabilityId,
      bootId: this.#bootId,
      activationId,
      expiresAt: issued.expiresAt,
      refreshRecommendedAt: issued.refreshRecommendedAt,
    };
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  #scheduleRefresh(binding: Binding, connection: Connection, retryAt?: number): void {
    if (connection.refreshTimer) clearTimeout(connection.refreshTimer);
    const target = retryAt ?? connection.currentRefreshRecommendedAt * 1_000;
    connection.refreshTimer = schedule(() => void this.#refresh(binding, connection), target - this.#now());
  }

  async #refresh(binding: Binding, connection: Connection): Promise<void> {
    if (this.#bindings.get(binding.instanceId) !== binding) return;
    try {
      const issued = await this.#tokensCodec.issueNative({
        instanceId: binding.instanceId,
        capabilityId: connection.contributionId,
        ttlSeconds: this.#nativeTtlSeconds,
        bootId: this.#bootId,
        activationId: connection.activationId,
      });
      if (this.#bindings.get(binding.instanceId) !== binding) return;
      this.#tokens.set(issued.token, { binding, connection });
      try {
        await this.#writeCredential(
          connection.credentialFile,
          binding.instanceId,
          connection.contributionId,
          connection.activationId,
          issued,
        );
      } catch (error) {
        this.#tokens.delete(issued.token);
        throw error;
      }
      if (this.#bindings.get(binding.instanceId) !== binding) {
        this.#tokens.delete(issued.token);
        rmSync(connection.credentialFile, { force: true });
        return;
      }
      const previousToken = connection.currentToken;
      connection.currentToken = issued.token;
      connection.currentTokenId = issued.tokenId;
      connection.currentExpiresAt = issued.expiresAt;
      connection.currentRefreshRecommendedAt = issued.refreshRecommendedAt;
      if (connection.graceTimer) clearTimeout(connection.graceTimer);
      connection.graceTimer = schedule(() => this.#tokens.delete(previousToken), this.#refreshGraceMs);
      this.#scheduleRefresh(binding, connection);
    } catch {
      if (this.#bindings.get(binding.instanceId) === binding && this.#now() < connection.currentExpiresAt * 1_000) {
        this.#scheduleRefresh(binding, connection, Math.min(connection.currentExpiresAt * 1_000, this.#now() + 30_000));
      }
    }
  }
}
