/**
 * F208 KD-10: Parse structured profile YAML blocks from cat-dossier.md.
 *
 * Extracts per-cat machine-readable data for:
 * - compile-l0 `buildRosterRow` (l0RoutingNote carries only route-critical context)
 * - SystemPromptBuilder `buildTeammateRoster` (same)
 * - Frontend 画像页 (Phase C)
 * - Open-source baseline (Phase E)
 *
 * Format: fenced ```yaml blocks with first line `# structured-profile: cat:<catId>`.
 * See docs/team/cat-dossier.md "Schema: 结构化投影层" for full spec.
 *
 * No external YAML dependency — uses purpose-built parser for the known format.
 */

export interface DossierEngagementPolicy {
  quota: 'weekly_subscription_scarce';
  defaultMode: 'one_shot_calibration' | 'final_seal';
  highValueUses: string[];
  routineRepairReturn: 'author_then_routine_reviewer_if_needed';
  reentry: 'only_for_new_architecture_or_decision_judgment_or_explicit_cvo_request';
}

export interface DossierProfile {
  entityId: string;
  identity?: {
    pronouns?: string;
    l0PronounReminder?: boolean;
  };
  oneLiner?: string;
  l0RosterSummary?: string;
  l0RoutingNote?: string;
  l0SelfDescription?: string;
  engagementPolicy?: DossierEngagementPolicy;
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

  const identity = parseIdentity(content);
  if (identity) profile.identity = identity;

  const oneLiner = extractStringField(content, 'oneLiner');
  if (oneLiner) profile.oneLiner = oneLiner;

  const l0RosterSummary = extractStringField(content, 'l0RosterSummary');
  if (l0RosterSummary) profile.l0RosterSummary = l0RosterSummary;

  const l0RoutingNote = extractStringField(content, 'l0RoutingNote');
  if (l0RoutingNote) profile.l0RoutingNote = l0RoutingNote;

  const l0SelfDescription = extractStringField(content, 'l0SelfDescription');
  if (l0SelfDescription) profile.l0SelfDescription = l0SelfDescription;

  const engagementPolicy = parseEngagementPolicy(content);
  if (engagementPolicy) profile.engagementPolicy = engagementPolicy;

  const routingSignals = parseRoutingSignals(content);
  if (routingSignals) profile.routingSignals = routingSignals;

  const provenance = parseProvenance(content);
  if (provenance) profile.provenance = provenance;

  return profile;
}

function parseIdentity(content: string): DossierProfile['identity'] {
  const pronouns = extractStringField(content, 'pronouns');
  const l0PronounReminder = extractBooleanField(content, 'l0PronounReminder');
  if (!pronouns && l0PronounReminder === undefined) return undefined;

  return {
    ...(pronouns ? { pronouns } : {}),
    ...(l0PronounReminder !== undefined ? { l0PronounReminder } : {}),
  };
}

function parseEngagementPolicy(content: string): DossierEngagementPolicy | undefined {
  const block = extractObjectBlock(content, 'engagementPolicy');
  if (!block) return undefined;

  const quota = extractDirectStringField(block, 'quota');
  const defaultMode = extractDirectStringField(block, 'defaultMode');
  const highValueUses = extractDirectListField(block, 'highValueUses');
  const routineRepairReturn = extractDirectStringField(block, 'routineRepairReturn');
  const reentry = extractDirectStringField(block, 'reentry');

  if (quota !== 'weekly_subscription_scarce') return undefined;
  if (defaultMode !== 'one_shot_calibration' && defaultMode !== 'final_seal') return undefined;
  if (!highValueUses) return undefined;
  if (routineRepairReturn !== 'author_then_routine_reviewer_if_needed') return undefined;
  if (reentry !== 'only_for_new_architecture_or_decision_judgment_or_explicit_cvo_request') return undefined;

  return { quota, defaultMode, highValueUses, routineRepairReturn, reentry };
}

