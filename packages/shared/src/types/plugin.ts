/**
 * Plugin Framework Types — F202 声明式插件注册与资源编排
 *
 * F240 KD-15: PluginConfigField replaced by shared ValueConfigField.
 * Alias kept for import compatibility during transition; plugins only use value fields.
 */

import type { ValueConfigField } from './config-field.js';

/** @deprecated Use ValueConfigField from config-field.ts directly. */
export type PluginConfigField = ValueConfigField;

/**
 * Human-readable plugin description carried by plugin.yaml.
 *
 * A plain string remains valid for legacy manifests. New manifests can keep a
 * locale-independent default plus BCP-47-keyed translations. The complete
 * value is projected to both Agent and Console consumers so neither surface
 * grows a second metadata store.
 */
export interface PluginLocalizedText {
  default: string;
  translations: Readonly<Record<string, string>>;
}

export type PluginDescription = string | PluginLocalizedText;

/** Legacy Hub icon name, or a package-relative SVG/PNG asset. */
export type PluginIconSpec = string | { type: 'svg' | 'png'; src: string };

function normalizeLocale(locale: string): string {
  return locale.trim().replaceAll('_', '-').toLocaleLowerCase();
}

export function resolvePluginDescription(description: PluginDescription, locale?: string): string {
  if (typeof description === 'string') return description;
  if (!locale) return description.default;

  const requested = normalizeLocale(locale);
  const language = requested.split('-')[0];
  const entries = Object.entries(description.translations);
  return (
    entries.find(([candidate]) => normalizeLocale(candidate) === requested)?.[1] ??
    entries.find(([candidate]) => normalizeLocale(candidate) === language)?.[1] ??
    description.default
  );
}

/** All text variants used by catalog/Host search. */
export function pluginDescriptionVariants(description: PluginDescription): string[] {
  return typeof description === 'string'
    ? [description]
    : [description.default, ...Object.values(description.translations)];
}

/** Plugin health check declaration */
export interface PluginHealthCheck {
  limbCommand?: string;
  mcpProbe?: string;
}

/** Plugin resource declaration */
export interface PluginResourceDef {
  type: 'skill' | 'mcp' | 'limb' | 'schedule';
  /** F202 Phase 2: Factory ID for schedule resources (white-list reference, no arbitrary scripts) */
  factoryId?: string;
  /** F202 Phase 2 follow-up: optional resources don't count toward 'partial' status when deps are missing */
  optional?: boolean;
  path?: string;
  name?: string;
  command?: string;
  args?: string[];
  transport?: string;
  url?: string;
}

/** Parsed plugin manifest (from plugin.yaml) */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: PluginDescription;
  icon?: PluginIconSpec;
  iconBg?: string;
  builtin?: boolean;
  docsUrl?: string;
  setupSteps?: string[];
  config: PluginConfigField[];
  healthCheck?: PluginHealthCheck;
  resources: PluginResourceDef[];
}

/** Derived plugin status */
export type PluginStatus = 'enabled' | 'configured' | 'not_configured' | 'partial';

/** Per-resource activation status */
export interface PluginResourceStatus {
  type: string;
  path?: string;
  name?: string;
  enabled: boolean;
  error?: string;
}

/** Full plugin info returned by API (manifest + derived state) */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: PluginDescription;
  icon?: PluginIconSpec;
  iconBg?: string;
  docsUrl?: string;
  setupSteps?: string[];
  status: PluginStatus;
  configured: boolean;
  /** Config fields with current values. `sensitive` is computed from field type. */
  config: (ValueConfigField & { currentValue: string | null; sensitive: boolean })[];
  healthCheck?: PluginHealthCheck;
  resources: PluginResourceStatus[];
  hasHealthCheck: boolean;
}

/**
 * F202 terminal Plugin Manager public operations.
 *
 * This is intentionally narrower than internal lifecycle services. Generic
 * update/repair are not user or Agent capabilities.
 */
export const PLUGIN_MANAGER_PUBLIC_OPERATIONS = [
  'list',
  'search',
  'get',
  'install',
  'set-enabled',
  'uninstall',
] as const;

export type PluginManagerPublicOperation = (typeof PLUGIN_MANAGER_PUBLIC_OPERATIONS)[number];

export type PluginManagerArtifactState = 'absent' | 'staged' | 'verified' | 'installed' | 'quarantined';
export type PluginManagerConfigState = 'incomplete' | 'ready' | 'invalid';
export type PluginManagerAuthState = 'not-required' | 'disconnected' | 'pending' | 'connected' | 'expired' | 'error';
export type PluginManagerIntentState = 'disabled' | 'enabled';
export type PluginManagerLiveState = 'stopped' | 'starting' | 'handshaking' | 'running' | 'degraded' | 'crashed';

