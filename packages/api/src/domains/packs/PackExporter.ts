/**
 * F129 PackExporter — Export cat-config + shared-rules + skills as a Pack directory.
 * Phase B-α: Dogfood export for "Coding World" pack (AC-B1).
 *
 * Mapping:
 *   cat-config breeds/variants → masks/
 *   shared-rules iron laws → guardrails (block)
 *   shared-rules first principles → guardrails (warn)
 *   shared-rules world view + operational rules → defaults (overridable)
 *   skills manifest (SOP-linked) → workflows/
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PackBehavior,
  PackConstraint,
  PackDefaults,
  PackGuardrails,
  PackManifest,
  PackMask,
  PackWorkflow,
  PackWorldDriver,
} from '@cat-cafe/shared';
import { parse as parseYaml, stringify } from 'yaml';

export interface ExportConfig {
  catConfig: CatConfigLike;
  sharedRulesContent: string;
  skillsManifestContent: string;
  outputDir: string;
  packName: string;
  description?: string;
}

export interface ExportResult {
  outputDir: string;
  manifest: PackManifest;
  warnings: string[];
}

/** Minimal cat-config shape needed for export */
interface CatConfigLike {
  roster: Record<string, { family: string; roles: string[]; available: boolean }>;
  breeds: Array<{
    id: string;
    catId: string;
    displayName: string;
    defaultVariantId: string;
    variants: Array<{
      id: string;
      roleDescription?: string;
      personality?: string;
      strengths?: string[];
    }>;
  }>;
}

export class PackExporter {
  /**
   * Export masks from cat-config: one mask per available breed.
   */
  exportMasks(catConfig: CatConfigLike): PackMask[] {
    const masks: PackMask[] = [];
    for (const breed of catConfig.breeds) {
      const rosterEntry = catConfig.roster[breed.catId];
      if (!rosterEntry?.available) continue;

      const variant = breed.variants.find((v) => v.id === breed.defaultVariantId) ?? breed.variants[0];
      if (!variant) continue;

      const primaryRole = rosterEntry.roles[0] ?? 'agent';
      masks.push({
        id: `${breed.id}-${primaryRole}`,
        name: `${breed.displayName} ${primaryRole}`,
        roleOverlay: variant.roleDescription ?? `${primaryRole} role`,
        personalityOverlay: variant.personality,
        expertise: variant.strengths ?? [],
        activation: 'always' as const,
      });
    }
    return masks;
  }

  /**
   * Export guardrails from shared-rules: iron laws (block) + first principles (warn).
   */
  exportGuardrails(sharedRulesContent: string): PackGuardrails {
    const constraints: PackConstraint[] = [];
    let counter = 0;

    // Extract iron laws → block severity
    const ironLawSection = extractSection(sharedRulesContent, '铁律');
    for (const rule of extractRules(ironLawSection)) {
      constraints.push({
        id: `iron-${++counter}`,
        scope: 'all-cats' as const,
        rule: truncate(rule, 500),
        severity: 'block' as const,
      });
    }

    // Extract first principles → warn severity
    const principlesSection = extractSectionMulti(sharedRulesContent, ['第一性原理', '首要原则', 'First Principles']);
    for (const rule of extractRules(principlesSection)) {
      constraints.push({
        id: `principle-${++counter}`,
        scope: 'all-cats' as const,
        rule: truncate(rule, 500),
        severity: 'warn' as const,
      });
    }

    return { constraints };
  }

  /**
   * Export defaults from shared-rules: world view + operational rules (overridable).
   */
  exportDefaults(sharedRulesContent: string): PackDefaults {
    const behaviors: PackBehavior[] = [];
    let counter = 0;

    // World view → defaults
    const worldViewSection = extractSection(sharedRulesContent, '世界观');
    for (const rule of extractRules(worldViewSection)) {
      behaviors.push({
        id: `worldview-${++counter}`,
        scope: 'all-cats' as const,
        behavior: truncate(rule, 500),
        overridable: true as const,
      });
    }

    // Operational rules → defaults
    const opsSection = extractSection(sharedRulesContent, '操作规则');
    for (const rule of extractRules(opsSection)) {
      behaviors.push({
        id: `ops-${++counter}`,
        scope: 'all-cats' as const,
        behavior: truncate(rule, 500),
        overridable: true as const,
      });
    }

    return { behaviors };
  }

