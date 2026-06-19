/**
 * External Connector Registry — F240
 *
 * Lightweight metadata store for external IM connector plugins.
 * Bootstrap registers plugin metadata here; connector-hub reads it
 * to include external connectors in the Hub status response.
 *
 * Separated from im-connector-loader to avoid circular dependencies
 * (connector-hub ↔ bootstrap).
 */

import type { ConnectorDefinition } from '@cat-cafe/shared';

export interface ExternalConnectorMeta {
  id: string;
  definition: ConnectorDefinition;
  requiredEnvKeys: readonly string[];
  optionalEnvKeys: readonly string[];
  /** Whether plugin.isConfigured() returned true. Updated after bootstrap check. */
  configured: boolean;
}

const registry = new Map<string, ExternalConnectorMeta>();

/** Register an external connector's metadata for Hub status display. */
export function registerExternalConnectorMeta(meta: ExternalConnectorMeta): void {
  registry.set(meta.id, meta);
}

/** Update configured status after plugin.isConfigured() is evaluated. */
export function updateExternalConnectorConfigured(id: string, configured: boolean): void {
  const entry = registry.get(id);
  if (entry) entry.configured = configured;
}

/** Get all registered external connector metadata. */
export function getAllExternalConnectorMeta(): readonly ExternalConnectorMeta[] {
  return Array.from(registry.values());
}

/** Remove a single connector from registry (called on plugin uninstall). */
export function unregisterExternalConnectorMeta(id: string): void {
  registry.delete(id);
}

/** Clear registry (for tests). */
export function clearExternalConnectorRegistry(): void {
  registry.clear();
}
