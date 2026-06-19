import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOperationField, isValueField, type ValueConfigField } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { applyConnectorSecretUpdates } from '../config/connector-secret-updater.js';
import {
  containsRedactedPlaceholder,
  requireConnectorWriteNetworkGuard,
  requireConnectorWriteOwner,
  resolveConnectorSessionUserId,
  validateConnectorSecretUpdates,
} from '../config/connector-secret-write-guards.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { DEFAULT_THREAD_ID, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { encodeDefault } from '../infrastructure/config-field-parser.js';
import type { IConnectorPermissionStore } from '../infrastructure/connectors/ConnectorPermissionStore.js';
import { executeConnectorAction } from '../infrastructure/connectors/connector-action-handler.js';
import { getAllExternalConnectorMeta } from '../infrastructure/connectors/external-connector-registry.js';
import { DefaultFeishuQrBindClient, type FeishuQrBindClient } from '../infrastructure/connectors/FeishuQrBindClient.js';
import {
  loadAllConnectorConfigs,
  readAllOperationStates,
  readConnectorConfig,
  resolveConnectorEnv,
  writeConnectorConfig,
  writeOperationState,
} from '../infrastructure/connectors/im-connector-config-store.js';
import type { IMConnectorPlugin } from '../infrastructure/connectors/im-connector-plugin.js';
import type { WeComBotAdapter } from '../infrastructure/connectors/im-connectors/wecom-bot/WeComBotAdapter.js';
import type { WeixinAdapter } from '../infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js';
import type { IOutboundAdapter } from '../infrastructure/connectors/OutboundDeliveryHook.js';
import {
  type ConnectorManifest,
  type ManifestIconSpec,
  scanConnectorManifests,
} from '../infrastructure/connectors/plugins/im-connector-manifest.js';
import { resolvePluginsDir } from '../infrastructure/connectors/plugins/plugin-installer.js';
import { normalizeTelegramBotToken } from '../infrastructure/connectors/telegram-token.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ConnectorHubRoutesOptions {
  threadStore: IThreadStore;
  /**
   * Lazy reference to the WeChat adapter instance.
   * Set after connector gateway starts (which happens post-listen).
   * Null when gateway not started or WeChat not available.
   */
  weixinAdapter?: WeixinAdapter | null;
  /** Called after successful QR login to start the WeChat polling loop */
  startWeixinPolling?: () => void;
  /** F132 Phase E: dynamically start WeCom Bot adapter after credential validation */
  startWeComBotStream?: (botId: string, secret: string) => Promise<void>;
  /** F132 Phase E: stop running WeCom Bot adapter (for disconnect) */
  stopWeComBot?: () => Promise<void>;
  /** Live WeCom Bot adapter getter for health reporting (instance changes on reconnect) */
  getWeComBotAdapter?: () => WeComBotAdapter | null;
  /** F134 Phase D: Permission store for group whitelist + admin management */
  permissionStore?: IConnectorPermissionStore | null;
  /** Shared Redis dependency for external connector action handlers. */
  redis?: RedisClient | undefined;
  envFilePath?: string;
  feishuQrBindClient?: FeishuQrBindClient;

  /** F240 A-3: Plugin registry for generic action endpoint (includes unconfigured plugins) */
  pluginRegistry?: ReadonlyMap<string, IMConnectorPlugin>;
  /** F240 A-3: Adapter registry for generic action endpoint (only configured+started connectors) */
  adapterRegistry?: ReadonlyMap<string, IOutboundAdapter>;
  /** F240 A-3: Activate a connector after credentials acquired via action (creates adapter + starts inbound) */
  activateConnector?: (connectorId: string) => Promise<void>;
  /** F240 A-3: Deactivate a connector on disconnect — stop inbound, remove adapter/webhook/media */
  deactivateConnector?: (connectorId: string) => Promise<void>;
}

function requireTrustedHubIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveHeaderUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  return userId;
}

function requireSessionHubIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveConnectorSessionUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  return userId;
}

type ConnectorWriteIdentityResult = { userId: string; error?: never } | { userId?: never; error: { error: string } };

function requireConnectorWriteIdentity(request: FastifyRequest, reply: FastifyReply): ConnectorWriteIdentityResult {
  const userId = requireSessionHubIdentity(request, reply);
  if (!userId) return { error: { error: 'Identity required' } };
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status);
    return { error: { error: networkError.error } };
  }
  const ownerError = requireConnectorWriteOwner(userId);
  if (ownerError) {
    reply.status(ownerError.status);
    return { error: { error: ownerError.error } };
  }
  return { userId };
}

interface ConnectorSecretRouteUpdate {
  name: string;
  value: string | null;
}

