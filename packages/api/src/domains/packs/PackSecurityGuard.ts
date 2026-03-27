/**
 * F129 PackSecurityGuard — Malicious Content Detection
 * Validates pack directories against security threats:
 * - Prompt injection patterns (AC-A7)
 * - Schema fail-closed (AC-A8)
 * - capabilities/ rejection (AC-A9)
 * - Identity override prevention (KD-3)
 * - Constraint direction enforcement (KD-9)
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PackDefaultsSchema,
  PackGuardrailsSchema,
  PackManifestSchema,
  PackMaskSchema,
  PackWorkflowSchema,
  PackWorldDriverSchema,
} from '@cat-cafe/shared';
import { parse } from 'yaml';
import type { ZodError } from 'zod';

export interface SecurityResult {
  ok: boolean;
  reasons: string[];
}

/** Prompt injection blocklist — patterns that must never appear in pack content */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i,
  /you\s+are\s+now\b/i,
  /from\s+now\s+on\s+you\b/i,
  /forget\s+(everything|all|your)/i,
  /system\s+prompt/i,
  /reveal\s+your/i,
  /show\s+me\s+your\s+instructions/i,
  /override\s+(your|the)\s+(rules|identity|constraints|personality)/i,
  /do\s+not\s+follow/i,
  /disregard\b/i,
  /bypass\b/i,
];

/** Constraint relaxation patterns — guardrails must only add strictness */
const RELAXATION_PATTERNS: RegExp[] = [
  /\b(allow|permit|enable)\s+(any|all|unrestricted)/i,
  /\brelax\b/i,
  /\bremove\s+restriction/i,
  /\bdisable\s+(guardrail|constraint|safety|filter)/i,
  /\bno\s+(limits?|restrictions?|boundaries)\b/i,
];

/**
 * Identity fields that masks must never set (KD-3: Core Identity Layer immutable).
 * Note: 'name' is NOT here — it's a valid mask field (mask's own name).
 * 'id' is also valid (mask's own id).
 */
const IMMUTABLE_FIELDS = new Set(['catId', 'family', 'provider', 'displayName', 'breedId']);

export class PackSecurityGuard {
  /**
   * Validate a pack directory.
   * Returns { ok: true } or { ok: false, reasons: [...] }.
   */
  async validate(packDir: string): Promise<SecurityResult> {
    const reasons: string[] = [];

    // 1. Check pack.yaml exists and validates
    await this.validateManifest(packDir, reasons);

    // 2. Check capabilities/ presence (AC-A9)
    await this.checkCapabilities(packDir, reasons);

    // 3. Validate guardrails.yaml
    await this.validateYamlFile(packDir, 'guardrails.yaml', PackGuardrailsSchema, reasons);

    // 4. Validate defaults.yaml
    await this.validateYamlFile(packDir, 'defaults.yaml', PackDefaultsSchema, reasons);

    // 5. Validate masks/*.yaml
    await this.validateMasks(packDir, reasons);

    // 6. Validate workflows/*.yaml
    await this.validateWorkflows(packDir, reasons);

    // 7. Validate world-driver.yaml
    await this.validateYamlFile(packDir, 'world-driver.yaml', PackWorldDriverSchema, reasons);

    // 8. Scan all YAML content for prompt injection
    await this.scanForInjection(packDir, reasons);

    // 9. Scan guardrails for relaxation attempts
    await this.scanGuardrailsDirection(packDir, reasons);

    return { ok: reasons.length === 0, reasons };
  }

  private async validateManifest(packDir: string, reasons: string[]): Promise<void> {
    const manifestPath = join(packDir, 'pack.yaml');
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const parsed = parse(raw) as unknown;
      const result = PackManifestSchema.safeParse(parsed);
      if (!result.success) {
        reasons.push(`pack.yaml schema error: ${formatZodError(result.error)}`);
      }
    } catch {
      reasons.push('pack.yaml not found or unreadable');
    }
  }

  private async checkCapabilities(packDir: string, reasons: string[]): Promise<void> {
    const capDir = join(packDir, 'capabilities');
    try {
      const s = await stat(capDir);
      if (s.isDirectory()) {
        reasons.push('capabilities/ directory detected — not supported in Phase A (AC-A9)');
      }
    } catch {
      // Not present — good
    }
  }

  private async validateYamlFile(
    packDir: string,
    filename: string,
    // biome-ignore lint/suspicious/noExplicitAny: Zod schema type variance
    schema: { safeParse: (data: unknown) => { success: boolean; error?: ZodError<any> } },
    reasons: string[],
  ): Promise<void> {
    const filePath = join(packDir, filename);
    try {
      await stat(filePath);
    } catch {
      return; // Optional file not present — ok
    }
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = parse(raw) as unknown;
      const result = schema.safeParse(parsed);
      if (!result.success && result.error) {
        reasons.push(`${filename} schema error: ${formatZodError(result.error)}`);
      }
    } catch (e) {
      reasons.push(`${filename} parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async validateMasks(packDir: string, reasons: string[]): Promise<void> {
    const masksDir = join(packDir, 'masks');
    const files = await safeReaddir(masksDir);
    for (const f of files) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const filePath = join(masksDir, f);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = parse(raw) as unknown;
        const result = PackMaskSchema.safeParse(parsed);
        if (!result.success) {
          reasons.push(`masks/${f} schema error: ${formatZodError(result.error)}`);
        }
        // Check for immutable field override attempts
        if (parsed && typeof parsed === 'object') {
          for (const key of Object.keys(parsed as Record<string, unknown>)) {
            if (IMMUTABLE_FIELDS.has(key)) {
              reasons.push(`masks/${f} attempts to set immutable identity field: ${key}`);
            }
          }
        }
      } catch (e) {
        reasons.push(`masks/${f} parse error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async validateWorkflows(packDir: string, reasons: string[]): Promise<void> {
    const workflowsDir = join(packDir, 'workflows');
    const files = await safeReaddir(workflowsDir);
    for (const f of files) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const filePath = join(workflowsDir, f);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = parse(raw) as unknown;
        const result = PackWorkflowSchema.safeParse(parsed);
        if (!result.success) {
          reasons.push(`workflows/${f} schema error: ${formatZodError(result.error)}`);
        }
      } catch (e) {
        reasons.push(`workflows/${f} parse error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async scanForInjection(packDir: string, reasons: string[]): Promise<void> {
    const yamlFiles = await collectYamlFiles(packDir);
    for (const filePath of yamlFiles) {
      try {
        const content = await readFile(filePath, 'utf-8');
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(content)) {
            const relative = filePath.replace(packDir + '/', '');
            reasons.push(`Prompt injection detected in ${relative}: matches pattern ${pattern.source}`);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  private async scanGuardrailsDirection(packDir: string, reasons: string[]): Promise<void> {
    const guardrailsPath = join(packDir, 'guardrails.yaml');
    try {
      const content = await readFile(guardrailsPath, 'utf-8');
      for (const pattern of RELAXATION_PATTERNS) {
        if (pattern.test(content)) {
          reasons.push(`Guardrails contain relaxation pattern: ${pattern.source}`);
        }
      }
    } catch {
      // No guardrails — ok
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function collectYamlFiles(dir: string, collected: string[] = []): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return collected;
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        await collectYamlFiles(full, collected);
      } else if (name.endsWith('.yaml') || name.endsWith('.yml')) {
        collected.push(full);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
  return collected;
}