  /**
   * Export SOP-linked skills as workflows.
   */
  exportWorkflows(skillsManifestContent: string): PackWorkflow[] {
    const workflows: PackWorkflow[] = [];
    const parsed = parseYamlSafe(skillsManifestContent);
    if (!parsed?.skills) return workflows;

    for (const [id, skill] of Object.entries(parsed.skills as Record<string, SkillEntry>)) {
      if (skill.sop_step == null) continue; // Skip non-SOP skills
      const trigger = Array.isArray(skill.triggers) ? skill.triggers[0] : id;
      workflows.push({
        id,
        name: skill.description ?? id,
        trigger: truncate(String(trigger), 200),
        steps: [{ action: 'log-event' as const, params: { skill: id } }],
      });
    }
    return workflows;
  }

  /**
   * Full export: assemble all sections into a Pack directory.
   */
  async exportPack(config: ExportConfig): Promise<ExportResult> {
    const warnings: string[] = [];
    const { catConfig, sharedRulesContent, skillsManifestContent, outputDir, packName } = config;

    // Generate all sections
    const masks = this.exportMasks(catConfig);
    const guardrails = this.exportGuardrails(sharedRulesContent);
    const defaults = this.exportDefaults(sharedRulesContent);
    const workflows = this.exportWorkflows(skillsManifestContent);

    const manifest: PackManifest = {
      name: packName,
      version: '1.0.0',
      description: config.description ?? `Exported from cat-config: ${packName}`,
      packType: 'domain',
    };

    const worldDriver: PackWorldDriver = {
      resolver: 'hybrid',
      roles: masks.map((m) => m.id),
      actions: ['implement-feature', 'review-code', 'design-ui', 'write-tests'],
      canonRules: guardrails.constraints
        .filter((c) => c.severity === 'block')
        .map((c) => c.rule)
        .slice(0, 10),
    };

    // Write files
    await writeFile(join(outputDir, 'pack.yaml'), stringify(manifest));
    await writeFile(join(outputDir, 'guardrails.yaml'), stringify(guardrails));
    await writeFile(join(outputDir, 'defaults.yaml'), stringify(defaults));
    await writeFile(join(outputDir, 'world-driver.yaml'), stringify(worldDriver));

    // Write masks
    if (masks.length > 0) {
      await mkdir(join(outputDir, 'masks'), { recursive: true });
      for (const mask of masks) {
        await writeFile(join(outputDir, 'masks', `${mask.id}.yaml`), stringify(mask));
      }
    }

    // Write workflows
    if (workflows.length > 0) {
      await mkdir(join(outputDir, 'workflows'), { recursive: true });
      for (const wf of workflows) {
        await writeFile(join(outputDir, 'workflows', `${wf.id}.yaml`), stringify(wf));
      }
    }

    if (masks.length === 0) warnings.push('No masks exported (no available breeds)');
    if (guardrails.constraints.length === 0) warnings.push('No guardrails extracted');
    if (defaults.behaviors.length === 0) warnings.push('No defaults extracted');

    return { outputDir, manifest, warnings };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface SkillEntry {
  description?: string;
  triggers?: string[];
  sop_step?: number | number[] | null;
}

/** Try multiple heading keywords, return the first non-empty match. */
function extractSectionMulti(content: string, headings: string[]): string {
  for (const h of headings) {
    const result = extractSection(content, h);
    if (result.trim().length > 0) return result;
  }
  return '';
}

function extractSection(content: string, heading: string): string {
  const lines = content.split('\n');
  let capturing = false;
  let depth = 0;
  const result: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+/);
    if (!capturing && headingMatch && line.includes(heading)) {
      capturing = true;
      depth = headingMatch[1].length;
      continue;
    }
    if (capturing) {
      if (headingMatch && headingMatch[1].length <= depth) break;
      result.push(line);
    }
  }
  return result.join('\n');
}

function extractRules(section: string): string[] {
  const rules: string[] = [];
  const lines = section.split('\n');

  for (const line of lines) {
    // Match ### headings as rule titles
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      rules.push(h3[1].replace(/^[§#\d.\s]+/, '').trim());
    }
  }
  return rules.filter((r) => r.length > 0);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function parseYamlSafe(content: string): Record<string, unknown> | null {
  try {
    return parseYaml(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}
