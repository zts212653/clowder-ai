/**
 * F247 Workspace Agent (R1/R3 rework): server-side config custody with an
 * explicit persisted state machine.
 *
 * States (from the persisted settings file only):
 *   absent   — no file: env bootstrap MAY activate the transport.
 *   enabled  — file present, valid, enabled: the file owns the transport.
 *   disabled — file present, explicitly disabled (including the env-only
 *              disable tombstone): env bootstrap is SUPPRESSED and the
 *              stored token (if any) survives for re-enable.
 *   invalid  — file present but corrupt / schema-invalid: the transport is
 *              off, env bootstrap is SUPPRESSED, and the projection exposes
 *              a recoverable configuration error. Never silently re-enable
 *              old env credentials (astra R1).
 *
 * Segment constraints (trigger id / workspace id) are shared with the
 * conversation-key builder so a value that saves successfully can always
 * build a valid conversation key at dispatch time (astra R3).
 *
 * The access token lives ONLY here: mode-0600 JSON, atomic tmp+rename
 * writes, env bootstrap fallback. Projections never return the token.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isWorkspaceAgentConversationKeySegment } from './conversation-key.js';
import {
  type IWorkspaceAgentTriggerAdapter,
  WorkspaceAgentTriggerError,
  WorkspaceAgentTriggerHttpAdapter,
} from './workspace-agent-trigger-adapter.js';

const CONFIG_FILENAME = 'workspace-agent.json';
const ENV_TRIGGER_ID = 'CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID';
const ENV_WORKSPACE_ID = 'CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID';
const ENV_TOKEN = 'CAT_CAFE_WORKSPACE_AGENT_TOKEN';
const TRIGGER_ID_PATTERN = /^[A-Za-z0-9_:-]{1,200}$/;

export interface WorkspaceAgentResolvedConfig {
  readonly triggerId: string;
  readonly workspaceId: string;
  readonly token: string;
  /** Where the active config came from — for owner-facing status only. */
  readonly source: 'settings' | 'env';
}

export interface WorkspaceAgentConfigProjection {
  readonly enabled: boolean;
  readonly triggerId: string | null;
  readonly workspaceId: string | null;
  readonly tokenConfigured: boolean;
  readonly source: 'settings' | 'env' | null;
  /**
   * Present when configuration exists but is unusable (recoverable):
   * corrupt/unreadable settings file, schema-invalid persisted record, or a
   * complete env triple that fails the shared constraints (astra R1/R3a).
   */
  readonly invalidConfig?: {
    readonly reason: 'corrupt_file' | 'unreadable_file' | 'schema_invalid' | 'env_invalid';
  };
}

export interface WorkspaceAgentConfigStore {
  /** Active config, or null when disabled/unconfigured/invalid. Token never logged. */
  resolve(): WorkspaceAgentResolvedConfig | null;
  /** Owner-facing projection — never includes the token value. */
  project(): WorkspaceAgentConfigProjection;
  /** Persist config (Settings). Atomic; preserves token when omitted. */
  save(input: {
    triggerId?: string;
    workspaceId?: string;
    token?: string;
    enabled?: boolean;
  }): WorkspaceAgentConfigProjection;
  /** Disable without losing the stored token (re-enable path). Persists even with no prior file. */
  disable(): WorkspaceAgentConfigProjection;
  readonly configPath: string;
}

interface PersistedShape {
  triggerId: string;
  workspaceId: string;
  token: string;
  enabled: boolean;
  updatedAt: string;
}

type PersistedState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'enabled'; readonly value: PersistedShape }
  | { readonly kind: 'disabled'; readonly value: PersistedShape }
  | { readonly kind: 'invalid'; readonly reason: 'corrupt_file' | 'unreadable_file' | 'schema_invalid' };

