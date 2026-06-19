/**
 * Connector Gateway Bootstrap
 * Wires all connector gateway components together.
 *
 * Bootstrap pattern:
 * - Takes options with dependencies
 * - Checks env config before starting
 * - Returns lifecycle handle { stop }
 *
 * F088 Multi-Platform Chat Gateway
 * F240 IM Connector Plugin Architecture — unified plugin loop replaces
 *      per-connector inline init blocks. All connectors (built-in + external)
 *      go through the same IMConnectorPlugin interface.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CatId,
  type ConnectorDefinition,
  type ConnectorSource,
  catRegistry,
  isStaticConnectorId,
  isValueField,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyBaseLogger } from 'fastify';
import { isCatAvailable } from '../../config/cat-config-loader.js';
import type { ConnectorWebhookHandler } from '../../routes/connector-webhooks.js';
import { resolveActiveProjectRoot } from '../../utils/active-project-root.js';
import { getDefaultUploadDir } from '../../utils/upload-paths.js';
import { encodeDefault } from '../config-field-parser.js';
import { deliverConnectorMessage } from '../email/deliver-connector-message.js';
import { ConnectorCommandLayer, type ConnectorCommandLayerDeps } from './ConnectorCommandLayer.js';
import {
  type IConnectorPermissionStore,
  MemoryConnectorPermissionStore,
  RedisConnectorPermissionStore,
} from './ConnectorPermissionStore.js';
import { ConnectorRouter } from './ConnectorRouter.js';
import { type IConnectorThreadBindingStore, MemoryConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import { GitHubRepoWebhookHandler } from './github-repo-event/GitHubRepoWebhookHandler.js';
import { ReconciliationDedup } from './github-repo-event/ReconciliationDedup.js';
import { RedisDeliveryDedup } from './github-repo-event/RedisDeliveryDedup.js';
import { InboundMessageDedup } from './InboundMessageDedup.js';
import {
  clearConnectorConfigCache,
  getStoredConnectorValue,
  loadAllConnectorConfigs,
  resolveConnectorEnv,
} from './im-connector-config-store.js';
import type { IMConnectorPluginContext, InboundMessageCallback } from './im-connector-plugin.js';
import { WeComBotAdapter } from './im-connectors/wecom-bot/WeComBotAdapter.js';
import { WeixinAdapter } from './im-connectors/weixin/WeixinAdapter.js';
import { ConnectorMediaService } from './media/ConnectorMediaService.js';
import { MediaCleanupJob } from './media/MediaCleanupJob.js';
import {
  type IOutboundAdapter,
  type IStreamableOutboundAdapter,
  OutboundDeliveryHook,
} from './OutboundDeliveryHook.js';
import { scanConnectorManifests } from './plugins/im-connector-manifest.js';
import { RedisConnectorThreadBindingStore } from './RedisConnectorThreadBindingStore.js';
import { StreamingOutboundHook } from './StreamingOutboundHook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveBuiltinConnectorsDir(): string {
  const sourceAdjacentDir = join(__dirname, 'im-connectors');
  if (existsSync(join(sourceAdjacentDir, 'telegram', 'connector.yaml'))) return sourceAdjacentDir;
  return join(__dirname, '../../../src/infrastructure/connectors/im-connectors');
}

export interface ConnectorGatewayConfig {
  telegramBotToken?: string | undefined;
  feishuAppId?: string | undefined;
  feishuAppSecret?: string | undefined;
  feishuVerificationToken?: string | undefined;
  feishuBotOpenId?: string | undefined;
  feishuAdminOpenIds?: string | undefined;
  /** F134-E: 'webhook' (default) or 'websocket' (long-connection via WSClient) */
  feishuConnectionMode?: 'webhook' | 'websocket' | undefined;
  dingtalkAppKey?: string | undefined;
  dingtalkAppSecret?: string | undefined;
  weixinBotToken?: string | undefined;
  wecomBotId?: string | undefined;
  wecomBotSecret?: string | undefined;
  wecomCorpId?: string | undefined;
  wecomAgentId?: string | undefined;
  wecomAgentSecret?: string | undefined;
  wecomToken?: string | undefined;
  wecomEncodingAesKey?: string | undefined;
  /** Override co-creator userId for connector threads. Read from DEFAULT_OWNER_USER_ID env. */
  coCreatorUserId?: string | undefined;
  whisperUrl?: string | undefined;
  connectorMediaDir?: string | undefined;
  /** F151: XiaoYi OpenClaw 模式 */
  xiaoyiAk?: string | undefined;
  xiaoyiSk?: string | undefined;
  xiaoyiAgentId?: string | undefined;
}