export type PluginManagerPackageSource =
  | {
      kind: 'catalog';
      catalogId: string;
      packageName: string;
      trust: 'official';
    }
  | {
      kind: 'local-directory' | 'local-archive';
      packageName: string | null;
      trust: 'local-trusted';
    }
  | {
      kind: 'bundled';
      packageName: string;
      trust: 'first-party';
    }
  | {
      /** Train B read-only bridge. Train C replaces this row with Host inventory provenance. */
      kind: 'compatibility';
      adapter: 'repository-local';
      packageName: string;
      trust: 'first-party';
    }
  | {
      /** Connector bridges are locally admitted, but they are not bundled first-party code. */
      kind: 'compatibility';
      adapter: 'connector';
      packageName: string;
      trust: 'local-trusted';
    }
  | {
      /** Pre-provenance inventory retained for safe disable/uninstall only. */
      kind: 'legacy';
      packageName: string | null;
      trust: 'unknown';
    };

export type PluginManagerCapabilityKind =
  | 'mcp'
  | 'skill'
  | 'limb'
  | 'schedule'
  | 'direct-tool'
  | 'webhook'
  | 'messaging'
  | 'events'
  | 'identity'
  | 'connector'
  | 'service'
  | 'ui'
  | 'content-editor-provider';

export interface PluginManagerCapability {
  id: string;
  kind: PluginManagerCapabilityKind;
  name: string;
  description?: string;
  /** Observation only. A visible label never grants runtime authority. */
  active: boolean;
}

/** Package-owned capability surface shown to people; distinct from Host permission grants. */
export interface PluginManagerContribution {
  id: string;
  kind: PluginManagerCapabilityKind;
  name: string;
  description?: string;
}

/** Runtime-discovered tool exposed by one active MCP contribution. */
export interface PluginManagerContributionTool {
  contributionId: string;
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface PluginManagerContributionToolsResponse {
  pluginId: string;
  tools: PluginManagerContributionTool[];
}

export interface PluginManagerDiagnostic {
  code: string;
  message: string;
  occurredAt: number;
  revision: number | null;
}

export interface PluginManagerActions {
  install: boolean;
  setEnabled: boolean;
  uninstall: boolean;
  blockingReasons: string[];
}

export type PluginManagerConfigFieldKind = 'string' | 'secret' | 'select' | 'boolean' | 'number' | 'url' | 'list';

export interface PluginManagerConfigOption {
  value: string;
  label: string;
  hint?: string;
  docsUrl?: string;
}

/** Console/Agent-safe projection of a typed configuration contribution. */
export interface PluginManagerConfigField {
  key: string;
  label: string;
  description?: string;
  kind: PluginManagerConfigFieldKind;
  required: boolean;
  default?: string | number | boolean | string[];
  options?: PluginManagerConfigOption[];
  /** Secret fields expose only the fixed mask or null, never the stored value. */
  currentValue: string | null;
  sensitive: boolean;
}

/** Compact list/search projection. All lifecycle axes remain independent. */
export interface PluginManagerListItem {
  pluginId: string;
  pluginInstanceId: string | null;
  displayName: string;
  description?: PluginDescription;
  icon?: PluginIconSpec;
  iconBg?: string;
  publisher?: string;
  source: PluginManagerPackageSource;
  availableVersion: string | null;
  installedVersion: string | null;
  packageDigest: string | null;
  artifact: PluginManagerArtifactState;
  config: PluginManagerConfigState;
  auth: PluginManagerAuthState;
  intent: PluginManagerIntentState;
  live: PluginManagerLiveState;
  lifecycleRevision: number | null;
  capabilitySummary: Array<Pick<PluginManagerCapability, 'id' | 'kind' | 'name' | 'active'>>;
  actions: PluginManagerActions;
  diagnostic?: PluginManagerDiagnostic;
}

export interface PluginManagerDetail extends PluginManagerListItem {
  capabilities: PluginManagerCapability[];
  /** Absent only when legacy/catalog metadata cannot yet expose a verified manifest. */
  contributions?: PluginManagerContribution[];
  docsUrl?: string;
  setupSteps?: string[];
  configFields: PluginManagerConfigField[];
}

export interface PluginManagerCatalogProjection {
  status: 'fresh' | 'stale' | 'degraded' | 'unavailable';
  refreshedAt: number | null;
  message?: string;
}

export interface PluginManagerListResponse {
  plugins: PluginManagerListItem[];
  catalog: PluginManagerCatalogProjection;
}

export interface PluginManagerDetailResponse {
  plugin: PluginManagerDetail;
  catalog: PluginManagerCatalogProjection;
}

/** Console-only human documentation; intentionally excluded from the Agent Manager projection. */
export interface PluginManagerDocumentationResponse {
  readmeMarkdown?: string;
}

export type PluginManagerInstallRequest =
  | {
      source: { kind: 'catalog'; catalogId: string };
      expectedVersion: string;
      expectedDigest: string;
    }
  | {
      source: { kind: 'local-directory' | 'local-archive'; path: string };
    };

export interface PluginManagerSetEnabledRequest {
  enabled: boolean;
  expectedRevision: number;
}

export interface PluginManagerUninstallRequest {
  expectedRevision: number;
}

/** Typed contribution write; intentionally not a seventh generic management operation. */
export interface PluginManagerConfigureRequest {
  expectedRevision: number;
  updates: Array<{ key: string; value: string | null }>;
}