export interface WorkspaceAgentConfigDeps {
  readonly projectRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: { warn(ctx: object, msg: string): void; info(ctx: object, msg: string): void };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A persisted file is schema-valid when a disabled tombstone carries empty
 * fields (written by disable() before any save) or an enabled record
 * carries the full validated triple.
 */
function parsePersisted(raw: string): PersistedState {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { kind: 'invalid', reason: 'corrupt_file' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'schema_invalid' };
  }
  const enabled = parsed.enabled === true;
  const hasFields = isNonEmpty(parsed.triggerId) && isNonEmpty(parsed.workspaceId) && isNonEmpty(parsed.token);
  if (enabled && !hasFields) return { kind: 'invalid', reason: 'schema_invalid' };
  if (!enabled && !hasFields && parsed.enabled !== false) return { kind: 'invalid', reason: 'schema_invalid' };
  const value: PersistedShape = {
    triggerId: typeof parsed.triggerId === 'string' ? parsed.triggerId : '',
    workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : '',
    token: typeof parsed.token === 'string' ? parsed.token : '',
    enabled,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
  // Saved values must satisfy the same segment rules the dispatch path
  // enforces (astra R3) — otherwise the config is unusable, not active.
  if (
    (hasFields || value.triggerId || value.workspaceId) &&
    ((value.triggerId !== '' && !TRIGGER_ID_PATTERN.test(value.triggerId)) ||
      (value.workspaceId !== '' && !isWorkspaceAgentConversationKeySegment(value.workspaceId)))
  ) {
    return { kind: 'invalid', reason: 'schema_invalid' };
  }
  return { kind: enabled ? 'enabled' : 'disabled', value };
}

/**
 * astra R1: read directly — only a confirmed ENOENT means the file is
 * absent (env bootstrap permitted). Any other filesystem failure (EACCES,
 * ENOTDIR, EISDIR, …) means the state is UNREADABLE, which suppresses env
 * bootstrap and projects a recoverable error; an exists-check would fold
 * permission faults into "absent" and resurrect disabled env credentials.
 */
function readPersisted(path: string): PersistedState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', reason: 'unreadable_file' };
  }
  return parsePersisted(raw);
}

function atomicWrite(path: string, value: PersistedShape, logger: WorkspaceAgentConfigDeps['logger']): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  logger?.info({ configPath: path }, 'F247 workspace-agent config persisted (token not logged)');
}

