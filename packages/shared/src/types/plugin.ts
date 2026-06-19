/**
 * Plugin Framework Types — F202 声明式插件注册与资源编排
 *
 * F240 KD-15: PluginConfigField replaced by shared ValueConfigField.
 * Alias kept for import compatibility during transition; will be removed.
 */

import type { ValueConfigField } from './config-field.js';

/**
 * @deprecated Use ValueConfigField from config-field.ts directly.
 * Alias kept temporarily for import compat — plugins only use value fields.
 */
export type PluginConfigField = ValueConfigField;

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
  description?: string;
  icon?: string;
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
  description?: string;
  icon?: string;
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
