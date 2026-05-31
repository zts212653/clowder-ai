import { readFileSync } from 'node:fs';
import type { LimbCapability } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';

interface LimbYamlDeclaration {
  nodeId: string;
  displayName: string;
  platform: string;
  capabilities: LimbCapability[];
}

export function loadLimbDeclaration(yamlPath: string): LimbYamlDeclaration {
  const raw = readFileSync(yamlPath, 'utf-8');
  const doc = parseYaml(raw) as Record<string, unknown>;

  const nodeId = doc['nodeId'] as string;
  const displayName = doc['displayName'] as string;
  const platform = doc['platform'] as string;
  const capabilities = doc['capabilities'] as LimbCapability[];

  if (!nodeId || !displayName || !platform || !Array.isArray(capabilities)) {
    throw new Error(`Invalid limb declaration in ${yamlPath}: missing required fields`);
  }

  return { nodeId, displayName, platform, capabilities };
}