export interface ConnectorGatewayDeps {
  readonly messageStore: {
    append(input: {
      threadId: string;
      userId: string;
      catId: null;
      content: string;
      source: ConnectorSource;
      mentions: CatId[];
      timestamp: number;
    }): Promise<{ id: string }>;
    getById?(id: string): Promise<{ source?: ConnectorSource } | null>;
    getByThreadBefore?(
      threadId: string,
      timestamp: number,
      limit?: number,
    ):
      | Array<{ catId: string | null; userId?: string; content: string; timestamp: number }>
      | Promise<Array<{ catId: string | null; userId?: string; content: string; timestamp: number }>>;
  };
  readonly threadStore: {
    create(userId: string, title?: string): { id: string } | Promise<{ id: string }>;
    get(id: string):
      | {
          id: string;
          title?: string | null;
          createdAt?: number;
          connectorHubState?: {
            v: 1;
            connectorId: string;
            externalChatId: string;
            createdAt: number;
            lastCommandAt?: number;
          };
        }
      | null
      | Promise<{
          id: string;
          title?: string | null;
          createdAt?: number;
          connectorHubState?: {
            v: 1;
            connectorId: string;
            externalChatId: string;
            createdAt: number;
            lastCommandAt?: number;
          };
        } | null>;
    list(
      userId: string,
    ):
      | Array<{ id: string; title?: string | null; lastActiveAt?: number; backlogItemId?: string }>
      | Promise<Array<{ id: string; title?: string | null; lastActiveAt?: number; backlogItemId?: string }>>;
    updateConnectorHubState(
      threadId: string,
      state: { v: 1; connectorId: string; externalChatId: string; createdAt: number; lastCommandAt?: number } | null,
    ): void | Promise<void>;
    /** F142: participant activity for /cats and /status */
    getParticipantsWithActivity?(
      threadId: string,
    ):
      | Array<{ catId: string; lastMessageAt: number; messageCount: number }>
      | Promise<Array<{ catId: string; lastMessageAt: number; messageCount: number }>>;
  };
  /** Phase D: optional backlog store for feat-number matching in /use */
  readonly backlogStore?: {
    get(
      itemId: string,
      userId?: string,
    ): { tags: readonly string[] } | null | Promise<{ tags: readonly string[] } | null>;
  };
  readonly invokeTrigger: {
    trigger(
      threadId: string,
      catId: CatId,
      userId: string,
      message: string,
      messageId: string,
      ...args: unknown[]
    ): Promise<'dispatched' | 'enqueued' | 'full'>;
  };
  readonly socketManager?:
    | {
        broadcastToRoom(room: string, event: string, data: unknown): void;
      }
    | undefined;
  readonly defaultUserId: string;
  readonly defaultCatId: CatId | (() => CatId);
  readonly redis?: RedisClient | undefined;
  readonly log: FastifyBaseLogger;
  readonly frontendBaseUrl?: string | undefined;
  /** F142: agent service registry for /cats command */
  readonly agentRegistry?: { has(catId: string): boolean };
  /** F142-B: unified command registry for /commands listing + audit */
  readonly commandRegistry?: import('../commands/CommandRegistry.js').CommandRegistry;
  /** F142: shared binding store — if provided, gateway reuses it instead of creating a new instance */
  readonly bindingStore?: IConnectorThreadBindingStore;
  /** @internal Test-only: override WSClient factory to avoid real SDK connections */
  readonly _wsClientFactory?:
    | ((opts: { appId: string; appSecret: string }) => {
        start(opts: unknown): Promise<void>;
        close(opts?: unknown): void;
      })
    | undefined;
  /** @internal Test-only: override Feishu token manager (e.g. stub for fail-closed tests) */
  readonly _feishuTokenManagerOverride?: unknown;
}

export interface ConnectorGatewayHandle {
  readonly outboundHook: OutboundDeliveryHook;
  readonly streamingHook: StreamingOutboundHook;
  readonly webhookHandlers: Map<string, ConnectorWebhookHandler>;
  readonly weixinAdapter: InstanceType<typeof WeixinAdapter> | null;
  readonly permissionStore: IConnectorPermissionStore;
  readonly startWeixinPolling: () => void;
  /** F132 Phase E: dynamically start WeCom Bot adapter after credential validation */
  readonly startWeComBotStream: (botId: string, secret: string) => Promise<void>;
  /** F132 Phase E: stop running WeCom Bot adapter (for disconnect) */
  readonly stopWeComBot: () => Promise<void>;
  /** F132 bugfix: live adapter getter for health reporting (instance changes on restart) */
  readonly getWeComBotAdapter: () => WeComBotAdapter | null;
  /** F240 A-3: all discovered plugins, including unconfigured (for generic action endpoint) */
  readonly pluginRegistry: ReadonlyMap<string, import('./im-connector-plugin.js').IMConnectorPlugin>;
  /** F240 A-3: live adapters — only configured+started connectors */
  readonly adapterRegistry: ReadonlyMap<string, IOutboundAdapter>;
  /** F240 A-3: activate a connector after credentials acquired via action (creates adapter + starts inbound) */
  activateConnector(connectorId: string): Promise<void>;
  /** F240 A-3: deactivate a connector — stop inbound, remove adapter/webhook/media */
  deactivateConnector(connectorId: string): Promise<void>;
  stop(): Promise<void>;
}

export function loadConnectorGatewayConfig(): ConnectorGatewayConfig {
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    feishuAppId: process.env.FEISHU_APP_ID,
    feishuAppSecret: process.env.FEISHU_APP_SECRET,
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    feishuBotOpenId: process.env.FEISHU_BOT_OPEN_ID,
    feishuAdminOpenIds: process.env.FEISHU_ADMIN_OPEN_IDS,
    feishuConnectionMode: process.env.FEISHU_CONNECTION_MODE === 'websocket' ? 'websocket' : 'webhook',
    dingtalkAppKey: process.env.DINGTALK_APP_KEY,
    dingtalkAppSecret: process.env.DINGTALK_APP_SECRET,
    weixinBotToken: process.env.WEIXIN_BOT_TOKEN,
    wecomBotId: process.env.WECOM_BOT_ID,
    wecomBotSecret: process.env.WECOM_BOT_SECRET,
    wecomCorpId: process.env.WECOM_CORP_ID,
    wecomAgentId: process.env.WECOM_AGENT_ID,
    wecomAgentSecret: process.env.WECOM_AGENT_SECRET,
    wecomToken: process.env.WECOM_TOKEN,
    wecomEncodingAesKey: process.env.WECOM_ENCODING_AES_KEY,
    coCreatorUserId: process.env.DEFAULT_OWNER_USER_ID,
    whisperUrl: process.env.WHISPER_URL,
    connectorMediaDir: process.env.CONNECTOR_MEDIA_DIR,
    xiaoyiAk: process.env.XIAOYI_AK,
    xiaoyiSk: process.env.XIAOYI_SK,
    xiaoyiAgentId: process.env.XIAOYI_AGENT_ID,
  };
}

type ConnectorAutostartEnv = {
  readonly [key: string]: string | undefined;
  readonly CONNECTOR_GATEWAY_AUTOSTART?: string | undefined;
  readonly CAT_CAFE_RUNTIME_ROOT?: string | undefined;
  readonly NODE_ENV?: string | undefined;
};

