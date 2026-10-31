/**
 * Manifest slashCommands discovery — F142 Phase B
 * Parses skill manifest.yaml and extracts validated slash command declarations.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type ManifestSlashCommand, ManifestSlashCommandSchema } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';

interface ManifestSkillEntry {
  description?: unknown;
  triggers?: unknown;
  slashCommands?: unknown[];
}

/**
 * Parse manifest.yaml and extract validated slashCommands per skill.
 * Returns Map<skillId, validatedCommands[]>.
 * Invalid commands are silently skipped (logged at validation time if needed).
 */
export async function parseManifestSlashCommands(skillsSrcDir: string): Promise<Map<string, ManifestSlashCommand[]>> {
  const result = new Map<string, ManifestSlashCommand[]>();
  const manifestPath = join(skillsSrcDir, 'manifest.yaml');
  try {
    const content = await readFile(manifestPath, 'utf-8');
    const parsed = parseYaml(content) as {
      skills?: Record<string, ManifestSkillEntry>;
    } | null;
    if (!parsed?.skills || typeof parsed.skills !== 'object') return result;

    for (const [skillId, meta] of Object.entries(parsed.skills)) {
      if (!Array.isArray(meta?.slashCommands) || meta.slashCommands.length === 0) {
        continue;
      }
      const validCommands: ManifestSlashCommand[] = [];
      for (const raw of meta.slashCommands) {
        const parsed = ManifestSlashCommandSchema.safeParse(raw);
        if (parsed.success) {
          validCommands.push(parsed.data);
        }
        // Invalid entries silently skipped (zod error available if logging needed)
      }
      if (validCommands.length > 0) {
        result.set(skillId, validCommands);
      }
    }
  } catch {
    // manifest missing or unreadable — return empty
  }
  return result;
}
