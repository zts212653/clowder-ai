/**
 * F208 KD-10: Parse structured profile YAML blocks from cat-dossier.md.
 *
 * Extracts per-cat machine-readable data for:
 * - compile-l0 `buildRosterRow` (l0RosterSummary replaces teamStrengths)
 * - SystemPromptBuilder `buildTeammateRoster` (same)
 * - Frontend 画像页 (Phase C)
 * - Open-source baseline (Phase E)
 *
 * Format: fenced ```yaml blocks with first line `# structured-profile: cat:<catId>`.
 * See docs/team/cat-dossier.md "Schema: 结构化投影层" for full spec.
 *
 * No external YAML dependency — uses purpose-built parser for the known format.
 */

export interface DossierProfile {
  entityId: string;
  oneLiner?: string;
  l0RosterSummary?: string;
  routingSignals?: {
    peakCapabilities?: string[];
    antiSignals?: string[];
  };
  provenance?: {
    version: string;
    date: string;
    primarySources?: string[];
  };
}

/**
 * Parse structured profile YAML blocks from dossier markdown content.
 * Returns a Map keyed by catId (e.g. "opus", "codex", "opus-47").
 */
export function parseDossierProfiles(markdownContent: string): Map<string, DossierProfile> {
  const profiles = new Map<string, DossierProfile>();
  if (!markdownContent) return profiles;

  // Extract fenced yaml blocks: ```yaml ... ```
  const yamlBlockPattern = /```yaml\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = yamlBlockPattern.exec(markdownContent)) !== null) {
    const blockContent = match[1].trim();
    // Check for structured-profile marker
    const markerMatch = blockContent.match(/^# structured-profile:\s*cat:(.+)$/m);
    if (!markerMatch) continue;

    const catId = markerMatch[1].trim();
    const profile = parseYamlBlock(blockContent);
    if (profile) {
      profiles.set(catId, profile);
    }
  }

  return profiles;
}

/**
 * Parse a single structured-profile YAML block into a DossierProfile.
 * Handles the well-defined format: flat key-value pairs + nested lists.
 */
function parseYamlBlock(content: string): DossierProfile | null {
  const entityId = extractStringField(content, 'entityId');
  if (!entityId) return null;

  const profile: DossierProfile = { entityId };

  const oneLiner = extractStringField(content, 'oneLiner');
  if (oneLiner) profile.oneLiner = oneLiner;

  const l0RosterSummary = extractStringField(content, 'l0RosterSummary');
  if (l0RosterSummary) profile.l0RosterSummary = l0RosterSummary;

  // Parse routingSignals (nested object with list fields)
  const peakCapabilities = extractListField(content, 'peakCapabilities');
  const antiSignals = extractListField(content, 'antiSignals');
  if (peakCapabilities || antiSignals) {
    profile.routingSignals = {};
    if (peakCapabilities) profile.routingSignals.peakCapabilities = peakCapabilities;
    if (antiSignals) profile.routingSignals.antiSignals = antiSignals;
  }

  // Parse provenance (Phase C AC-C2: display provenance on frontend)
  const version = extractStringField(content, 'version');
  const date = extractStringField(content, 'date');
  if (version || date) {
    profile.provenance = {
      version: version ?? '0.0',
      date: date ?? 'unknown',
    };
    const primarySources = extractListField(content, 'primarySources');
    if (primarySources) profile.provenance.primarySources = primarySources;
  }

  return profile;
}

/** Extract a quoted string field: `fieldName: "value"` (allows optional leading whitespace for nested fields) */
function extractStringField(content: string, field: string): string | undefined {
  const pattern = new RegExp(`^\\s*${field}:\\s*"(.+)"\\s*$`, 'm');
  const match = content.match(pattern);
  return match?.[1];
}

/** Extract a list field: supports both inline `["a", "b"]` and multi-line `- "value"` */
function extractListField(content: string, field: string): string[] | undefined {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed.startsWith(`${field}:`)) continue;

    // Check for inline array: `field: ["a", "b", "c"]`
    const inlineMatch = trimmed.match(new RegExp(`^${field}:\\s*\\[(.+)\\]`));
    if (inlineMatch) {
      return inlineMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    }

    // Multi-line format: collect indented `- "value"` lines
    const fieldIndent = lines[i].length - trimmed.length;
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const itemTrimmed = lines[j].trimStart();
      const itemIndent = lines[j].length - itemTrimmed.length;
      const itemMatch = lines[j].match(/^\s+-\s+"(.+)"$/);
      if (itemMatch) {
        items.push(itemMatch[1]);
      } else if (itemTrimmed && itemIndent <= fieldIndent) {
        break; // Hit a sibling or parent field
      }
    }
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}
