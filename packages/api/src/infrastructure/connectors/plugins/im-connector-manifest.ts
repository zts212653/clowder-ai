/**
 * IM Connector Manifest — YAML parser + validator
 *
 * Each IM connector (built-in or external) declares its configuration
 * fields, setup steps, and display metadata via a `connector.yaml` file.
 * This module parses and validates those manifests.
 *
 * F240 KD-15: uses shared ConfigField types + parseConfigFields() — same
 * parser as plugin-manifest.ts. Connector manifests may include operation
 * fields (e.g. QR login) alongside value fields.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigField } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';
import { parseConfigFields } from '../../config-field-parser.js';

export interface ConnectorStepDef {
  text: string;
  /** If set, this step only applies to a specific connection mode */
  mode?: string;
}

/** Icon specification — matches ConnectorIconSpec in shared/types/connector.ts */
export type ManifestIconSpec = { type: 'svg'; iconId: string; src?: string } | { type: 'png'; src: string };

export interface ConnectorManifest {
  id: string;
  name: string;
  nameEn: string;
  version: string;
  /** Structured icon spec for avatar rendering (svg component or png path) */
  icon: ManifestIconSpec;
  /** Brand theme color hex — drives OKLCH avatar derivation + ring color */
  themeColor: string;
  docsUrl: string;
  /** F240: ConfigField[] includes value + operation fields; filter with isValueField/getValueFields for env paths */
  config: ConfigField[];
  steps: ConnectorStepDef[];
  /** AC-A25: manifest-driven permission support. If present, renders HubPermissionsTab. */
  permissions?: { label: string };
  /** F240: YAML-declared health-check capability — controls test button visibility. */
  testable?: boolean;
  /** F240: 'external' for user-installed plugins (force-written at install time). Absent/undefined = builtin. */
  source?: 'builtin' | 'external';
}

// ── Parser ───────────────────────────────────────────────────────────

function parseStep(raw: Record<string, unknown>): ConnectorStepDef {
  const step: ConnectorStepDef = { text: String(raw.text ?? '') };
  if (typeof raw.mode === 'string') step.mode = raw.mode;
  return step;
}

export function parseConnectorManifest(yamlPath: string): ConnectorManifest {
  const content = readFileSync(yamlPath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  const id = String(raw.id ?? '');
  if (!id) throw new Error(`connector.yaml missing 'id' in ${yamlPath}`);

  const configRaw = Array.isArray(raw.config) ? raw.config : [];
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];

  // Parse icon: structured { type, src/iconId } or fallback string → svg
  let icon: ManifestIconSpec;
  if (raw.icon && typeof raw.icon === 'object' && !Array.isArray(raw.icon)) {
    const iconRaw = raw.icon as Record<string, unknown>;
    if (iconRaw.type === 'png' && typeof iconRaw.src === 'string') {
      icon = { type: 'png', src: iconRaw.src };
    } else if (iconRaw.type === 'svg' && typeof iconRaw.src === 'string') {
      // SVG file reference (external plugins bundle .svg files)
      icon = { type: 'svg', iconId: iconRaw.iconId ? String(iconRaw.iconId) : id, src: iconRaw.src };
    } else if (iconRaw.type === 'svg' && typeof iconRaw.iconId === 'string') {
      icon = { type: 'svg', iconId: iconRaw.iconId };
    } else {
      icon = { type: 'svg', iconId: id };
    }
  } else {
    // Legacy fallback: plain string → svg iconId
    icon = { type: 'svg', iconId: String(raw.icon ?? id) };
  }

  // Parse permissions section (AC-A25)
  let permissions: { label: string } | undefined;
  if (raw.permissions && typeof raw.permissions === 'object' && !Array.isArray(raw.permissions)) {
    const permRaw = raw.permissions as Record<string, unknown>;
    if (typeof permRaw.label === 'string') {
      permissions = { label: permRaw.label };
    }
  }

  const testable = raw.testable === true;
  const source = raw.source === 'external' ? ('external' as const) : undefined;

  return {
    id,
    name: String(raw.name ?? id),
    nameEn: String(raw.nameEn ?? raw.name ?? id),
    version: String(raw.version ?? '1.0.0'),
    icon,
    themeColor: String(raw.themeColor ?? '#6B7280'),
    docsUrl: String(raw.docsUrl ?? ''),
    config: parseConfigFields(configRaw, `${yamlPath}/config`),
    steps: stepsRaw.map((s: Record<string, unknown>) => parseStep(s)),
    ...(permissions ? { permissions } : {}),
    ...(testable ? { testable } : {}),
    ...(source ? { source } : {}),
  };
}

// ── Scanner ──────────────────────────────────────────────────────────

const CONNECTOR_YAML = 'connector.yaml';

/**
 * Scan a directory of IM connector subdirectories for connector.yaml manifests.
 * Returns manifests keyed by connector id.
 */
export function scanConnectorManifests(connectorsDir: string): Map<string, ConnectorManifest> {
  const manifests = new Map<string, ConnectorManifest>();
  if (!existsSync(connectorsDir)) return manifests;

  let entries: string[];
  try {
    entries = readdirSync(connectorsDir).sort();
  } catch {
    return manifests;
  }

  for (const entry of entries) {
    const dir = join(connectorsDir, entry);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const yamlPath = join(dir, CONNECTOR_YAML);
    if (!existsSync(yamlPath)) continue;

    try {
      const manifest = parseConnectorManifest(yamlPath);
      if (manifest.id !== entry) {
        console.warn(`[IMConnectorManifest] skip ${entry}: manifest id '${manifest.id}' does not match directory`);
        continue;
      }
      manifests.set(manifest.id, manifest);
    } catch (err) {
      console.warn(`[IMConnectorManifest] skip ${entry}: ${(err as Error).message}`);
    }
  }

  return manifests;
}
