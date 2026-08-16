import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import QRCode from 'qrcode';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from './external-runtime/types.js';
import type { PluginInstanceRecord } from './host-inventory/types.js';
import type { OfficialPluginCatalogEntry, OfficialPluginOwnerAuth } from './official-catalog.js';
import {
  type OfficialPluginAuthCommandResult,
  type OfficialPluginAuthCommandSpec,
  officialPluginAuthCommandEnvironment,
  parseLarkCliJson,
  runOfficialPluginAuthCommand,
} from './official-plugin-auth-command.js';

const STATUS_TIMEOUT_MS = 30_000;
const DEFAULT_FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOW_TTL_MS = 15 * 60_000;

export type OfficialPluginAuthStatus = 'not_connected' | 'waiting' | 'connected' | 'expired' | 'failed';

export interface OfficialPluginAuthProjection {
  readonly status: OfficialPluginAuthStatus;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly qrDataUrl?: string;
  readonly error?: string;
}

export interface OfficialPluginAuthTarget {
  readonly entry: OfficialPluginCatalogEntry;
  readonly instance: PluginInstanceRecord;
}

export interface OfficialPluginAuthPort {
  status(target: OfficialPluginAuthTarget): Promise<OfficialPluginAuthProjection>;
  start(target: OfficialPluginAuthTarget): Promise<OfficialPluginAuthProjection>;
}

interface PrivateAuthFlow extends OfficialPluginAuthProjection {
  readonly status: 'waiting' | 'connected' | 'expired' | 'failed';
  readonly expiresAt: number;
  readonly abort: AbortController;
}

interface ActiveCompletion {
  readonly promise: Promise<void>;
}

export interface OfficialPluginAuthServiceOptions {
  readonly packages: VerifiedPluginPackageLocator;
  readonly run?: (spec: OfficialPluginAuthCommandSpec) => Promise<OfficialPluginAuthCommandResult>;
  readonly toQrDataUrl?: (verificationUrl: string) => Promise<string>;
  readonly now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 3) return undefined;
  const candidate = record(value);
  if (!candidate) return undefined;
  for (const key of keys) {
    if (key in candidate) return candidate[key];
  }
  for (const nested of Object.values(candidate)) {
    const found = findValue(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findString(value: unknown, keys: readonly string[]): string | undefined {
  const found = findValue(value, keys);
  return typeof found === 'string' && found.trim() ? found.trim() : undefined;
}

function boundedFlowTtl(value: unknown): number {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_FLOW_TTL_MS;
  return Math.min(Math.max(seconds * 1000, 30_000), MAX_FLOW_TTL_MS);
}

function projectFlow(flow: PrivateAuthFlow): OfficialPluginAuthProjection {
  return {
    status: flow.status,
    ...(flow.verificationUrl === undefined ? {} : { verificationUrl: flow.verificationUrl }),
    ...(flow.userCode === undefined ? {} : { userCode: flow.userCode }),
    ...(flow.qrDataUrl === undefined ? {} : { qrDataUrl: flow.qrDataUrl }),
    ...(flow.error === undefined ? {} : { error: flow.error }),
  };
}

function authSpec(entry: OfficialPluginCatalogEntry): OfficialPluginOwnerAuth {
  if (!entry.ownerAuth || entry.ownerAuth.kind !== 'lark-cli-device') {
    throw new Error('Official plugin does not declare owner authentication');
  }
  if (
    entry.ownerAuth.domains.length === 0 ||
    entry.ownerAuth.domains.some((domain) => !/^[a-z][a-z0-9_-]*$/.test(domain))
  ) {
    throw new Error('Official plugin declares invalid authentication domains');
  }
  return entry.ownerAuth;
}

async function verifiedRunner(pkg: VerifiedPluginPackage, declaredPath: string): Promise<string> {
  if (!declaredPath.trim() || isAbsolute(declaredPath)) throw new Error('Official plugin declares invalid auth runner');
  await pkg.verifyIntegrity();
  const runnerPath = resolve(pkg.rootDir, declaredPath);
  const escaped = relative(pkg.rootDir, runnerPath);
  if (!escaped || escaped.startsWith('..') || isAbsolute(escaped)) {
    throw new Error('Official plugin auth runner escapes the verified package');
  }
  const runnerStat = await stat(runnerPath);
  if (!runnerStat.isFile()) throw new Error('Official plugin auth runner is not a regular file');
  return runnerPath;
}

function validateVerificationUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'accounts.feishu.cn' && url.hostname !== 'accounts.larksuite.com')
  ) {
    throw new Error('lark-cli returned an unexpected verification URL');
  }
  return url;
}

function completionArgs(runnerPath: string, deviceCode: string): readonly string[] {
  return [runnerPath, 'auth', 'login', '--device-code', deviceCode, '--json'];
}

export class OfficialPluginAuthService implements OfficialPluginAuthPort {
  private readonly run: (spec: OfficialPluginAuthCommandSpec) => Promise<OfficialPluginAuthCommandResult>;
  private readonly toQrDataUrl: (verificationUrl: string) => Promise<string>;
  private readonly now: () => number;
  private readonly flows = new Map<string, PrivateAuthFlow>();
  private readonly starts = new Map<string, Promise<OfficialPluginAuthProjection>>();
  private readonly completions = new Map<string, ActiveCompletion>();

  constructor(private readonly options: OfficialPluginAuthServiceOptions) {
    this.run = options.run ?? runOfficialPluginAuthCommand;
    this.toQrDataUrl = options.toQrDataUrl ?? ((url) => QRCode.toDataURL(url, { width: 384, margin: 2 }));
    this.now = options.now ?? Date.now;
  }

