/**
 * F129 PackCompiler — Schema → Canonical Prompt Blocks
 * Compiles validated pack content into prompt blocks for SystemPromptBuilder.
 *
 * AC-A3: compile to canonical prompt blocks (not raw YAML injection)
 * AC-A6: dual-track trust boundary (guardrails = hard; defaults = overridable)
 *
 * Compilation mapping (ADR-021 §5):
 * - masks/      → masksBlock (role overlay)
 * - guardrails  → guardrailBlock (硬约束轨)
 * - defaults    → defaultsBlock (默认行为轨)
 * - workflows/  → workflowsBlock (声明式流程提示)
 * - knowledge/  → skip (RAG, not prompt)
 * - expression/ → skip (assets)
 * - bridges/    → skip (Phase B)
 * - world-driver→ worldDriverSummary (read-only)
 * - capabilities→ already rejected by PackSecurityGuard
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompiledPackBlocks, PackOnDisk } from '@cat-cafe/shared';
import {
  PackDefaultsSchema,
  PackGuardrailsSchema,
  PackMaskSchema,
  PackWorkflowSchema,
  PackWorldDriverSchema,
} from '@cat-cafe/shared';
import { parse } from 'yaml';

export class PackCompiler {
  /**
   * Compile a validated, installed pack into prompt blocks.
   * Pure function: reads files → produces CompiledPackBlocks.
   */
  async compile(pack: PackOnDisk): Promise<CompiledPackBlocks> {
    const { manifest, rootDir } = pack;
    const warnings: string[] = [];

    const guardrailBlock = await this.compileGuardrails(rootDir, manifest.name, warnings);
    const defaultsBlock = await this.compileDefaults(rootDir, manifest.name, warnings);
    const masksBlock = await this.compileMasks(rootDir, manifest.name, warnings);
    const workflowsBlock = await this.compileWorkflows(rootDir, manifest.name, warnings);
    const worldDriverSummary = await this.compileWorldDriver(rootDir, manifest.name, warnings);

    // Check for skipped directories
    if (await dirExists(join(rootDir, 'capabilities'))) {
      warnings.push('capabilities/ skipped (Phase A)');
    }

    return {
      packName: manifest.name,
      guardrailBlock,
      defaultsBlock,
      masksBlock,
      workflowsBlock,
      worldDriverSummary,
      warnings,
    };
  }

  private async compileGuardrails(rootDir: string, packName: string, warnings: string[]): Promise<string | null> {
    const raw = await safeReadYaml(join(rootDir, 'guardrails.yaml'));
    if (!raw) return null;
    const result = PackGuardrailsSchema.safeParse(raw);
    if (!result.success) {
      warnings.push('guardrails.yaml failed schema validation during compile');
      return null;
    }
    const lines: string[] = [`## [Pack: ${packName}] 硬约束（不可覆盖）`];
    for (const c of result.data.constraints) {
      const scopeNote = c.scope === 'specific-breeds' && c.breeds ? ` [${c.breeds.join(',')}]` : '';
      const severityTag = c.severity === 'block' ? '🚫' : '⚠️';
      lines.push(`- ${severityTag}${scopeNote} ${c.rule}`);
    }
    return lines.join('\n');
  }

  private async compileDefaults(rootDir: string, packName: string, warnings: string[]): Promise<string | null> {
    const raw = await safeReadYaml(join(rootDir, 'defaults.yaml'));
    if (!raw) return null;
    const result = PackDefaultsSchema.safeParse(raw);
    if (!result.success) {
      warnings.push('defaults.yaml failed schema validation during compile');
      return null;
    }
    const lines: string[] = [`## [Pack: ${packName}] 默认行为（用户可覆盖）`];
    for (const b of result.data.behaviors) {
      const scopeNote = b.scope === 'specific-breeds' && b.breeds ? ` [${b.breeds.join(',')}]` : '';
      lines.push(`- ${scopeNote} ${b.behavior}`);
    }
    return lines.join('\n');
  }

  private async compileMasks(rootDir: string, packName: string, warnings: string[]): Promise<string | null> {
    const masksDir = join(rootDir, 'masks');
    const files = await safeReaddir(masksDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (yamlFiles.length === 0) return null;

    const lines: string[] = [`## [Pack: ${packName}] 角色叠加`];
    for (const f of yamlFiles) {
      const raw = await safeReadYaml(join(masksDir, f));
      if (!raw) continue;
      const result = PackMaskSchema.safeParse(raw);
      if (!result.success) {
        warnings.push(`masks/${f} failed schema validation during compile`);
        continue;
      }
      const m = result.data;
      lines.push(`- **${m.name}**（${m.activation}）: ${m.roleOverlay}`);
      if (m.personalityOverlay) {
        lines.push(`  性格叠加: ${m.personalityOverlay}`);
      }
      if (m.expertise && m.expertise.length > 0) {
        lines.push(`  专长: ${m.expertise.join(', ')}`);
      }
    }
    return lines.length > 1 ? lines.join('\n') : null;
  }

  private async compileWorkflows(rootDir: string, packName: string, warnings: string[]): Promise<string | null> {
    const workflowsDir = join(rootDir, 'workflows');
    const files = await safeReaddir(workflowsDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (yamlFiles.length === 0) return null;

    const lines: string[] = [`## [Pack: ${packName}] 工作流`];
    for (const f of yamlFiles) {
      const raw = await safeReadYaml(join(workflowsDir, f));
      if (!raw) continue;
      const result = PackWorkflowSchema.safeParse(raw);
      if (!result.success) {
        warnings.push(`workflows/${f} failed schema validation during compile`);
        continue;
      }
      const w = result.data;
      lines.push(`- **${w.name}**（触发: ${w.trigger}）`);
      for (const step of w.steps) {
        const params = step.params ? ` (${JSON.stringify(step.params)})` : '';
        lines.push(`  → ${step.action}${params}`);
      }
    }
    return lines.length > 1 ? lines.join('\n') : null;
  }

  private async compileWorldDriver(rootDir: string, packName: string, warnings: string[]): Promise<string | null> {
    const raw = await safeReadYaml(join(rootDir, 'world-driver.yaml'));
    if (!raw) return null;
    const result = PackWorldDriverSchema.safeParse(raw);
    if (!result.success) {
      warnings.push('world-driver.yaml failed schema validation during compile');
      return null;
    }
    const wd = result.data;
    const lines: string[] = [`## [Pack: ${packName}] 世界引擎（只读摘要）`];
    lines.push(`- resolver: ${wd.resolver}`);
    if (wd.roles) lines.push(`- 角色: ${wd.roles.join(', ')}`);
    if (wd.actions) lines.push(`- 可用动作: ${wd.actions.join(', ')}`);
    if (wd.canonRules) {
      lines.push('- 正典规则:');
      for (const rule of wd.canonRules) {
        lines.push(`  - ${rule}`);
      }
    }
    return lines.join('\n');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function safeReadYaml(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}