async function applyAuditedConnectorSecretUpdates(
  app: FastifyInstance,
  connectorId: string,
  updates: ConnectorSecretRouteUpdate[],
  opts: Pick<ConnectorHubRoutesOptions, 'envFilePath'>,
  operator: string,
  action: string,
): Promise<{ status: number; error: string } | null> {
  const validationError = validateConnectorSecretUpdates(updates);
  if (validationError) return { status: 400, error: validationError };

  await applyConnectorSecretUpdates(updates, { envFilePath: opts.envFilePath });
  const projectRoot = resolveActiveProjectRoot();
  const { changedKeys } = writeConnectorConfig(projectRoot, connectorId, updates);
  if (changedKeys.length > 0) {
    configEventBus.emitChange({
      source: 'config-store',
      scope: 'key',
      changedKeys,
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });
  }

  try {
    await getEventAuditLog().append({
      type: AuditEventTypes.CONFIG_UPDATED,
      data: {
        target: 'connector-secrets',
        action,
        keys: updates.map((update) => update.name),
        operator,
      },
    });
  } catch (err) {
    app.log.warn({ err, action, keys: updates.map((update) => update.name) }, 'connector secret audit append failed');
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickPendingActionValues(body: unknown, valueFields: ValueConfigField[]): Record<string, string> {
  if (!isRecord(body) || !isRecord(body.values)) return {};

  const allowedNames = new Set(valueFields.map((field) => field.envName));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(body.values)) {
    if (allowedNames.has(name) && typeof value === 'string') {
      values[name] = value;
    }
  }
  return values;
}

// ── Connector platform config definitions ──

interface ConnectorFieldDef {
  envName: string;
  label: string;
  sensitive: boolean;
  /** Field type from YAML manifest (AC-A24). Frontend uses this for generic rendering. */
  type: 'input' | 'select' | 'toggle' | 'list';
  /** Select options (only for type: select). */
  options?: Array<{ value: string; label: string }>;
  /** When set, this field is only required if the condition env var has the given value */
  requiredWhen?: { envName: string; value: string };
  /** When true, this field is never required for the platform to be "configured" */
  optional?: boolean;
  /** Default value used when the env var is not set — aligns status page with runtime normalization */
  defaultValue?: string;
  /** Field writes persist immediately but runtime consumers only pick them up after an API restart. */
  restartRequired?: boolean;
}

interface PlatformStepDef {
  text: string;
  /** When set, this step only displays when the selected connection mode matches */
  mode?: string;
}

interface PlatformDef {
  id: string;
  name: string;
  nameEn: string;
  fields: ConnectorFieldDef[];
  /** All value fields, including hidden fields that still participate in configured calculation. */
  configFields: ConnectorFieldDef[];
  docsUrl: string;
  /** Steps displayed in the guided wizard — may be mode-filtered */
  steps: PlatformStepDef[];
  /** Manifest icon for frontend rendering (AC-A23). */
  icon?: { type: string; src?: string; iconId?: string };
  /** Theme color from manifest (AC-A23). */
  themeColor?: string;
  /** AC-A25: manifest-driven permission label — renders HubPermissionsTab when present. */
  permissionLabel?: string;
  /** F240: YAML-declared health-check — controls test button visibility. */
  testable?: boolean;
  /** F240: 'external' for user-installed plugins. Absent = builtin. */
  source?: 'builtin' | 'external';
}

// ── Manifest-driven platform definitions ──

// Resolve from compiled dist/routes/ → packages/api/ → src/infrastructure/…
// YAML manifests live in src/, not dist/ (TSC doesn't copy non-TS files).
const CONNECTORS_DIR = join(__dirname, '../../src/infrastructure/connectors/im-connectors');

let _cachedManifests: Map<string, ConnectorManifest> | null = null;

/**
 * Get all connector manifests (built-in + installed plugins).
 * Cache is invalidated on plugin install/uninstall via `invalidateManifestCache()`.
 */
function getConnectorManifests(): Map<string, ConnectorManifest> {
  if (!_cachedManifests) {
    _cachedManifests = scanConnectorManifests(CONNECTORS_DIR);

    // Phase B: also scan installed plugin manifests (source: 'external' is in their YAML)
    try {
      const pluginManifests = scanConnectorManifests(resolvePluginsDir(resolveActiveProjectRoot()));
      for (const [id, manifest] of pluginManifests) {
        if (!_cachedManifests.has(id)) {
          _cachedManifests.set(id, manifest);
        }
      }
    } catch {
      // Plugin dir not available — only built-in manifests
    }
  }
  return _cachedManifests;
}

/** Invalidate manifest cache — called after plugin install/uninstall to pick up new manifests. */
export function invalidateManifestCache(): void {
  _cachedManifests = null;
}

/**
 * Rewrite external plugin icon.src from relative file name (e.g. `icon.svg`)
 * to an API URL (e.g. `/api/connectors/plugins/echo-e2e/icon`) so the browser
 * can fetch it. Built-in icons (absolute paths like `/images/connectors/feishu.png`)
 * pass through unchanged.
 */
function rewritePluginIconSrc(
  connectorId: string,
  icon: ManifestIconSpec,
  source: 'builtin' | 'external' | undefined,
): PlatformDef['icon'] {
  if (source !== 'external') return icon;
  if (!('src' in icon) || !icon.src) return icon;
  // Absolute path or URL → already reachable, keep as-is
  if (icon.src.startsWith('/') || icon.src.startsWith('http')) return icon;
  // Relative file name → rewrite to plugin icon API route
  return { ...icon, src: `/api/connectors/plugins/${encodeURIComponent(connectorId)}/icon` };
}

/**
 * Convert a ConnectorManifest to the legacy PlatformDef shape.
 * KD-17: only value fields are mapped (operations have no envName).
 * Hidden input fields are excluded (e.g. weixin bot token managed by QR).
 * KD-18: defaults encoded through codec for string-uniform representation.
 */
function valueFieldToConnectorFieldDef(f: ValueConfigField): ConnectorFieldDef {
  const isSensitive = f.type === 'input' && f.sensitive;
  const def: ConnectorFieldDef = {
    envName: f.envName,
    label: f.label,
    sensitive: isSensitive,
    type: f.type,
  };
  if (f.type === 'select' && f.options) def.options = f.options;
  const hasRequiredWhen = f.type === 'input' && f.requiredWhen;
  // requiredWhen means conditionally required, not optional
  if (!f.required && !hasRequiredWhen) def.optional = true;
  const encoded = encodeDefault(f);
  if (encoded != null) def.defaultValue = encoded;
  if (f.type === 'input' && f.requiredWhen) def.requiredWhen = f.requiredWhen;
  return def;
}

function manifestToPlatformDef(m: ConnectorManifest): PlatformDef {
  const valueFields = m.config.filter(isValueField);
  const configFields = valueFields.map(valueFieldToConnectorFieldDef);
  const fields = valueFields.filter((f) => !(f.type === 'input' && f.hidden)).map(valueFieldToConnectorFieldDef);

  return {
    id: m.id,
    name: m.name,
    nameEn: m.nameEn,
    fields,
    configFields,
    docsUrl: m.docsUrl,
    steps: m.steps.map((s) => {
      const step: PlatformStepDef = { text: s.text };
      if (s.mode) step.mode = s.mode;
      return step;
    }),
    ...(m.icon ? { icon: rewritePluginIconSrc(m.id, m.icon, m.source) } : {}),
    ...(m.themeColor ? { themeColor: m.themeColor } : {}),
    ...(m.permissions?.label ? { permissionLabel: m.permissions.label } : {}),
    ...(m.testable ? { testable: m.testable } : {}),
    ...(m.source ? { source: m.source } : {}),
  };
}

function manifestsToPlatformDefs(manifests: ConnectorManifest[]): PlatformDef[] {
  return manifests.map(manifestToPlatformDef);
}

/** Dynamically computed from YAML manifests — backward compat export. */
export function getConnectorPlatforms(): PlatformDef[] {
  return manifestsToPlatformDefs(Array.from(getConnectorManifests().values()));
}

/**
 * @deprecated Use `getConnectorPlatforms()` instead.
 * Kept as a lazy getter for backward compatibility.
 */
export const CONNECTOR_PLATFORMS: PlatformDef[] = new Proxy([] as PlatformDef[], {
  get(target, prop, receiver) {
    const live = getConnectorPlatforms();
    return Reflect.get(live, prop, receiver);
  },
});

/** Mask a sensitive value: show only that it is set, no suffix. Aligns with env-registry *** policy. */
function maskSensitiveValue(_value: string): string {
  return '••••••••';
}

export interface PlatformFieldStatus {
  envName: string;
  label: string;
  sensitive: boolean;
  /** Field type — frontend uses for generic rendering (AC-A24). */
  type: 'input' | 'select' | 'toggle' | 'list';
  /** Select options (only for type: select). */
  options?: Array<{ value: string; label: string }>;
  restartRequired?: boolean;
  /** null = not set, masked string = set (sensitive fields show last 4 chars) */
  currentValue: string | null;
}

export interface PlatformStepStatus {
  text: string;
  mode?: string;
}

/** Action definition from YAML manifest — forwarded to frontend for ActionRenderer (AC-A26). */
export interface PlatformActionDef {
  id: string;
  label: string;
  render: string;
  resultRender?: string;
  next?: string;
  rollback?: string;
  timeout?: number;
}

/** Operation definition + runtime state for ActionRenderer (AC-A26). */
export interface PlatformOperationStatus {
  name: string;
  label: string;
  actions: PlatformActionDef[];
  /** Runtime state: which action the state machine is on. */
  currentAction?: string;
  /** Last action result (render + data + label). */
  lastResult?: { render: string; data: unknown; label?: string };
  /** Epoch ms of last state write. */
  updatedAt?: number;
}

export interface PlatformStatus {
  id: string;
  name: string;
  nameEn: string;
  /** F240: 'external' for user-installed connectors. Absent/undefined = builtin. */
  source?: 'builtin' | 'external';
  configured: boolean;
  fields: PlatformFieldStatus[];
  docsUrl: string;
  steps: PlatformStepStatus[];
  /** Manifest icon (AC-A23). */
  icon?: { type: string; src?: string; iconId?: string };
  /** Theme color from manifest (AC-A23). */
  themeColor?: string;
  /** Operation definitions + state for ActionRenderer (AC-A26). */
  operations?: PlatformOperationStatus[];
  /** AC-A25: manifest-driven permission label — renders HubPermissionsTab when present. */
  permissionLabel?: string;
  /** F240: YAML-declared health-check — controls test button visibility. */
  testable?: boolean;
}

function isConfiguredFieldValue(field: ConnectorFieldDef, raw: string | undefined): boolean {
  if (raw == null || raw === '' || raw.startsWith('(未设置')) return false;
  if (field.envName === 'TELEGRAM_BOT_TOKEN') return normalizeTelegramBotToken(raw) != null;
  return true;
}

function resolveRequiredWhenConditionValue(
  conditionField: ConnectorFieldDef | undefined,
  rawValue: string | undefined,
): string | undefined {
  if (rawValue && (!conditionField?.options || conditionField.options.some((option) => option.value === rawValue))) {
    return rawValue;
  }
  return conditionField?.defaultValue;
}

function isRequiredFieldSatisfied(
  field: ConnectorFieldDef,
  env: Record<string, string | undefined>,
  fields: readonly ConnectorFieldDef[],
): boolean {
  if (field.optional) return true;
  if (field.requiredWhen) {
    const conditionField = fields.find((candidate) => candidate.envName === field.requiredWhen?.envName);
    const conditionValue = resolveRequiredWhenConditionValue(conditionField, env[field.requiredWhen.envName]);
    if (conditionValue !== field.requiredWhen.value) return true;
  }
  return isConfiguredFieldValue(field, env[field.envName]);
}

export function buildConnectorStatus(
  env: Record<string, string | undefined> = process.env,
  manifests?: ConnectorManifest[],
  connectorEnvById?: ReadonlyMap<string, Record<string, string | undefined>>,
): PlatformStatus[] {
  const resolved = manifests ? manifestsToPlatformDefs(manifests) : getConnectorPlatforms();
  const externalMetaById = new Map(getAllExternalConnectorMeta().map((meta) => [meta.id, meta]));

  const builtinStatuses: PlatformStatus[] = resolved.map((platform) => {
    const platformEnv = connectorEnvById?.get(platform.id) ?? env;
    const fields: PlatformFieldStatus[] = platform.fields.map((f) => {
      const raw = platformEnv[f.envName];
      const isSet = isConfiguredFieldValue(f, raw);
      const effectiveValue = isSet ? raw : (f.defaultValue ?? null);
      return {
        envName: f.envName,
        label: f.label,
        sensitive: f.sensitive,
        type: f.type,
        ...(f.options ? { options: f.options } : {}),
        restartRequired: f.restartRequired,
        currentValue: effectiveValue ? (f.sensitive ? maskSensitiveValue(effectiveValue) : effectiveValue) : null,
      };
    });

    let configured: boolean;
    const configuredFields = platform.configFields ?? platform.fields;
    if (configuredFields.length === 0) {
      configured = false;
    } else {
      configured = configuredFields.every((f) => isRequiredFieldSatisfied(f, platformEnv, configuredFields));
    }
    if (platform.source === 'external') {
      const externalMeta = externalMetaById.get(platform.id);
      if (externalMeta) {
        configured = externalMeta.configured;
      } else if (!connectorEnvById?.has(platform.id)) {
        configured = false;
      }
    }

    return {
      id: platform.id,
      name: platform.name,
      nameEn: platform.nameEn,
      configured,
      fields,
      docsUrl: platform.docsUrl,
      steps: platform.steps,
      ...(platform.icon ? { icon: platform.icon } : {}),
      ...(platform.themeColor ? { themeColor: platform.themeColor } : {}),
      ...(platform.permissionLabel ? { permissionLabel: platform.permissionLabel } : {}),
      ...(platform.testable ? { testable: platform.testable } : {}),
      ...(platform.source ? { source: platform.source } : {}),
    };
  });

  // F240: Append external connector plugin statuses (P1-2 fix)
  const resolvedIds = new Set(resolved.map((p) => p.id));

  for (const meta of externalMetaById.values()) {
    if (resolvedIds.has(meta.id)) continue;
    const metaEnv = connectorEnvById?.get(meta.id) ?? env;

    const fields: PlatformFieldStatus[] = meta.requiredEnvKeys.map((key) => {
      const raw = metaEnv[key];
      const isSet = raw != null && raw !== '' && !raw.startsWith('(未设置');
      return {
        envName: key,
        label: key,
        sensitive: true,
        type: 'input' as const,
        currentValue: isSet ? maskSensitiveValue(raw!) : null,
      };
    });

    builtinStatuses.push({
      id: meta.id,
      name: meta.definition.displayName,
      nameEn: meta.definition.displayName,
      source: 'external',
      configured: meta.configured,
      fields,
      docsUrl: '',
      steps: [],
    });
  }

  return builtinStatuses;
}

function buildConnectorStatusWithStoredConfig(): {
  projectRoot: string;
  manifests: ConnectorManifest[];
  status: PlatformStatus[];
} {
  const manifests = Array.from(getConnectorManifests().values());
  const projectRoot = resolveActiveProjectRoot();
  loadAllConnectorConfigs(projectRoot, manifests);
  const connectorEnvById = new Map<string, Record<string, string | undefined>>();
  for (const m of manifests) {
    const valueFields = m.config.filter(isValueField);
    const resolved = resolveConnectorEnv(m.id, valueFields);
    connectorEnvById.set(m.id, { ...process.env, ...resolved });
  }
  return { projectRoot, manifests, status: buildConnectorStatus(process.env, manifests, connectorEnvById) };
}

function resolveStoredConnectorEnv(
  connectorId: string,
  manifest: ConnectorManifest,
): Record<string, string | undefined> {
  loadAllConnectorConfigs(resolveActiveProjectRoot(), [manifest]);
  return resolveConnectorEnv(connectorId, manifest.config.filter(isValueField));
}

export const connectorHubRoutes: FastifyPluginAsync<ConnectorHubRoutesOptions> = async (app, opts) => {
  const { threadStore } = opts;
  const feishuQrBindClient = opts.feishuQrBindClient ?? new DefaultFeishuQrBindClient();

  app.get('/api/connector/hub-threads', async (request, reply) => {
    const userId = requireSessionHubIdentity(request, reply);
    if (!userId) {
      return { error: 'Identity required (session cookie)' };
    }
    const allThreads = await threadStore.list(userId);
    const hubThreads = allThreads
      .filter((t) => t.connectorHubState && t.id !== DEFAULT_THREAD_ID)
      .sort((a, b) => (b.connectorHubState?.createdAt ?? 0) - (a.connectorHubState?.createdAt ?? 0));
    return {
      threads: hubThreads.map((t) => ({
        id: t.id,
        title: t.title,
        connectorId: t.connectorHubState?.connectorId,
        externalChatId: t.connectorHubState?.externalChatId,
        createdAt: t.connectorHubState?.createdAt,
        lastCommandAt: t.connectorHubState?.lastCommandAt,
      })),
    };
  });

  app.get('/api/connector/status', async (request, reply) => {
    const userId = requireSessionHubIdentity(request, reply);
    if (!userId) {
      return { error: 'Identity required (session cookie)' };
    }
    // F240 A-4 fix: resolve stored config > env > default per connector
    // Without this, Hub UI shows stale process.env after saving via config store.
    const { projectRoot, manifests, status } = buildConnectorStatusWithStoredConfig();
    // F137: WeChat "configured" is based on adapter having a live bot_token, not env vars
    const weixinStatus = status.find((p) => p.id === 'weixin');
    if (weixinStatus) {
      const adapter = opts.weixinAdapter;
      weixinStatus.configured = adapter != null && adapter.hasBotToken() && adapter.isPolling();
    }
    // F132 bugfix: WeCom Bot live health — override "configured" with actual connection state.
    // When getter is wired (gateway started) but returns null (adapter stopped/not started),
    // force configured=false to avoid false green light from env var check.
    const wecomBotStatus = status.find((p) => p.id === 'wecom-bot');
    if (wecomBotStatus && opts.getWeComBotAdapter) {
      const adapter = opts.getWeComBotAdapter();
      wecomBotStatus.configured = adapter?.getConnectionState() === 'connected';
    }

    // F240 AC-A26: Enrich status with operation definitions + state for ActionRenderer
    for (const m of manifests) {
      const opFields = m.config.filter(isOperationField);
      if (opFields.length === 0) continue;

      const platformStatus = status.find((p) => p.id === m.id);
      if (!platformStatus) continue;

      const opStates = readAllOperationStates(projectRoot, m.id);
      platformStatus.operations = opFields.map((op) => {
        const state = opStates[op.name];
        return {
          name: op.name,
          label: op.label,
          actions: op.actions.map((a) => ({
            id: a.id,
            label: a.label,
            render: a.render,
            ...(a.resultRender ? { resultRender: a.resultRender } : {}),
            ...(a.next ? { next: a.next } : {}),
            ...(a.rollback ? { rollback: a.rollback } : {}),
            ...(a.timeout ? { timeout: a.timeout } : {}),
          })),
          ...(state?.currentAction ? { currentAction: state.currentAction } : {}),
          ...(state?.lastResult ? { lastResult: state.lastResult } : {}),
          ...(state?.updatedAt ? { updatedAt: state.updatedAt } : {}),
        };
      });
    }

    return { platforms: status };
  });

  // Legacy connector action aliases.
  //
  // F240 added the generic /api/connectors/:id/actions/... state machine, but
  // these /api/connector/... endpoints are still part of the public Hub
  // contract and preserve .env/process.env side effects used by existing setup
  // flows. Keep them as compatibility shims until the frontend and public API
  // tests are migrated together.

  app.post('/api/connector/feishu/qrcode', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;

    try {
      const result = await feishuQrBindClient.create();
      return result;
    } catch (err) {
      app.log.error({ err }, '[Feishu QR] Failed to fetch QR code');
      reply.status(502);
      return { error: 'Failed to fetch QR code from Feishu registration service' };
    }
  });

  app.get('/api/connector/feishu/qrcode-status', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;

    const { qrPayload } = request.query as { qrPayload?: string };
    if (!qrPayload) {
      reply.status(400);
      return { error: 'qrPayload query parameter required' };
    }

    try {
      const status = await feishuQrBindClient.poll(qrPayload);
      if (status.status !== 'confirmed') {
        return status;
      }

      const updates = [
        { name: 'FEISHU_APP_ID', value: status.appId ?? null },
        { name: 'FEISHU_APP_SECRET', value: status.appSecret ?? null },
      ];
      const feishuManifest = getConnectorManifests().get('feishu');
      const feishuEnv = feishuManifest ? resolveStoredConnectorEnv('feishu', feishuManifest) : process.env;
      const currentMode = feishuEnv.FEISHU_CONNECTION_MODE === 'websocket' ? 'websocket' : 'webhook';
      const verificationToken = feishuEnv.FEISHU_VERIFICATION_TOKEN;
      if (currentMode === 'webhook' && (!verificationToken || verificationToken.trim() === '')) {
        updates.push({ name: 'FEISHU_CONNECTION_MODE', value: 'websocket' });
      }
      const writeError = await applyAuditedConnectorSecretUpdates(
        app,
        'feishu',
        updates,
        opts,
        userId,
        'feishu-qrcode-confirm',
      );
      if (writeError) {
        reply.status(writeError.status);
        return { error: writeError.error };
      }
      return { status: 'confirmed' };
    } catch (err) {
      app.log.error({ err }, '[Feishu QR] Failed to poll QR status');
      reply.status(502);
      return { error: 'Failed to poll Feishu QR status' };
    }
  });

  app.post('/api/connector/feishu/disconnect', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;

    const writeError = await applyAuditedConnectorSecretUpdates(
      app,
      'feishu',
      [
        { name: 'FEISHU_APP_ID', value: null },
        { name: 'FEISHU_APP_SECRET', value: null },
      ],
      opts,
      userId,
      'feishu-disconnect',
    );
    if (writeError) {
      reply.status(writeError.status);
      return { error: writeError.error };
    }
    app.log.info({ userId }, '[Feishu] Disconnected by user');
    return { ok: true };
  });

  // ── F137: WeChat QR code login routes ──

  app.post('/api/connector/weixin/qrcode', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;

    try {
      const { WeixinAdapter: WA } = await import('../infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js');
      const result = await WA.fetchQrCode();
      // iLink returns a webpage URL (https://liteapp.weixin.qq.com/q/...), not an image.
      // Generate a real QR code data URI from the URL so <img> can render it.
      const QRCode = await import('qrcode');
      const qrDataUri = await QRCode.toDataURL(result.qrUrl, { width: 384, margin: 2 });
      return { qrUrl: qrDataUri, qrPayload: result.qrPayload };
    } catch (err) {
      app.log.error({ err }, '[WeChat QR] Failed to fetch QR code');
      reply.status(502);
      return { error: 'Failed to fetch QR code from WeChat' };
    }
  });

  app.get('/api/connector/weixin/qrcode-status', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;

    const { qrPayload } = request.query as { qrPayload?: string };
    if (!qrPayload) {
      reply.status(400);
      return { error: 'qrPayload query parameter required' };
    }

    try {
      const { WeixinAdapter: WA } = await import('../infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js');
      const status = await WA.pollQrCodeStatus(qrPayload);

      if (status.status === 'confirmed') {
        const adapter = opts.weixinAdapter;
        if (!adapter) {
          app.log.error('[WeChat QR] QR confirmed but adapter not available — token would be lost');
          reply.status(503);
          return { error: 'WeChat adapter not ready — please retry shortly' };
        }
        const writeError = await applyAuditedConnectorSecretUpdates(
          app,
          'weixin',
          [{ name: 'WEIXIN_BOT_TOKEN', value: status.botToken }],
          opts,
          userId,
          'weixin-qrcode-confirm',
        );
        if (writeError) {
          reply.status(writeError.status);
          return { error: writeError.error };
        }
        adapter.setBotToken(status.botToken);
        opts.startWeixinPolling?.();
        app.log.info('[WeChat QR] Auto-activated — bot_token persisted to .env, polling started');
        return { status: 'confirmed' };
      }

      return status;
    } catch (err) {
      app.log.error({ err }, '[WeChat QR] Failed to poll QR status');
      reply.status(502);
      return { error: 'Failed to poll QR code status' };
    }
  });

  app.post('/api/connector/weixin/activate', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;

    const adapter = opts.weixinAdapter;
    if (!adapter) {
      reply.status(503);
      return { error: 'WeChat adapter not available (connector gateway not started)' };
    }

    if (!adapter.hasBotToken()) {
      reply.status(409);
      return { error: 'No bot_token available — complete QR code login first' };
    }

    opts.startWeixinPolling?.();
    app.log.info('[WeChat QR] Manual activate — polling started');

    return { ok: true, polling: adapter.isPolling() };
  });

  app.post('/api/connector/weixin/disconnect', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;

    const adapter = opts.weixinAdapter;
    if (!adapter) {
      reply.status(503);
      return { error: 'WeChat adapter not available (connector gateway not started)' };
    }

    await adapter.disconnect();
    const writeError = await applyAuditedConnectorSecretUpdates(
      app,
      'weixin',
      [{ name: 'WEIXIN_BOT_TOKEN', value: null }],
      opts,
      userId,
      'weixin-disconnect',
    );
    if (writeError) {
      reply.status(writeError.status);
      return { error: writeError.error };
    }
    app.log.info({ userId }, '[WeChat] Disconnected by user — token cleared from .env');

    return { ok: true };
  });

  // ── F132 Phase E: WeCom Bot guided setup — validate + connect + disconnect ──

  app.post('/api/connector/wecom-bot/validate', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;

    const { botId, secret } = (request.body ?? {}) as { botId?: string; secret?: string };
    if (!botId || !secret) {
      reply.status(400);
      return { error: 'botId and secret are required' };
    }
    const validationError = validateConnectorSecretUpdates([
      { name: 'WECOM_BOT_ID', value: botId },
      { name: 'WECOM_BOT_SECRET', value: secret },
    ]);
    if (validationError) {
      reply.status(400);
      return { error: validationError };
    }

    try {
      const { WeComBotAdapter: WeComBotAdapterImpl } = await import(
        '../infrastructure/connectors/im-connectors/wecom-bot/WeComBotAdapter.js'
      );
      const result = await WeComBotAdapterImpl.validateCredentials(botId, secret);

      if (!result.valid) {
        reply.status(422);
        return { valid: false, error: result.error };
      }

      const writeError = await applyAuditedConnectorSecretUpdates(
        app,
        'wecom-bot',
        [
          { name: 'WECOM_BOT_ID', value: botId },
          { name: 'WECOM_BOT_SECRET', value: secret },
        ],
        opts,
        userId,
        'wecom-bot-validate',
      );
      if (writeError) {
        reply.status(writeError.status);
        return { valid: false, error: writeError.error };
      }

      if (opts.startWeComBotStream) {
        try {
          await opts.startWeComBotStream(botId, secret);
        } catch (startErr) {
          await applyAuditedConnectorSecretUpdates(
            app,
            'wecom-bot',
            [
              { name: 'WECOM_BOT_ID', value: null },
              { name: 'WECOM_BOT_SECRET', value: null },
            ],
            opts,
            userId,
            'wecom-bot-rollback',
          );
          app.log.error({ err: startErr }, '[WeCom Bot] Adapter start failed — credentials rolled back');
          reply.status(502);
          return { valid: false, error: 'Credentials valid but adapter failed to start' };
        }
      }

      app.log.info({ userId }, '[WeCom Bot] Validated + activated via guided setup');
      return { valid: true };
    } catch (err) {
      app.log.error({ err }, '[WeCom Bot] Validation failed');
      reply.status(502);
      return { valid: false, error: 'Failed to validate WeCom Bot credentials' };
    }
  });

  app.post('/api/connector/wecom-bot/disconnect', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;

    if (opts.stopWeComBot) {
      await opts.stopWeComBot();
    }

    const writeError = await applyAuditedConnectorSecretUpdates(
      app,
      'wecom-bot',
      [
        { name: 'WECOM_BOT_ID', value: null },
        { name: 'WECOM_BOT_SECRET', value: null },
      ],
      opts,
      userId,
      'wecom-bot-disconnect',
    );
    if (writeError) {
      reply.status(writeError.status);
      return { error: writeError.error };
    }
    app.log.info({ userId }, '[WeCom Bot] Disconnected by user — credentials cleared');

    return { ok: true };
  });

  // ── F240: Write connector config via config store ──

  app.put('/api/connectors/:connectorId/config', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;

    const { connectorId } = request.params as {
      connectorId: string;
    };
    const manifest = getConnectorManifests().get(connectorId);
    if (!manifest) {
      reply.status(404);
      return { error: `Unknown connector: ${connectorId}` };
    }

    const body = request.body as {
      fields?: { name: string; value: string | null }[];
    };
    if (!Array.isArray(body?.fields) || body.fields.length === 0) {
      reply.status(400);
      return { error: 'fields array required' };
    }

    // Validate field names against manifest — only value fields have envName (KD-17)
    const allowed = new Set(manifest.config.filter(isValueField).map((f) => f.envName));
    const invalid = body.fields.filter((f) => !allowed.has(f.name));
    if (invalid.length > 0) {
      reply.status(400);
      return {
        error: `Unknown fields: ${invalid.map((f) => f.name).join(', ')}`,
      };
    }
    if (body.fields.some((field) => containsRedactedPlaceholder(field.value))) {
      reply.status(400);
      return { error: 'Refusing to write redacted connector placeholder values' };
    }

    const projectRoot = resolveActiveProjectRoot();
    const { changedKeys } = writeConnectorConfig(projectRoot, connectorId, body.fields);

    // No process.env sync — connector config lives in .cat-cafe store, not in the
    // host process environment. Gateway bootstrap reads config store via
    // getStoredConnectorValue() which overrides process.env/.env fallback (L493-505).
    // Writing to process.env would pollute the host namespace.

    // Fire config change event — triggers connector-reload-subscriber gateway restart
    if (changedKeys.length > 0) {
      configEventBus.emitChange({
        source: 'config-store',
        scope: manifest.source === 'external' ? 'file' : 'key',
        changedKeys,
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
    }

    try {
      await getEventAuditLog().append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: {
          target: 'connector-config',
          action: `connector-config-write:${connectorId}`,
          keys: changedKeys,
          operator: userId,
        },
      });
    } catch (err) {
      app.log.warn({ err, connectorId, keys: changedKeys }, 'connector config audit append failed');
    }

    return { ok: true, changedKeys };
  });

  // ── F240 A-3: Generic action endpoint (AC-A16) ──

  app.post('/api/connectors/:connectorId/operations/:operationName/reset', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;

    const { connectorId, operationName } = request.params as {
      connectorId: string;
      operationName: string;
    };
    const body = request.body as { currentAction?: string };
    const currentAction = body?.currentAction;
    if (!currentAction) {
      reply.status(400);
      return { error: 'currentAction required' };
    }

    const manifest = getConnectorManifests().get(connectorId);
    if (!manifest) {
      reply.status(404);
      return { error: `Unknown connector: ${connectorId}` };
    }
    const operation = manifest.config.find((f) => isOperationField(f) && f.name === operationName);
    if (!operation || !isOperationField(operation)) {
      reply.status(404);
      return { error: `Operation '${operationName}' not found in connector '${connectorId}'` };
    }
    if (!operation.actions.some((a) => a.id === currentAction)) {
      reply.status(400);
      return { error: `Action '${currentAction}' not found in operation '${operationName}'` };
    }

    const projectRoot = resolveActiveProjectRoot();
    writeOperationState(projectRoot, connectorId, operationName, { currentAction });
    return { ok: true, currentAction };
  });

  app.post('/api/connectors/:connectorId/actions/:operationName/:actionId', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;

    const { connectorId, operationName, actionId } = request.params as {
      connectorId: string;
      operationName: string;
      actionId: string;
    };

    const manifest = getConnectorManifests().get(connectorId);
    if (!manifest) {
      reply.status(404);
      return { error: `Unknown connector: ${connectorId}` };
    }

    const plugin = opts.pluginRegistry?.get(connectorId);
    if (!plugin) {
      reply.status(503);
      return { error: `Connector '${connectorId}' plugin not loaded` };
    }
    // Adapter is optional — unconfigured connectors (e.g. pre-QR-login) have no adapter yet
    const adapter = opts.adapterRegistry?.get(connectorId);

    const projectRoot = resolveActiveProjectRoot();
    // Resolve actual env (stored > env > default) so action handlers see real values
    const valueFields = manifest.config.filter(isValueField);
    const resolvedEnv = resolveConnectorEnv(connectorId, valueFields);
    const pendingActionValues = pickPendingActionValues(request.body, valueFields);
    if (containsRedactedPlaceholder(pendingActionValues)) {
      reply.status(400);
      return { error: 'Refusing to use redacted connector placeholder values' };
    }
    const operationDef = manifest.config.find((f) => isOperationField(f) && f.name === operationName);
    const operationTargetEnvNames =
      operationDef && isOperationField(operationDef) && Array.isArray(operationDef.target) ? operationDef.target : [];
    const previousTargetValues = new Map<string, string | null>();
    if (operationTargetEnvNames.length > 0) {
      const previousConfig = readConnectorConfig(projectRoot, connectorId);
      for (const name of operationTargetEnvNames) {
        previousTargetValues.set(name, previousConfig[name] ?? null);
      }
    }

    const result = await executeConnectorAction({
      projectRoot,
      connectorId,
      operationName,
      actionId,
      manifest,
      plugin,
      pluginCtx: { env: { ...resolvedEnv, ...pendingActionValues }, log: app.log, redis: opts.redis },
      adapter,
      operator: auth.userId,
      auditLog: getEventAuditLog(),
    });

    if (!result.ok) {
      reply.status(result.status ?? 500);
      return { error: result.error };
    }

    // Lifecycle: activate after credential backfill, deactivate on explicit disconnect.
    let activationStatus: 'activated' | 'deactivated' | 'failed' | undefined;
    if (result.activate === false && opts.deactivateConnector) {
      // Disconnect: stop inbound listener, remove adapter/webhook/media
      try {
        await opts.deactivateConnector(connectorId);
        activationStatus = 'deactivated';
        app.log.info({ connectorId }, '[ConnectorHub] Connector deactivated after disconnect');
      } catch (err) {
        activationStatus = 'failed';
        if (operationTargetEnvNames.length > 0) {
          const rollbackUpdates = operationTargetEnvNames.map((name) => ({
            name,
            value: previousTargetValues.get(name) ?? null,
          }));
          const { changedKeys } = writeConnectorConfig(projectRoot, connectorId, rollbackUpdates);
          if (changedKeys.length > 0) {
            configEventBus.emitChange({
              source: 'config-store',
              scope: manifest.source === 'external' ? 'file' : 'key',
              changedKeys,
              changeSetId: createChangeSetId(),
              timestamp: Date.now(),
            });
          }
        }
        writeOperationState(projectRoot, connectorId, operationName, {
          currentAction: actionId,
          lastResult: {
            render: 'status',
            data: { status: 'deactivation_failed' },
            label: 'Deactivation failed',
          },
        });
        app.log.warn({ err, connectorId }, '[ConnectorHub] Connector deactivation failed');
        reply.status(502);
        return {
          ok: false,
          error: 'Connector deactivation failed after action succeeded',
          activationStatus,
        };
      }
    } else if (
      (result.activate === true || (result.backfilledKeys && result.backfilledKeys.length > 0)) &&
      opts.activateConnector
    ) {
      // Connect: create adapter + start inbound after credential backfill
      try {
        await opts.activateConnector(connectorId);
        activationStatus = 'activated';
        app.log.info(
          { connectorId, backfilledKeys: result.backfilledKeys },
          '[ConnectorHub] Connector activated after credential backfill',
        );
      } catch (err) {
        activationStatus = 'failed';
        writeOperationState(projectRoot, connectorId, operationName, {
          currentAction: actionId,
          lastResult: {
            render: 'status',
            data: { status: 'activation_failed' },
            label: 'Activation failed',
          },
        });
        app.log.warn(
          { err, connectorId },
          '[ConnectorHub] Connector activation failed after backfill — may need restart',
        );
        reply.status(502);
        return {
          ok: false,
          error: 'Connector activation failed after action succeeded',
          activationStatus,
        };
      }
    }

    return {
      ok: true,
      render: result.render,
      data: result.data,
      ...(result.label ? { label: result.label } : {}),
      ...(result.backfilledKeys ? { backfilledKeys: result.backfilledKeys } : {}),
      ...(activationStatus ? { activationStatus } : {}),
    };
  });

  // ── F240 A-3: Operation state in status endpoint (AC-A20) ──

  app.get('/api/connectors/:connectorId/operations', async (request, reply) => {
    const userId = requireSessionHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };

    const { connectorId } = request.params as { connectorId: string };
    const manifest = getConnectorManifests().get(connectorId);
    if (!manifest) {
      reply.status(404);
      return { error: `Unknown connector: ${connectorId}` };
    }

    const projectRoot = resolveActiveProjectRoot();
    const states = readAllOperationStates(projectRoot, connectorId);
    return { operations: states };
  });

  // ── F134 Phase D: Connector Permission API ──

  app.get('/api/connector/permissions/:connectorId', async (request, reply) => {
    const userId = requireTrustedHubIdentity(request, reply);
    if (!userId) return { error: 'Identity required' };
    const { connectorId } = request.params as { connectorId: string };
    const store = opts.permissionStore;
    if (!store) {
      return { whitelistEnabled: false, commandAdminOnly: false, adminOpenIds: [], allowedGroups: [] };
    }
    return store.getConfig(connectorId);
  });

  app.put('/api/connector/permissions/:connectorId', async (request, reply) => {
    const auth = requireConnectorWriteIdentity(request, reply);
    if (auth.error) return auth.error;
    const { userId } = auth;
    const { connectorId } = request.params as { connectorId: string };
    const store = opts.permissionStore;
    if (!store) {
      reply.status(503);
      return { error: 'Permission store not available' };
    }
    const body = request.body as {
      whitelistEnabled?: boolean;
      commandAdminOnly?: boolean;
      adminOpenIds?: string[];
      allowedGroups?: Array<{ externalChatId: string; label?: string }>;
    };
    if (body.whitelistEnabled !== undefined) {
      await store.setWhitelistEnabled(connectorId, body.whitelistEnabled);
    }
    if (body.commandAdminOnly !== undefined) {
      await store.setCommandAdminOnly(connectorId, body.commandAdminOnly);
    }
    if (body.adminOpenIds !== undefined) {
      await store.setAdminOpenIds(connectorId, body.adminOpenIds);
    }
    if (body.allowedGroups !== undefined) {
      const current = await store.listAllowedGroups(connectorId);
      for (const g of current) await store.denyGroup(connectorId, g.externalChatId);
      for (const g of body.allowedGroups) await store.allowGroup(connectorId, g.externalChatId, g.label);
    }
    return store.getConfig(connectorId);
  });

  app.post('/api/connector/:id/test', async (request, reply) => {
    const { error } = requireConnectorWriteIdentity(request, reply);
    if (error) return error;

    const { id } = request.params as { id: string };

    if (id === 'wecom-bot') {
      if (!opts.getWeComBotAdapter) {
        return { valid: false, error: '企微机器人适配器未初始化' };
      }
      const adapter = opts.getWeComBotAdapter();
      if (!adapter) {
        return { valid: false, error: '企微机器人未配置' };
      }
      const state = adapter.getConnectionState();
      return { valid: state === 'connected', error: state !== 'connected' ? `当前状态: ${state}` : undefined };
    }

    if (id === 'weixin') {
      const adapter = opts.weixinAdapter;
      if (!adapter) {
        return { valid: false, error: '微信适配器未初始化' };
      }
      const isActive = adapter.hasBotToken() && adapter.isPolling();
      return { valid: isActive, error: !isActive ? '微信未连接（需要扫码登录）' : undefined };
    }

    if (id === 'feishu') {
      const { status } = buildConnectorStatusWithStoredConfig();
      const feishu = status.find((p) => p.id === 'feishu');
      return { valid: feishu?.configured === true, error: !feishu?.configured ? '飞书未配置或凭据无效' : undefined };
    }

    if (id === 'telegram') {
      const { status } = buildConnectorStatusWithStoredConfig();
      const tg = status.find((p) => p.id === 'telegram');
      return { valid: tg?.configured === true, error: !tg?.configured ? 'Telegram Bot Token 未配置' : undefined };
    }

    // F240: Known connector but no dedicated test handler — report unsupported.
    // Real connection testing should be a YAML-declared operation/action (like qr-generate).
    const manifest = getConnectorManifests().get(id);
    const extMeta = !manifest ? getAllExternalConnectorMeta().find((m) => m.id === id) : undefined;
    if (manifest || extMeta) {
      return { valid: false, error: '此连接器暂不支持连接测试', unsupported: true };
    }

    reply.status(400);
    return { valid: false, error: `未知平台: ${id}` };
  });
};