function parseRoutingSignals(content: string): DossierProfile['routingSignals'] {
  const peakCapabilities = extractListField(content, 'peakCapabilities');
  const antiSignals = extractListField(content, 'antiSignals');
  if (!peakCapabilities && !antiSignals) return undefined;

  return {
    ...(peakCapabilities ? { peakCapabilities } : {}),
    ...(antiSignals ? { antiSignals } : {}),
  };
}

function parseProvenance(content: string): DossierProfile['provenance'] {
  const version = extractStringField(content, 'version');
  const date = extractStringField(content, 'date');
  if (!version && !date) return undefined;

  const primarySources = extractListField(content, 'primarySources');
  return {
    version: version ?? '0.0',
    date: date ?? 'unknown',
    ...(primarySources ? { primarySources } : {}),
  };
}

/**
 * Extract a quoted string field: `fieldName: "value"`.
 * Allows leading whitespace for nested fields and a trailing YAML comment;
 * identity facts in the canonical dossier carry inline operator provenance.
 */
function extractStringField(content: string, field: string): string | undefined {
  const pattern = new RegExp(`^\\s*${field}:\\s*"([^"]*)"\\s*(?:#.*)?$`, 'm');
  const match = content.match(pattern);
  return match?.[1];
}

/** Extract an unquoted boolean field with an optional trailing YAML comment. */
function extractBooleanField(content: string, field: string): boolean | undefined {
  const pattern = new RegExp(`^\\s*${field}:\\s*(true|false)\\s*(?:#.*)?$`, 'm');
  const match = content.match(pattern);
  if (!match) return undefined;
  return match[1] === 'true';
}

/** Extract an indented object body without leaking identically named fields from sibling sections. */
function extractObjectBlock(content: string, field: string): string | undefined {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const fieldMatch = lines[i].match(new RegExp(`^(\\s*)${field}:\\s*(?:#.*)?$`));
    if (!fieldMatch) continue;

    const fieldIndent = fieldMatch[1].length;
    const blockLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trimStart();
      const indent = lines[j].length - trimmed.length;
      if (trimmed && indent <= fieldIndent) break;
      blockLines.push(lines[j]);
    }
    return blockLines.join('\n');
  }

  return undefined;
}

function directChildIndent(content: string): number | undefined {
  const indents = content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.length - line.trimStart().length);
  return indents.length > 0 ? Math.min(...indents) : undefined;
}

function extractDirectStringField(content: string, field: string): string | undefined {
  const childIndent = directChildIndent(content);
  if (childIndent === undefined) return undefined;

  const pattern = new RegExp(`^\\s{${childIndent}}${field}:\\s*"([^"]*)"\\s*(?:#.*)?$`);
  for (const line of content.split('\n')) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

function extractDirectListField(content: string, field: string): string[] | undefined {
  const childIndent = directChildIndent(content);
  if (childIndent === undefined) return undefined;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;
    if (indent !== childIndent || !trimmed.startsWith(`${field}:`)) continue;
    return parseListFieldAt(lines, i, childIndent, field);
  }

  return undefined;
}

function parseListFieldAt(
  lines: string[],
  fieldIndex: number,
  fieldIndent: number,
  field: string,
): string[] | undefined {
  const trimmed = lines[fieldIndex].trimStart();
  const inlineMatch = trimmed.match(new RegExp(`^${field}:\\s*\\[(.+)\\]`));
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map((item) => item.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
  }

  const items: string[] = [];
  for (let i = fieldIndex + 1; i < lines.length; i++) {
    const itemTrimmed = lines[i].trimStart();
    const itemIndent = lines[i].length - itemTrimmed.length;
    if (itemTrimmed && itemIndent <= fieldIndent) break;

    const itemMatch = lines[i].match(/^\s+-\s+"(.+)"$/);
    if (itemMatch) items.push(itemMatch[1]);
  }
  return items.length > 0 ? items : undefined;
}

/** Extract a list field: supports both inline `["a", "b"]` and multi-line `- "value"` */
function extractListField(content: string, field: string): string[] | undefined {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed.startsWith(`${field}:`)) continue;
    const fieldIndent = lines[i].length - trimmed.length;
    return parseListFieldAt(lines, i, fieldIndent, field);
  }

  return undefined;
}