  async status(target: OfficialPluginAuthTarget): Promise<OfficialPluginAuthProjection> {
    const active = this.flows.get(target.instance.pluginInstanceId);
    if (active?.status === 'waiting' && this.now() >= active.expiresAt) {
      active.abort.abort();
      const expired: PrivateAuthFlow = { ...active, status: 'expired', error: '认证链接已过期，请重新连接。' };
      this.flows.set(target.instance.pluginInstanceId, expired);
      return projectFlow(expired);
    }
    if (active?.status === 'connected') this.flows.delete(target.instance.pluginInstanceId);
    else if (active) return projectFlow(active);

    const spec = authSpec(target.entry);
    const pkg = await this.options.packages.resolveInstalledPackage(target.instance.packageDigest);
    try {
      const runnerPath = await verifiedRunner(pkg, spec.runnerPath);
      const result = await this.run({
        command: process.execPath,
        args: [runnerPath, 'auth', 'status', '--json', '--verify'],
        cwd: pkg.rootDir,
        env: officialPluginAuthCommandEnvironment(),
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      const payload = parseLarkCliJson(result.stdout);
      return { status: findValue(payload, ['verified']) === true ? 'connected' : 'not_connected' };
    } catch {
      return { status: 'not_connected' };
    } finally {
      await pkg.release();
    }
  }

  start(target: OfficialPluginAuthTarget): Promise<OfficialPluginAuthProjection> {
    const instanceId = target.instance.pluginInstanceId;
    const active = this.flows.get(instanceId);
    if (active?.status === 'waiting' && this.now() < active.expiresAt) return Promise.resolve(projectFlow(active));
    const pending = this.starts.get(instanceId);
    if (pending) return pending;
    const started = this.begin(target).finally(() => this.starts.delete(instanceId));
    this.starts.set(instanceId, started);
    return started;
  }

  private async begin(target: OfficialPluginAuthTarget): Promise<OfficialPluginAuthProjection> {
    const instanceId = target.instance.pluginInstanceId;
    const spec = authSpec(target.entry);
    const pkg = await this.options.packages.resolveInstalledPackage(target.instance.packageDigest);
    let handedToCompletion = false;
    try {
      const runnerPath = await verifiedRunner(pkg, spec.runnerPath);
      const domainArgs = spec.domains.flatMap((domain) => ['--domain', domain]);
      const initial = await this.run({
        command: process.execPath,
        args: [runnerPath, 'auth', 'login', ...domainArgs, '--no-wait', '--json'],
        cwd: pkg.rootDir,
        env: officialPluginAuthCommandEnvironment(),
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      const payload = parseLarkCliJson(initial.stdout);
      const deviceCode = findString(payload, ['device_code', 'deviceCode']);
      const verificationUrlRaw = findString(payload, [
        'verification_url',
        'verificationUrl',
        'verification_uri_complete',
      ]);
      if (!deviceCode || !verificationUrlRaw) throw new Error('lark-cli omitted device authorization fields');
      const verificationUrl = validateVerificationUrl(verificationUrlRaw);
      const userCode =
        findString(payload, ['user_code', 'userCode']) ?? verificationUrl.searchParams.get('user_code') ?? undefined;
      const ttl = boundedFlowTtl(findValue(payload, ['expires_in', 'expiresIn']));
      const abort = new AbortController();
      const flow: PrivateAuthFlow = {
        status: 'waiting',
        verificationUrl: verificationUrlRaw,
        ...(userCode === undefined ? {} : { userCode }),
        qrDataUrl: await this.toQrDataUrl(verificationUrlRaw),
        expiresAt: this.now() + ttl,
        abort,
      };
      this.flows.set(instanceId, flow);
      handedToCompletion = true;
      const promise = this.complete(instanceId, pkg, runnerPath, deviceCode, ttl, abort);
      this.completions.set(instanceId, { promise });
      void promise.then(
        () => this.completions.delete(instanceId),
        () => this.completions.delete(instanceId),
      );
      return projectFlow(flow);
    } catch (error) {
      this.flows.set(instanceId, {
        status: 'failed',
        error: '无法发起飞书认证，请稍后重试。',
        expiresAt: this.now(),
        abort: new AbortController(),
      });
      throw error;
    } finally {
      if (!handedToCompletion) await pkg.release();
    }
  }

  private async complete(
    instanceId: string,
    pkg: VerifiedPluginPackage,
    runnerPath: string,
    deviceCode: string,
    ttl: number,
    abort: AbortController,
  ): Promise<void> {
    try {
      await this.run({
        command: process.execPath,
        args: completionArgs(runnerPath, deviceCode),
        cwd: pkg.rootDir,
        env: officialPluginAuthCommandEnvironment(),
        timeoutMs: ttl,
        signal: abort.signal,
      });
      const current = this.flows.get(instanceId);
      if (current?.status === 'waiting') {
        this.flows.set(instanceId, {
          status: 'connected',
          expiresAt: current.expiresAt,
          abort: current.abort,
        });
      }
    } catch {
      const current = this.flows.get(instanceId);
      if (current?.status === 'waiting') {
        this.flows.set(instanceId, {
          ...current,
          status: this.now() >= current.expiresAt ? 'expired' : 'failed',
          error: this.now() >= current.expiresAt ? '认证链接已过期，请重新连接。' : '飞书认证未完成，请重试。',
        });
      }
    } finally {
      await pkg.release();
    }
  }

  async shutdown(): Promise<void> {
    for (const flow of this.flows.values()) flow.abort.abort();
    await Promise.allSettled([...this.completions.values()].map((completion) => completion.promise));
  }
}
