import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NamedAlphaRuntimeBoundary } from '../../../config/alpha-coordinates.js';
import {
  collectiveServiceEnvironment,
  isAlphaCollectiveEnvironment,
  isManagedCollectiveServiceRecord,
  isNonRuntimeCollectiveEnvironment,
  isPinnedCollectiveAlpha,
  validatedCollectiveBootstrapUrl,
} from '../../../config/collective-alpha-boundary.js';

import {
  configuredLocalCollectiveServiceUrl,
  isExistingFile,
  isLocalCollectiveServiceHealth,
  isMissingFile,
  type LocalCollectiveServiceHealth,
  type LocalCollectiveServiceSpawnSpec,
  readGitHubProviderReady,
  resolveLocalCollectiveServiceCliPath,
  spawnLocalCollectiveService,
  validateLocalCollectiveServiceUrl,
} from './local-collective-service-process.js';

const SERVICE_STATE_FILE = 'collective-service.json';
const BOOTSTRAP_LINK_FILE = 'owner-bootstrap.url';
const SERVICE_LOG_FILE = 'collective-service.log';
const MANAGED_MARKER_FILE = 'cat-cafe-managed.json';
const START_ATTEMPTS = 60;
const START_INTERVAL_MS = 250;

export type LocalCollectiveServiceState = 'not_created' | 'stopped' | 'starting' | 'setup_required' | 'ready' | 'error';

export interface LocalCollectiveServiceStatus {
  readonly state: LocalCollectiveServiceState;
  readonly serviceUrl: string;
  readonly dataDirectory: string;
  readonly serviceInstanceId?: string;
  readonly bootstrapNeeded?: boolean;
  readonly setupStep?: 'github_app' | 'owner_setup';
  readonly error?: string;
}

export interface LocalCollectiveServiceLaunch {
  readonly service: LocalCollectiveServiceStatus;
  readonly launchUrl: string;
}

interface LocalCollectiveServiceManagerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly frontendBaseUrl: string;
  /** Alpha may manage only the Service compiled in its own checkout and stored under that checkout. */
  readonly alphaRoot?: string;
  readonly namedAlphaBoundary?: NamedAlphaRuntimeBoundary;
  readonly dataDirectory?: string;
  readonly serviceUrl?: string;
  readonly cliPath?: string;
  readonly fetchImpl?: typeof fetch;
  readonly spawnProcess?: (spec: LocalCollectiveServiceSpawnSpec) => Promise<{ readonly pid: number }>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export class LocalCollectiveServiceManager {
  readonly #env: NodeJS.ProcessEnv;
  readonly #alphaRoot?: string;
  readonly #namedAlphaBoundary?: NamedAlphaRuntimeBoundary;
  readonly #frontendOrigin: string;
  readonly #dataDirectory: string;
  readonly #serviceUrl: string;
  readonly #cliPath: string;
  readonly #fetch: typeof fetch;
  readonly #spawnProcess: (spec: LocalCollectiveServiceSpawnSpec) => Promise<{ readonly pid: number }>;
  readonly #wait: (milliseconds: number) => Promise<void>;
  #startPromise: Promise<LocalCollectiveServiceLaunch> | undefined;

  constructor(options: LocalCollectiveServiceManagerOptions) {
    this.#env = options.env;
    this.#alphaRoot = options.alphaRoot ? resolve(options.alphaRoot) : undefined;
    this.#namedAlphaBoundary = options.namedAlphaBoundary;
    this.#frontendOrigin = new URL(options.frontendBaseUrl).origin;
    this.#dataDirectory = resolve(
      options.dataDirectory ??
        options.env.COLLECTIVE_SERVICE_DATA_DIR ??
        join(homedir(), '.cat-cafe', 'collective-service'),
    );
    this.#serviceUrl = validateLocalCollectiveServiceUrl(
      options.serviceUrl ?? configuredLocalCollectiveServiceUrl(options.env),
    );
    this.#cliPath = options.cliPath ?? resolveLocalCollectiveServiceCliPath();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#spawnProcess = options.spawnProcess ?? spawnLocalCollectiveService;
    this.#wait =
      options.wait ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  }

  async status(): Promise<LocalCollectiveServiceStatus> {
    if (this.#requiresAlphaBoundary() && !this.#isPinnedAlpha()) {
      return {
        state: 'error',
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
        error: 'Alpha Collective Service configuration does not match its isolated runtime boundary',
      };
    }
    if (this.#startPromise) {
      return { state: 'starting', serviceUrl: this.#serviceUrl, dataDirectory: this.#dataDirectory };
    }
    return this.#inspect();
  }

  async provision(): Promise<LocalCollectiveServiceLaunch> {
    this.#assertManagedLifecycle();
    if (this.#startPromise) return this.#startPromise;
    const current = await this.#inspect();
    if (current.state === 'ready' || current.state === 'setup_required') {
      await this.#recordManagedService();
      const launch = await this.#launchForStatus(current);
      if (launch) return launch;
      return this.#holdStartPromise(this.#waitForLaunch());
    }
    if (current.state === 'error') throw new Error(current.error ?? 'Local Collective Service is unavailable');
    await this.#recordManagedService();
    return this.#holdStartPromise(this.#startAndWait());
  }

  async #holdStartPromise(startPromise: Promise<LocalCollectiveServiceLaunch>): Promise<LocalCollectiveServiceLaunch> {
    this.#startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = undefined;
    }
  }

  async recover(): Promise<LocalCollectiveServiceStatus> {
    if (this.#requiresAlphaBoundary() && !this.#isPinnedAlpha()) return this.status();
    const current = await this.#inspect();
    if (current.state !== 'stopped' || !this.#canManageLifecycle() || !(await this.#isManagedService())) {
      return current;
    }
    try {
      return (await this.provision()).service;
    } catch (error) {
      return {
        state: 'error',
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
        error: error instanceof Error ? error.message : 'Local Collective Service recovery failed',
      };
    }
  }

  async #startAndWait(): Promise<LocalCollectiveServiceLaunch> {
    await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.#dataDirectory, 0o700);
    this.#assertManagedLifecycle();
    const isolatedAlpha = this.#isPinnedAlpha();
    await this.#spawnProcess({
      command: process.execPath,
      args: [this.#cliPath],
      env: collectiveServiceEnvironment({
        env: this.#env,
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
        frontendOrigin: this.#frontendOrigin,
        isolatedAlpha,
        namedAlpha: this.#namedAlphaBoundary,
      }),
      logPath: join(this.#dataDirectory, SERVICE_LOG_FILE),
      // Alpha shares its proven preview session; runtime retains its independent process group.
      detached: !isolatedAlpha,
    });
    return this.#waitForLaunch();
  }

  async #waitForLaunch(): Promise<LocalCollectiveServiceLaunch> {
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      const status = await this.#inspect();
      const launch = await this.#launchForStatus(status);
      if (launch) return launch;
      if (status.state === 'error') throw new Error(status.error ?? 'Local Collective Service startup failed');
      await this.#wait(START_INTERVAL_MS);
    }
    throw new Error(
      `Local Collective Service did not become ready; see ${join(this.#dataDirectory, SERVICE_LOG_FILE)}`,
    );
  }

  async #inspect(): Promise<LocalCollectiveServiceStatus> {
    let localServiceInstanceId: string | undefined;
    try {
      const raw = JSON.parse(await readFile(join(this.#dataDirectory, SERVICE_STATE_FILE), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid object');
      const candidate = (raw as Record<string, unknown>).serviceInstanceId;
      if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('missing serviceInstanceId');
      localServiceInstanceId = candidate;
    } catch (error) {
      if (!isMissingFile(error)) {
        return {
          state: 'error',
          serviceUrl: this.#serviceUrl,
          dataDirectory: this.#dataDirectory,
          error: 'Local Collective Service state is unreadable; no process was started',
        };
      }
    }

    const health = await this.#readHealth();
    if (!health) {
      return {
        state: localServiceInstanceId ? 'stopped' : 'not_created',
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
      };
    }
    if ('error' in health) {
      return {
        state: 'error',
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
        error: health.error,
      };
    }
    if (!localServiceInstanceId) {
      return {
        state: 'error',
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
        error: 'A different Collective Service is already using the managed local address',
      };
    }
    if (health.serviceInstanceId !== localServiceInstanceId) {
      return {
        state: 'error',
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
        serviceInstanceId: localServiceInstanceId,
        error: 'A different Collective Service is already using the managed local address',
      };
    }
    if (health.onboardingComplete) {
      return {
        state: 'ready',
        serviceUrl: this.#serviceUrl,
        dataDirectory: this.#dataDirectory,
        serviceInstanceId: localServiceInstanceId,
        bootstrapNeeded: health.bootstrapNeeded,
      };
    }
    return {
      state: 'setup_required',
      serviceUrl: this.#serviceUrl,
      dataDirectory: this.#dataDirectory,
      serviceInstanceId: localServiceInstanceId,
      bootstrapNeeded: health.bootstrapNeeded,
      setupStep: health.providerReady ? 'owner_setup' : 'github_app',
    };
  }

  async #readHealth(): Promise<LocalCollectiveServiceHealth | { readonly error: string } | undefined> {
    try {
      const healthResponse = await this.#fetch(new URL('/api/health', this.#serviceUrl), {
        signal: AbortSignal.timeout(1_500),
      });
      if (!healthResponse.ok) return { error: 'The managed local address is occupied by an unhealthy service' };
      const health = (await healthResponse.json()) as unknown;
      if (!isLocalCollectiveServiceHealth(health)) {
        return { error: 'A different service is using the managed local address' };
      }
      const providersResponse = await this.#fetch(new URL('/api/auth/providers', this.#serviceUrl), {
        signal: AbortSignal.timeout(1_500),
      });
      if (!providersResponse.ok) return { error: 'Collective Service login status is unavailable' };
      const providers = (await providersResponse.json()) as unknown;
      const providerReady = readGitHubProviderReady(providers);
      if (providerReady === undefined) return { error: 'Collective Service returned an invalid login status' };
      return { ...health, providerReady };
    } catch {
      return undefined;
    }
  }

  async #launchForStatus(status: LocalCollectiveServiceStatus): Promise<LocalCollectiveServiceLaunch | undefined> {
    if (status.state !== 'ready' && status.state !== 'setup_required') return undefined;
    const launchUrl = await this.#readLaunchUrl(status.bootstrapNeeded === true);
    return launchUrl ? { service: status, launchUrl } : undefined;
  }

  async #readLaunchUrl(requireBootstrap: boolean): Promise<string | undefined> {
    try {
      const candidate = (await readFile(join(this.#dataDirectory, BOOTSTRAP_LINK_FILE), 'utf8')).trim();
      return validatedCollectiveBootstrapUrl(candidate, this.#serviceUrl);
    } catch (error) {
      if (isMissingFile(error)) return requireBootstrap ? undefined : this.#serviceUrl;
      throw new Error('Local Collective Service bootstrap link is unreadable');
    }
  }

  async #recordManagedService(): Promise<void> {
    await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 });
    const markerPath = join(this.#dataDirectory, MANAGED_MARKER_FILE);
    const contents = `${JSON.stringify({ version: 1, serviceUrl: this.#serviceUrl })}\n`;
    try {
      await writeFile(markerPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!isExistingFile(error)) throw error;
      const existing = await readFile(markerPath, 'utf8');
      if (existing !== contents) throw new Error('Local Collective Service ownership record is invalid');
    }
    await chmod(markerPath, 0o600);
  }

  async #isManagedService(): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(join(this.#dataDirectory, MANAGED_MARKER_FILE), 'utf8')) as unknown;
      return isManagedCollectiveServiceRecord(marker, this.#serviceUrl);
    } catch {
      return false;
    }
  }

  #isPinnedAlpha(): boolean {
    return isPinnedCollectiveAlpha({
      env: this.#env,
      root: this.#alphaRoot,
      frontendOrigin: this.#frontendOrigin,
      dataDirectory: this.#dataDirectory,
      serviceUrl: this.#serviceUrl,
      cliPath: this.#cliPath,
      namedAlpha: this.#namedAlphaBoundary,
    });
  }

  #requiresAlphaBoundary(): boolean {
    return this.#namedAlphaBoundary !== undefined || isAlphaCollectiveEnvironment(this.#env);
  }

  #canManageLifecycle(): boolean {
    if (this.#namedAlphaBoundary && !this.#isPinnedAlpha()) return false;
    return this.#isPinnedAlpha() || !isNonRuntimeCollectiveEnvironment(this.#env, this.#alphaRoot);
  }

  #assertManagedLifecycle(): void {
    if (!this.#canManageLifecycle()) {
      throw new Error('Local Collective Service can only be created from the canonical runtime environment');
    }
  }
}