export function createWorkspaceAgentTriggerConfig(deps: WorkspaceAgentConfigDeps): WorkspaceAgentConfigStore {
  const configPath = join(deps.projectRoot, '.cat-cafe', CONFIG_FILENAME);
  const env = deps.env ?? {};
  let cached: PersistedState | undefined;

  const load = (): PersistedState => {
    if (cached === undefined) cached = readPersisted(configPath);
    return cached;
  };

  /**
   * astra round-5 R1 — the single inheritance authority: env credentials are
   * inheritable by save()/disable() ONLY when env is the ACTIVE config,
   * i.e. the persisted file is absent AND the complete env triple is valid.
   * Disabled tombstones and invalid/unreadable files suppress env not only
   * for dispatch but for inheritance; recovery from those states always
   * requires an explicit complete save.
   */
  const activeEnvForInheritance = (): WorkspaceAgentResolvedConfig | null => {
    if (load().kind !== 'absent') return null;
    const candidate = envConfig();
    return candidate && candidate !== 'invalid' ? candidate : null;
  };

  /**
   * astra R3a: a COMPLETE env triple must pass the same constraints as
   * save()/persisted parsing — returns 'invalid' (config error state, never
   * dispatched, never a network-unknown) instead of activating. A partial
   * triple stays simply unconfigured.
   */
  const envConfig = (): WorkspaceAgentResolvedConfig | 'invalid' | null => {
    const envTriggerId = env[ENV_TRIGGER_ID];
    const envWorkspaceId = env[ENV_WORKSPACE_ID];
    const envToken = env[ENV_TOKEN];
    if (!isNonEmpty(envTriggerId) || !isNonEmpty(envWorkspaceId) || !isNonEmpty(envToken)) return null;
    if (!TRIGGER_ID_PATTERN.test(envTriggerId) || !isWorkspaceAgentConversationKeySegment(envWorkspaceId)) {
      return 'invalid';
    }
    return { triggerId: envTriggerId, workspaceId: envWorkspaceId, token: envToken, source: 'env' };
  };

  const resolve = (): WorkspaceAgentResolvedConfig | null => {
    const persisted = load();
    if (persisted.kind === 'enabled') {
      return {
        triggerId: persisted.value.triggerId,
        workspaceId: persisted.value.workspaceId,
        token: persisted.value.token,
        source: 'settings',
      };
    }
    // Disabled and unusable (invalid) files both suppress env bootstrap —
    // explicit off beats implicit env, and broken state must not silently
    // resurrect old credentials. Only a truly absent file bootstraps.
    if (persisted.kind !== 'absent') return null;
    const fromEnv = envConfig();
    return fromEnv === 'invalid' ? null : fromEnv;
  };

  const projectionFromEnvFallback = (): Pick<
    WorkspaceAgentConfigProjection,
    'triggerId' | 'workspaceId' | 'tokenConfigured' | 'source'
  > => ({
    triggerId: isNonEmpty(env[ENV_TRIGGER_ID]) ? env[ENV_TRIGGER_ID]! : null,
    workspaceId: isNonEmpty(env[ENV_WORKSPACE_ID]) ? env[ENV_WORKSPACE_ID]! : null,
    tokenConfigured: isNonEmpty(env[ENV_TOKEN]),
    source: envConfig() ? 'env' : isNonEmpty(env[ENV_TOKEN]) ? 'env' : null,
  });

  return {
    configPath,
    resolve,
    project(): WorkspaceAgentConfigProjection {
      const active = resolve();
      if (active) {
        return {
          enabled: true,
          triggerId: active.triggerId,
          workspaceId: active.workspaceId,
          tokenConfigured: true,
          source: active.source,
        };
      }
      const persisted = load();
      if (persisted.kind === 'enabled' || persisted.kind === 'disabled') {
        const hasStoredFields = persisted.value.triggerId !== '' && persisted.value.token !== '';
        return {
          enabled: false,
          triggerId: persisted.value.triggerId || null,
          workspaceId: persisted.value.workspaceId || null,
          tokenConfigured: hasStoredFields,
          source: 'settings',
        };
      }
      if (persisted.kind === 'invalid') {
        return {
          enabled: false,
          triggerId: null,
          workspaceId: null,
          tokenConfigured: false,
          source: null,
          invalidConfig: { reason: persisted.reason },
        };
      }
      // File absent: env may bootstrap — but a complete invalid triple is a
      // recoverable config error, never an active transport (astra R3a).
      const fromEnv = envConfig();
      if (fromEnv === 'invalid') {
        return {
          enabled: false,
          triggerId: isNonEmpty(env[ENV_TRIGGER_ID]) ? env[ENV_TRIGGER_ID]! : null,
          workspaceId: isNonEmpty(env[ENV_WORKSPACE_ID]) ? env[ENV_WORKSPACE_ID]! : null,
          tokenConfigured: isNonEmpty(env[ENV_TOKEN]),
          source: 'env',
          invalidConfig: { reason: 'env_invalid' },
        };
      }
      const fallback = projectionFromEnvFallback();
      return { enabled: false, ...fallback };
    },
    save(input) {
      const current = load();
      const currentvalue = current.kind === 'enabled' || current.kind === 'disabled' ? current.value : undefined;
      // One fallback chain, one authority: explicit input → persisted file →
      // active env (only when the file is absent and env is valid/active).
      const inheritableEnv = activeEnvForInheritance();
      const triggerId = input.triggerId ?? currentvalue?.triggerId ?? inheritableEnv?.triggerId;
      const workspaceId = input.workspaceId ?? currentvalue?.workspaceId ?? inheritableEnv?.workspaceId;
      const token = input.token ?? currentvalue?.token ?? inheritableEnv?.token;
      const enabled = input.enabled !== undefined ? input.enabled : (currentvalue?.enabled ?? true);
      if (!isNonEmpty(triggerId) || !isNonEmpty(workspaceId) || !isNonEmpty(token)) {
        throw new WorkspaceAgentTriggerError(
          'WORKSPACE_AGENT_INVALID_CONFIG',
          'triggerId, workspaceId, and token are all required to enable the workspace-agent path',
        );
      }
      if (!TRIGGER_ID_PATTERN.test(triggerId!) || !isWorkspaceAgentConversationKeySegment(workspaceId!)) {
        throw new WorkspaceAgentTriggerError(
          'WORKSPACE_AGENT_INVALID_CONFIG',
          'triggerId or workspaceId fails the shared conversation-key segment constraint',
        );
      }
      const persisted: PersistedShape = {
        triggerId: triggerId!,
        workspaceId: workspaceId!,
        token: token!,
        enabled,
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(configPath, persisted, deps.logger);
      cached = enabled ? { kind: 'enabled', value: persisted } : { kind: 'disabled', value: persisted };
      return this.project();
    },
    disable() {
      const current = load();
      const currentvalue = current.kind === 'enabled' || current.kind === 'disabled' ? current.value : undefined;
      // Persist the disable decision even when nothing was saved before —
      // an env-bootstrapped transport must be switchable off (astra R1),
      // and the tombstone must survive restarts. astra R2: the tombstone
      // captures the ACTIVE config (file or validated env) so the confirm
      // copy "重新启用无需重新粘贴" is true for env states as well. The same
      // inheritance authority applies: a disabled/invalid file must not gain
      // suppressed env credentials through a repeat disable (round-5 R1).
      const inheritableEnv = activeEnvForInheritance();
      const persisted: PersistedShape = {
        triggerId: currentvalue?.triggerId ?? inheritableEnv?.triggerId ?? '',
        workspaceId: currentvalue?.workspaceId ?? inheritableEnv?.workspaceId ?? '',
        token: currentvalue?.token ?? inheritableEnv?.token ?? '',
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(configPath, persisted, deps.logger);
      cached = { kind: 'disabled', value: persisted };
      return this.project();
    },
  };
}

/**
 * One stable adapter object that re-resolves config on every trigger call —
 * Settings authorize/re-auth/disable apply to the next dispatch immediately.
 */
export function createRefreshableWorkspaceAgentTriggerAdapter(
  config: WorkspaceAgentConfigStore,
): IWorkspaceAgentTriggerAdapter {
  return {
    get triggerId() {
      return config.resolve()?.triggerId ?? '';
    },
    async trigger(args) {
      const current = config.resolve();
      if (!current) {
        throw new WorkspaceAgentTriggerError(
          'WORKSPACE_AGENT_INVALID_CONFIG',
          'Workspace Agent transport is not configured (authorize in Settings or set the env triple)',
        );
      }
      const adapter = new WorkspaceAgentTriggerHttpAdapter({
        triggerId: current.triggerId,
        tokenProvider: () => current.token,
      });
      return adapter.trigger(args);
    },
  };
}

/**
 * Per-dispatch resolver shape consumed by the cloud invoke bridge.
 * astra round-5 R2: one dispatch uses ONE configuration snapshot — the
 * adapter is bound to the resolved config (fixed trigger id + token), and
 * the identity fields travel with it so provenance is never re-read from
 * mutable Settings after an await boundary.
 */
export type WorkspaceAgentTransportSnapshot = {
  readonly adapter: IWorkspaceAgentTriggerAdapter;
  readonly workspaceId: string;
  readonly triggerId: string;
};

export type WorkspaceAgentTransportResolver = () => WorkspaceAgentTransportSnapshot | null;

/** Build a snapshot-bound transport from the currently active config. */
export function resolveWorkspaceAgentTransportSnapshot(
  config: WorkspaceAgentConfigStore,
): WorkspaceAgentTransportSnapshot | null {
  const active = config.resolve();
  if (!active) return null;
  const adapter = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: active.triggerId,
    tokenProvider: () => active.token,
  });
  return { adapter, workspaceId: active.workspaceId, triggerId: active.triggerId };
}