function parseBooleanOverride(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

export function isPreconfiguredConnectorAutostartEnabled(env: ConnectorAutostartEnv = process.env): boolean {
  const explicit = parseBooleanOverride(env.CONNECTOR_GATEWAY_AUTOSTART);
  if (explicit !== undefined) return explicit;
  return env.NODE_ENV === 'production' && Boolean(env.CAT_CAFE_RUNTIME_ROOT?.trim());
}

export function applyConnectorGatewayAutostartPolicy(
  config: ConnectorGatewayConfig,
  env: ConnectorAutostartEnv = process.env,
): ConnectorGatewayConfig {
  if (isPreconfiguredConnectorAutostartEnabled(env)) return config;

  return {
    ...config,
    telegramBotToken: undefined,
    feishuAppId: undefined,
    feishuAppSecret: undefined,
    feishuVerificationToken: undefined,
    feishuBotOpenId: undefined,
    feishuAdminOpenIds: undefined,
    dingtalkAppKey: undefined,
    dingtalkAppSecret: undefined,
    weixinBotToken: undefined,
    wecomBotId: undefined,
    wecomBotSecret: undefined,
    wecomCorpId: undefined,
    wecomAgentId: undefined,
    wecomAgentSecret: undefined,
    wecomToken: undefined,
    wecomEncodingAesKey: undefined,
    xiaoyiAk: undefined,
    xiaoyiSk: undefined,
    xiaoyiAgentId: undefined,
  };
}

/**
 * Map ConnectorGatewayConfig fields → env var names.
 * Built-in plugins read from ctx.env (env var names), but tests pass config objects.
 * This bridge ensures backward compatibility with the existing test interface.
 */
function configToEnvMap(config: ConnectorGatewayConfig): Record<string, string | undefined> {
  return {
    TELEGRAM_BOT_TOKEN: config.telegramBotToken,
    FEISHU_APP_ID: config.feishuAppId,
    FEISHU_APP_SECRET: config.feishuAppSecret,
    FEISHU_VERIFICATION_TOKEN: config.feishuVerificationToken,
    FEISHU_BOT_OPEN_ID: config.feishuBotOpenId,
    FEISHU_ADMIN_OPEN_IDS: config.feishuAdminOpenIds,
    FEISHU_CONNECTION_MODE: config.feishuConnectionMode,
    DINGTALK_APP_KEY: config.dingtalkAppKey,
    DINGTALK_APP_SECRET: config.dingtalkAppSecret,
    XIAOYI_AK: config.xiaoyiAk,
    XIAOYI_SK: config.xiaoyiSk,
    XIAOYI_AGENT_ID: config.xiaoyiAgentId,
    WECOM_BOT_ID: config.wecomBotId,
    WECOM_BOT_SECRET: config.wecomBotSecret,
    WECOM_CORP_ID: config.wecomCorpId,
    WECOM_AGENT_ID: config.wecomAgentId,
    WECOM_AGENT_SECRET: config.wecomAgentSecret,
    WECOM_TOKEN: config.wecomToken,
    WECOM_ENCODING_AES_KEY: config.wecomEncodingAesKey,
    WEIXIN_BOT_TOKEN: config.weixinBotToken,
  };
}

/**
 * Create an InboundMessageCallback that routes through ConnectorRouter.
 * This adapts the plugin's message object to the router's positional args.
 */
function createOnMessage(connectorId: string, connectorRouter: ConnectorRouter): InboundMessageCallback {
  return async (msg) => {
    await connectorRouter.route(
      connectorId,
      msg.chatId,
      msg.text,
      msg.messageId,
      msg.attachments?.map((a) => ({
        type: a.type,
        platformKey: a.platformKey,
        ...(a.messageId ? { messageId: a.messageId } : {}),
        ...(a.fileName ? { fileName: a.fileName } : {}),
        ...(a.duration != null ? { duration: a.duration } : {}),
      })),
      msg.sender,
      msg.chatType,
      msg.chatName,
    );
  };
}

function isReachableIconSrc(src: string): boolean {
  return src.startsWith('/') || src.startsWith('http://') || src.startsWith('https://');
}

function normalizeExternalConnectorDefinitionIcon(definition: ConnectorDefinition): ConnectorDefinition {
  const icon = definition.icon;
  if (!('src' in icon) || !icon.src || isReachableIconSrc(icon.src)) return definition;

  const src = `/api/connectors/plugins/${encodeURIComponent(definition.id)}/icon`;
  const normalizedIcon =
    icon.type === 'svg' ? { ...icon, iconId: icon.iconId ?? definition.id, src } : { ...icon, src };

  return { ...definition, icon: normalizedIcon };
}

export async function startConnectorGateway(
  config: ConnectorGatewayConfig,
  deps: ConnectorGatewayDeps,
): Promise<ConnectorGatewayHandle | null> {
  const { log } = deps;

  const bindingStore =
    deps.bindingStore ??
    (deps.redis ? new RedisConnectorThreadBindingStore(deps.redis) : new MemoryConnectorThreadBindingStore());
  const dedup = new InboundMessageDedup();
  log.info({ store: deps.redis ? 'redis' : 'memory' }, '[ConnectorGateway] Binding store initialized');
  const adapters = new Map<string, IOutboundAdapter>();
  const plugins = new Map<string, import('./im-connector-plugin.js').IMConnectorPlugin>();
  const webhookHandlers = new Map<string, ConnectorWebhookHandler>();
  const stopFns = new Set<() => Promise<void>>();
  /** Per-connector inbound stop handles — for targeted deactivation (F240 A-3). */
  const connectorStopFns = new Map<string, () => Promise<void>>();

  // Use coCreatorUserId from config (DEFAULT_OWNER_USER_ID env) if set,
  // otherwise fall back to deps.defaultUserId.
  // This ensures connector threads are created with the real owner's userId,
  // making them visible in the frontend thread list. (F088 ISSUE-1 fix)
  const effectiveUserId = config.coCreatorUserId || deps.defaultUserId;

  // F134 Phase D: Permission store + admin config
  const adminOpenIds = config.feishuAdminOpenIds
    ? config.feishuAdminOpenIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const permissionStore: IConnectorPermissionStore = deps.redis
    ? new RedisConnectorPermissionStore(deps.redis)
    : new MemoryConnectorPermissionStore();
  if (adminOpenIds.length > 0) {
    const alreadyConfigured = await permissionStore.hasAdminConfig('feishu');
    if (!alreadyConfigured) {
      await permissionStore.setAdminOpenIds('feishu', adminOpenIds);
      log.info(
        { adminCount: adminOpenIds.length },
        '[ConnectorGateway] Feishu admin open_ids seeded from env (first boot)',
      );
    } else {
      log.info('[ConnectorGateway] Feishu admin config already persisted, env seed skipped');
    }
  }

  // F142: build catRoster from catRegistry (.cat-cafe/cat-catalog.json)
  const catRoster = Object.fromEntries(
    Object.entries(catRegistry.getAllConfigs()).map(([id, config]) => [
      id,
      { displayName: config.displayName, available: isCatAvailable(id) },
    ]),
  );

  const commandLayer = new ConnectorCommandLayer({
    bindingStore,
    threadStore: deps.threadStore,
    ...(deps.backlogStore ? { backlogStore: deps.backlogStore } : {}),
    frontendBaseUrl: deps.frontendBaseUrl ?? 'http://localhost:3003',
    permissionStore,
    // F142: wire /cats and /status deps (threadStore has getParticipantsWithActivity at runtime)
    ...(deps.threadStore.getParticipantsWithActivity
      ? { participantStore: deps.threadStore as unknown as ConnectorCommandLayerDeps['participantStore'] }
      : {}),
    agentRegistry: deps.agentRegistry,
    catRoster,
    commandRegistry: deps.commandRegistry,
    ...(deps.messageStore.getByThreadBefore
      ? {
          messageStore: {
            getByThreadBefore: (threadId: string, timestamp: number, limit?: number) =>
              deps.messageStore.getByThreadBefore!(threadId, timestamp, limit),
          },
        }
      : {}),
  });

  // Phase 5+6: Media service + STT provider (optional)
  const mediaDir = config.connectorMediaDir ?? './data/connector-media';
  const mediaService = new ConnectorMediaService({
    mediaDir,
  });

  let sttProvider:
    | { transcribe(request: { audioPath: string; language?: string }): Promise<{ text: string }> }
    | undefined;
  if (config.whisperUrl) {
    const { WhisperSttProvider } = await import('./media/WhisperSttProvider.js');
    sttProvider = new WhisperSttProvider({ baseUrl: config.whisperUrl });
  }

  const connectorRouter = new ConnectorRouter({
    bindingStore,
    dedup,
    messageStore: deps.messageStore,
    threadStore: deps.threadStore,
    invokeTrigger: deps.invokeTrigger,
    socketManager: deps.socketManager,
    defaultUserId: effectiveUserId,
    defaultCatId: deps.defaultCatId,
    log,
    commandLayer,
    permissionStore,
    adapters,
    mediaService,
    sttProvider,
  });

  // ── F240: Load & initialize all IM connector plugins ──
  const { loadBuiltinConnectors, loadInstalledPlugins } = await import('./im-connector-loader.js');
  const { registerConnectorDefinition } = await import('@cat-cafe/shared');
  const { clearExternalConnectorRegistry, registerExternalConnectorMeta, updateExternalConnectorConfigured } =
    await import('./external-connector-registry.js');

  const projectRoot = resolveActiveProjectRoot();
  clearExternalConnectorRegistry();
  const builtinPlugins = await loadBuiltinConnectors();
  const installedPlugins = await loadInstalledPlugins(projectRoot, log);

  const configEnv = configToEnvMap(config);
  const builtinIds = new Set(builtinPlugins.map((p) => p.id));

  function refreshExternalConfiguredStatus(connectorId: string): void {
    if (isStaticConnectorId(connectorId)) return;
    const plugin = plugins.get(connectorId);
    const manifest = manifests.get(connectorId);
    if (!plugin || !manifest) return;
    clearConnectorConfigCache();
    loadAllConnectorConfigs(projectRoot, [...manifests.values()]);
    const freshEnv = resolveConnectorEnv(connectorId, manifest.config.filter(isValueField));
    updateExternalConnectorConfigured(connectorId, plugin.isConfigured(freshEnv));
  }

  // Reject installed plugins that conflict with built-in IDs or each other
  const seenExternalIds = new Set<string>();
  const externalPlugins = installedPlugins.filter((ext) => {
    if (builtinIds.has(ext.id)) {
      log.warn({ id: ext.id }, '[Gateway] External connector ID conflicts with built-in — skipped');
      return false;
    }
    if (seenExternalIds.has(ext.id)) {
      log.warn({ id: ext.id }, '[Gateway] Duplicate external connector ID — skipped');
      return false;
    }
    seenExternalIds.add(ext.id);
    return true;
  });
  const allPlugins = [...builtinPlugins, ...externalPlugins];

  // ── F240: Scan connector YAML manifests & load stored configs ──
  // Built-in manifests live in source tree; installed plugin manifests in .cat-cafe/plugins/
  const connectorsDir = resolveBuiltinConnectorsDir();
  const manifests = scanConnectorManifests(connectorsDir);

  // Phase B: also scan installed plugin manifests
  const { resolvePluginsDir } = await import('./plugins/plugin-installer.js');
  const pluginManifests = scanConnectorManifests(resolvePluginsDir(projectRoot));
  for (const [id, manifest] of pluginManifests) {
    if (!manifests.has(id)) manifests.set(id, manifest);
  }

  const storedConfigCount = loadAllConnectorConfigs(projectRoot, [...manifests.values()]);
  if (manifests.size > 0 || storedConfigCount > 0) {
    log.info(
      { manifests: manifests.size, storedConfigs: storedConfigCount },
      '[F240] Connector manifests and config store loaded',
    );
  }

  // Detect invalid telegram token (token provided but malformed — preserves warning for user)
  const telegramPlugin = allPlugins.find((p) => p.id === 'telegram');
  if (configEnv.TELEGRAM_BOT_TOKEN?.trim() && telegramPlugin && !telegramPlugin.isConfigured(configEnv)) {
    log.warn('[ConnectorGateway] Invalid TELEGRAM_BOT_TOKEN format — Telegram connector disabled');
  }

  // Special lifecycle refs needed by ConnectorGatewayHandle
  let weixinAdapterRef: InstanceType<typeof WeixinAdapter> | null = null;
  let startWeixinPollingFn: (() => void) | null = null;

  // WeComBot dynamic lifecycle (Hub-managed start/stop)
  let wecomBotStopFn: (() => Promise<void>) | null = null;
  stopFns.add(async () => wecomBotStopFn?.());
  const wecomBotPlugin = allPlugins.find((p) => p.id === 'wecom-bot');

  // ── Unified plugin initialization loop ──
  for (const plugin of allPlugins) {
    const isBuiltin = builtinIds.has(plugin.id);

    // WeComBot stream startup is handled separately, but the plugin must stay
    // registered so Hub action routes can validate/connect before credentials exist.
    if (plugin.id === 'wecom-bot') {
      plugins.set(plugin.id, plugin);
      continue;
    }

    // External plugin validation
    if (!isBuiltin) {
      if (isStaticConnectorId(plugin.id)) {
        log.warn({ id: plugin.id }, '[F240] External plugin ID conflicts with built-in connector — skipped');
        continue;
      }
      if (plugin.definition.id !== plugin.id) {
        log.warn(
          { pluginId: plugin.id, definitionId: plugin.definition.id },
          '[F240] Plugin id/definition.id mismatch — skipped',
        );
        continue;
      }
      const normalizedDefinition = normalizeExternalConnectorDefinitionIcon(plugin.definition);
      // Register metadata early for Hub discovery — even unconfigured plugins
      // should appear in status so users can see what env vars to fill.
      // (R2 fix: moved from post-init to post-validation)
      registerConnectorDefinition(normalizedDefinition);
      registerExternalConnectorMeta({
        id: plugin.id,
        definition: normalizedDefinition,
        requiredEnvKeys: plugin.requiredEnvKeys,
        optionalEnvKeys: plugin.optionalEnvKeys ?? [],
        configured: false, // updated after isConfigured() check below
      });
    }

    // Build env for this plugin — F240: stored (Hub UI) > config param (env/test) > YAML default
    // KD-17: only value fields have envName; KD-18: defaults encoded through codec
    // R5-P1 fix: installed plugins with manifest also use config store (was gated on isBuiltin)
    const pluginEnv: Record<string, string | undefined> = {};
    const manifest = manifests.get(plugin.id);
    const manifestValueFields = manifest ? manifest.config.filter(isValueField) : [];
    for (const key of [...plugin.requiredEnvKeys, ...(plugin.optionalEnvKeys ?? [])]) {
      if (manifest) {
        const stored = getStoredConnectorValue(plugin.id, key);
        if (stored === null) {
          // KD-19 tombstone: user cleared this field in Hub — block all fallback
          pluginEnv[key] = undefined;
        } else if (stored !== undefined) {
          pluginEnv[key] = stored;
        } else {
          // Built-in: configEnv has mapped values from loadConnectorGatewayConfig()
          // Installed: configEnv has no mapping for plugin keys — fall to process.env
          const envVal = isBuiltin ? configEnv[key] : process.env[key];
          const yamlField = manifestValueFields.find((f) => f.envName === key);
          const yamlDefault = yamlField ? encodeDefault(yamlField) : undefined;
          pluginEnv[key] = envVal ?? yamlDefault;
        }
      } else {
        // Legacy npm plugins without manifest — no config store path
        pluginEnv[key] = isBuiltin ? configEnv[key] : process.env[key];
      }
    }

    // Weixin always creates adapter (for QR login support even without credentials)
    const isWeixin = plugin.id === 'weixin';
    const isConfigured = plugin.isConfigured(pluginEnv);

    // Update external plugin metadata with actual isConfigured() result (cloud P2 fix:
    // Hub must use plugin's own predicate, not the all-requiredEnvKeys heuristic)
    if (!isBuiltin) updateExternalConnectorConfigured(plugin.id, isConfigured);

    // F240 A-3 fix: Always register plugin (for action endpoints even when unconfigured).
    // Adapters are only created below when configured — plugin code is always available.
    plugins.set(plugin.id, plugin);

    if (!isConfigured && !isWeixin) {
      log.info(
        { id: plugin.id },
        `[ConnectorGateway] ${plugin.definition.displayName} not configured — skipped (plugin registered for actions)`,
      );
      continue;
    }

    // Build context with test overrides (Feishu: tokenManager + wsClientFactory)
    const testOverrides: Record<string, unknown> = {};
    if (plugin.id === 'feishu') {
      if (deps._feishuTokenManagerOverride) testOverrides.feishuTokenManager = deps._feishuTokenManagerOverride;
      if (deps._wsClientFactory) testOverrides.wsClientFactory = deps._wsClientFactory;
    }
    const ctx: IMConnectorPluginContext = {
      env: pluginEnv,
      log,
      redis: deps.redis,
      ...(Object.keys(testOverrides).length > 0 ? { _testOverrides: testOverrides } : {}),
    };

    try {
      const adapter = await Promise.resolve(plugin.createAdapter(ctx));
      if (plugin.setup) await plugin.setup(adapter, ctx);

      const onMessage = createOnMessage(plugin.id, connectorRouter);

      // Accumulate optional resources locally before committing (atomic init)
      let localWebhookHandler: ConnectorWebhookHandler | undefined;
      let localInboundHandle: { stop: () => Promise<void> } | undefined;
      let localMediaDownloadFn:
        | ((platformKey: string, type: string, messageId?: string) => Promise<Buffer>)
        | undefined;

      try {
        if (plugin.createWebhookHandler && isConfigured) {
          localWebhookHandler = plugin.createWebhookHandler(adapter, onMessage, ctx) ?? undefined;
        }
        // Weixin inbound is managed via startWeixinPolling (Hub QR login flow)
        if (plugin.startInbound && isConfigured && !isWeixin) {
          localInboundHandle = await plugin.startInbound(adapter, onMessage, ctx);
        }
        if (plugin.createMediaDownloader) {
          localMediaDownloadFn = plugin.createMediaDownloader(adapter, ctx);
        }
      } catch (stepErr) {
        if (localInboundHandle) {
          try {
            await localInboundHandle.stop();
          } catch (stopErr) {
            log.warn({ err: stopErr, id: plugin.id }, '[ConnectorGateway] Failed to stop inbound during rollback');
          }
        }
        throw stepErr;
      }

      // All resources created — commit atomically
      adapters.set(plugin.id, adapter);
      plugins.set(plugin.id, plugin);
      if (localWebhookHandler) webhookHandlers.set(plugin.id, localWebhookHandler);
      if (localInboundHandle) {
        const stopInbound = () => localInboundHandle!.stop();
        stopFns.add(stopInbound);
        connectorStopFns.set(plugin.id, stopInbound);
      }
      if (localMediaDownloadFn) mediaService.registerDownloadFn(plugin.id, localMediaDownloadFn);
      // ── Weixin special lifecycle: always-create + QR login managed polling ──
      if (isWeixin) {
        weixinAdapterRef = adapter as InstanceType<typeof WeixinAdapter>;
        const capturedOnMessage = onMessage;
        startWeixinPollingFn = () => {
          weixinAdapterRef!.startPolling(async (msg) => {
            const attachments = msg.attachments?.map((a) => ({
              type: a.type,
              platformKey: a.mediaUrl,
              ...(a.fileName ? { fileName: a.fileName } : {}),
            }));
            await capturedOnMessage({ chatId: msg.chatId, text: msg.text, messageId: msg.messageId, attachments });
          });
        };
        stopFns.add(async () => weixinAdapterRef!.stopPolling());

        if (isConfigured) {
          startWeixinPollingFn();
          log.info('[ConnectorGateway] WeChat adapter started (iLink Bot long polling)');
        } else {
          log.info('[ConnectorGateway] WeChat adapter registered (awaiting QR login)');
        }
      }

      log.info({ id: plugin.id }, `[ConnectorGateway] ${plugin.definition.displayName} initialized`);
    } catch (err) {
      log.error({ err, id: plugin.id }, `[ConnectorGateway] ${plugin.definition.displayName} failed to initialize`);
    }
  }

  // ── F141: GitHub Repo Inbox webhook handler (not an IM connector) ──
  const ghWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const ghRepoAllowlist = process.env.GITHUB_REPO_ALLOWLIST;
  const ghInboxCatId = process.env.GITHUB_REPO_INBOX_CAT_ID;

  if (ghWebhookSecret && ghRepoAllowlist && ghInboxCatId && deps.redis) {
    const ghDedup = new RedisDeliveryDedup(deps.redis as import('./github-repo-event/RedisDeliveryDedup.js').RedisLike);
    const ghReconciliationDedup = new ReconciliationDedup(
      deps.redis as import('./github-repo-event/ReconciliationDedup.js').ReconciliationRedisLike,
    );

    // F168 Phase A P1-1b: create community event services from deps.redis for webhook handler
    let ghEventLog: import('../../domains/community/CommunityEventLog.js').ICommunityEventLog | undefined;
    let ghProjector: { apply(event: unknown): Promise<void> } | undefined;
    try {
      const [elMod, osMod, pjMod] = await Promise.all([
        import('../../domains/community/CommunityEventLog.js'),
        import('../../domains/community/CommunityObjectStore.js'),
        import('../../domains/community/community-projector.js'),
      ]);
      const ghObjectStore = new osMod.RedisCommunityObjectStore(deps.redis);
      ghEventLog = new elMod.RedisCommunityEventLog(deps.redis);
      ghProjector = new pjMod.CommunityProjector(ghEventLog, ghObjectStore);
    } catch (err) {
      log.warn({ err }, '[F168] Failed to initialize community event services for webhook handler — events disabled');
    }

    const ghHandler = new GitHubRepoWebhookHandler(
      {
        webhookSecret: ghWebhookSecret,
        repoAllowlist: ghRepoAllowlist.split(',').map((r) => r.trim()),
        inboxCatId: ghInboxCatId,
        defaultUserId: effectiveUserId,
      },
      {
        bindingStore,
        threadStore: deps.threadStore,
        deliverFn: deliverConnectorMessage,
        invokeTrigger: deps.invokeTrigger,
        dedup: ghDedup,
        reconciliationDedup: ghReconciliationDedup,
        redis: deps.redis as import('./github-repo-event/RedisDeliveryDedup.js').RedisLike,
        deliveryDeps: {
          messageStore:
            deps.messageStore as import('../../domains/cats/services/stores/ports/MessageStore.js').IMessageStore,
          socketManager: deps.socketManager,
        },
        // F168 Phase A P1-1b: pass community event services to webhook handler
        eventLog: ghEventLog,
        projector:
          ghProjector as import('./github-repo-event/GitHubRepoWebhookHandler.js').GitHubRepoHandlerDeps['projector'],
      },
    );
    webhookHandlers.set('github-repo-event', ghHandler);
    log.info('[F141] GitHub Repo Inbox webhook handler registered');
  } else if (ghWebhookSecret || ghRepoAllowlist || ghInboxCatId) {
    log.warn('[F141] GitHub Repo Inbox partially configured — set all 3 env vars + Redis to enable');
  }

  const streamableAdapters = new Map<string, IStreamableOutboundAdapter>();
  const syncStreamableAdapter = (connectorId: string, adapter: IOutboundAdapter): void => {
    if ('sendPlaceholder' in adapter && 'editMessage' in adapter) {
      streamableAdapters.set(connectorId, adapter as IStreamableOutboundAdapter);
    } else {
      streamableAdapters.delete(connectorId);
    }
  };

  // ── WeComBot: dynamic start/stop lifecycle (F132 Phase E — Hub guided setup) ──
  const startWeComBotStream = async (botId: string, secret: string) => {
    if (!wecomBotPlugin) {
      log.error('[ConnectorGateway] WeCom Bot plugin not available — cannot start');
      return;
    }

    if (wecomBotStopFn) {
      await wecomBotStopFn();
      wecomBotStopFn = null;
    }

    const dynEnv: Record<string, string | undefined> = { WECOM_BOT_ID: botId, WECOM_BOT_SECRET: secret };
    const dynCtx: IMConnectorPluginContext = { env: dynEnv, log, redis: deps.redis };
    const adapter = await Promise.resolve(wecomBotPlugin.createAdapter(dynCtx));
    if (wecomBotPlugin.setup) await wecomBotPlugin.setup(adapter, dynCtx);

    const onMessage = createOnMessage('wecom-bot', connectorRouter);
    let inboundHandle: { stop: () => Promise<void> } | undefined;
    if (wecomBotPlugin.startInbound) {
      inboundHandle = await wecomBotPlugin.startInbound(adapter, onMessage, dynCtx);
    }
    if (wecomBotPlugin.createMediaDownloader) {
      mediaService.registerDownloadFn('wecom-bot', wecomBotPlugin.createMediaDownloader(adapter, dynCtx));
    }

    adapters.set('wecom-bot', adapter);
    syncStreamableAdapter('wecom-bot', adapter);
    plugins.set('wecom-bot', wecomBotPlugin);
    wecomBotStopFn = async () => {
      if (inboundHandle) await inboundHandle.stop();
      adapters.delete('wecom-bot');
      streamableAdapters.delete('wecom-bot');
      connectorStopFns.delete('wecom-bot');
    };
    connectorStopFns.set('wecom-bot', wecomBotStopFn);
    log.info('[ConnectorGateway] WeCom Bot adapter started (WebSocket mode)');
  };

  const stopWeComBot = async () => {
    if (wecomBotStopFn) {
      await wecomBotStopFn();
      wecomBotStopFn = null;
      log.info('[ConnectorGateway] WeCom Bot adapter stopped');
    }
  };

  // F240: WeComBot config — three-state resolution (KD-19 tombstone aware)
  const storedBotId = getStoredConnectorValue('wecom-bot', 'WECOM_BOT_ID');
  const storedBotSecret = getStoredConnectorValue('wecom-bot', 'WECOM_BOT_SECRET');
  // null = tombstone (user cleared) → block fallback; undefined = absent → fall through
  const effectiveWecomBotId = storedBotId === null ? undefined : (storedBotId ?? config.wecomBotId);
  const effectiveWecomBotSecret = storedBotSecret === null ? undefined : (storedBotSecret ?? config.wecomBotSecret);
  if (effectiveWecomBotId && effectiveWecomBotSecret) {
    await startWeComBotStream(effectiveWecomBotId, effectiveWecomBotSecret);
  }

  // Log if no connectors are active (excluding weixin which is always registered)
  const activeConnectors = [...adapters.keys()].filter((id) => id !== 'weixin');
  if (activeConnectors.length === 0) {
    log.info('[ConnectorGateway] No pre-configured connectors — gateway created for WeChat QR login support');
  }

  // R3-P1: Resolve route URLs to local file paths for real media delivery
  const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
  const ttsCacheDir = resolve(process.env.TTS_CACHE_DIR ?? './data/tts-cache');
  const resolvedMediaDir = resolve(mediaDir);
  const webPublicDir = resolve(process.env.WEB_PUBLIC_DIR ?? '../web/public');
  const mediaPathResolver = (url: string): string | undefined => {
    // Phase J P1: guard against path traversal (e.g. /uploads/../../etc/passwd)
    const safeResolve = (base: string, suffix: string): string | undefined => {
      const resolved = resolve(base, suffix);
      if (!(resolved.startsWith(base + '/') || resolved === base)) return undefined;
      return existsSync(resolved) ? resolved : undefined;
    };
    if (url.startsWith('/uploads/')) return safeResolve(uploadDir, url.slice('/uploads/'.length));
    if (url.startsWith('/api/tts/audio/')) return safeResolve(ttsCacheDir, url.slice('/api/tts/audio/'.length));
    if (url.startsWith('/api/connector-media/'))
      return safeResolve(resolvedMediaDir, url.slice('/api/connector-media/'.length));
    if (url.startsWith('/avatars/')) return safeResolve(webPublicDir, url.slice(1));
    return undefined;
  };

  const messageLookup = deps.messageStore.getById
    ? async (messageId: string) => deps.messageStore.getById!(messageId)
    : undefined;

  const outboundHook = new OutboundDeliveryHook({
    bindingStore,
    adapters,
    log,
    mediaPathResolver,
    messageLookup,
    resolveVoiceBlocks: async (blocks, catId) => {
      const { getVoiceBlockSynthesizer } = await import('../../domains/cats/services/tts/VoiceBlockSynthesizer.js');
      const synth = getVoiceBlockSynthesizer();
      if (!synth) throw new Error('VoiceBlockSynthesizer not initialized');
      return synth.resolveVoiceBlocks(blocks, catId);
    },
  });

  // Build streamable adapters map (only adapters with sendPlaceholder + editMessage)
  for (const [id, adapter] of adapters) {
    syncStreamableAdapter(id, adapter);
  }

  const streamingHook = new StreamingOutboundHook({
    bindingStore,
    adapters: streamableAdapters,
    log,
  });

  // Phase 5b: Media file cleanup (24h TTL, sweep every hour)
  const cleanupJob = new MediaCleanupJob({
    mediaDir: resolvedMediaDir,
    ttlMs: 24 * 60 * 60 * 1000,
    intervalMs: 60 * 60 * 1000,
    log,
  });
  cleanupJob.start();
  log.info('[ConnectorGateway] Media cleanup job started (24h TTL, 1h sweep)');

  // F240 A-3: Activate a connector after credentials acquired via action.
  // Re-reads config, creates adapter, starts inbound. Used by generic action endpoint
  // after QR-based credential backfill.
  async function activateConnector(connectorId: string): Promise<void> {
    const plugin = plugins.get(connectorId);
    if (!plugin) throw new Error(`Plugin '${connectorId}' not registered`);

    // Weixin uses special lifecycle (startWeixinPollingFn)
    if (connectorId === 'weixin') {
      if (startWeixinPollingFn) {
        startWeixinPollingFn();
        log.info('[ConnectorGateway] WeChat polling activated after QR login');
      }
      return;
    }

    // Already has a live adapter — skip (may need restart logic later)
    if (adapters.has(connectorId)) {
      if (!isStaticConnectorId(connectorId)) updateExternalConnectorConfigured(connectorId, true);
      log.info({ id: connectorId }, '[ConnectorGateway] Connector already active — skipping activation');
      return;
    }

    // Reload config cache from disk (action handler just wrote to .cat-cafe/)
    // then resolve env using the standard stored > env > default chain.
    const manifest = manifests.get(connectorId);
    if (!manifest) throw new Error(`Manifest not found for '${connectorId}'`);
    clearConnectorConfigCache();
    loadAllConnectorConfigs(projectRoot, [...manifests.values()]);
    const freshEnv = resolveConnectorEnv(connectorId, manifest.config.filter(isValueField));

    if (!plugin.isConfigured(freshEnv)) {
      log.warn({ id: connectorId }, '[ConnectorGateway] Connector still not configured after backfill');
      throw new Error(`Connector '${connectorId}' still not configured after backfill`);
    }

    const ctx: IMConnectorPluginContext = { env: freshEnv, log, redis: deps.redis };
    const adapter = await Promise.resolve(plugin.createAdapter(ctx));
    if (plugin.setup) await plugin.setup(adapter, ctx);

    const onMessage = createOnMessage(connectorId, connectorRouter);
    let localWebhookHandler: ConnectorWebhookHandler | undefined;
    let localInboundHandle: { stop: () => Promise<void> } | undefined;
    let localMediaDownloadFn: ((platformKey: string, type: string, messageId?: string) => Promise<Buffer>) | undefined;
    try {
      if (plugin.createWebhookHandler) {
        localWebhookHandler = plugin.createWebhookHandler(adapter, onMessage, ctx) ?? undefined;
      }
      if (plugin.startInbound) {
        localInboundHandle = await plugin.startInbound(adapter, onMessage, ctx);
      }
      if (plugin.createMediaDownloader) {
        localMediaDownloadFn = plugin.createMediaDownloader(adapter, ctx);
      }
    } catch (stepErr) {
      if (localInboundHandle) {
        try {
          await localInboundHandle.stop();
        } catch (stopErr) {
          log.warn(
            { err: stopErr, id: connectorId },
            '[ConnectorGateway] Failed to stop inbound during activation rollback',
          );
        }
      }
      throw stepErr;
    }

    adapters.set(connectorId, adapter);
    syncStreamableAdapter(connectorId, adapter);
    if (plugin.createWebhookHandler) {
      if (localWebhookHandler) webhookHandlers.set(connectorId, localWebhookHandler);
    }
    if (localInboundHandle) {
      let stopInbound = () => localInboundHandle!.stop();
      if (connectorId === 'wecom-bot') {
        let stopped = false;
        stopInbound = async () => {
          if (stopped) return;
          stopped = true;
          await localInboundHandle!.stop();
          adapters.delete('wecom-bot');
          streamableAdapters.delete('wecom-bot');
          connectorStopFns.delete('wecom-bot');
          mediaService.unregisterDownloadFn('wecom-bot');
        };
        wecomBotStopFn = stopInbound;
      }
      stopFns.add(stopInbound);
      connectorStopFns.set(connectorId, stopInbound);
    }
    if (localMediaDownloadFn) mediaService.registerDownloadFn(connectorId, localMediaDownloadFn);
    if (!isStaticConnectorId(connectorId)) updateExternalConnectorConfigured(connectorId, true);

    log.info(
      { id: connectorId },
      `[ConnectorGateway] ${plugin.definition.displayName} activated after credential backfill`,
    );
  }

  // F240 A-3: Deactivate a connector — stop inbound, remove adapter/webhook/media.
  // Symmetric counterpart to activateConnector. Called on explicit disconnect actions.
  async function deactivateConnector(connectorId: string): Promise<void> {
    // Weixin uses an always-created adapter (QR login state carrier).
    // The handler already called weixinAdapter.disconnect() which stops polling
    // and clears the token. We must NOT remove the adapter — it's needed for
    // the next QR login cycle to inject a fresh token into the live object.
    if (connectorId === 'weixin') {
      log.info({ id: connectorId }, '[ConnectorGateway] Weixin deactivated (adapter retained for QR re-login)');
      return;
    }

    // Stop inbound listener (WebSocket, long-poll, etc.)
    const stopInbound = connectorStopFns.get(connectorId);
    let stopErr: unknown;
    if (stopInbound) {
      try {
        await stopInbound();
      } catch (err) {
        log.warn({ err, id: connectorId }, '[ConnectorGateway] Error stopping inbound during deactivation');
        stopErr = err;
      } finally {
        connectorStopFns.delete(connectorId);
        stopFns.delete(stopInbound);
        if (connectorId === 'wecom-bot') wecomBotStopFn = null;
      }
    }

    // Remove adapter, webhook handler, media downloader
    adapters.delete(connectorId);
    streamableAdapters.delete(connectorId);
    webhookHandlers.delete(connectorId);
    mediaService.unregisterDownloadFn(connectorId);
    refreshExternalConfiguredStatus(connectorId);

    log.info({ id: connectorId }, '[ConnectorGateway] Connector deactivated');
    if (stopErr) throw stopErr;
  }

  return {
    outboundHook,
    streamingHook,
    webhookHandlers,
    weixinAdapter: weixinAdapterRef,
    permissionStore,
    startWeixinPolling: startWeixinPollingFn ?? (() => {}),
    startWeComBotStream,
    stopWeComBot,
    getWeComBotAdapter: () => (adapters.get('wecom-bot') as WeComBotAdapter) ?? null,
    pluginRegistry: plugins,
    adapterRegistry: adapters,
    activateConnector,
    deactivateConnector,
    async stop() {
      cleanupJob.stop();
      await Promise.allSettled([...stopFns].map((fn) => fn()));
      log.info('[ConnectorGateway] Stopped');
    },
  };
}
