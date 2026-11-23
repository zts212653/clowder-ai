import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInvokeCapabilityRoot } from '../config/capabilities/invoke-capability-root.js';
import { resolveStartupProjectRoot } from '../utils/startup-root.js';

export interface CapabilityTruth {
  /** Packaged skill sources stay with the checkout that supplies them. */
  root: string;
  skillsSource?: string;
  /** MCP configuration shares the persistent authority used by Settings and invocation. */
  mcpRoot: string;
}

export async function resolveCapabilityTruth(projectRoot: string): Promise<CapabilityTruth> {
  const projectSkillsSource = join(projectRoot, 'cat-cafe-skills');
  const hasProjectSkills = existsSync(join(projectSkillsSource, 'manifest.yaml'));
  const root = hasProjectSkills ? projectRoot : resolveStartupProjectRoot();
  return {
    root,
    mcpRoot: await resolveInvokeCapabilityRoot(root),
    ...(hasProjectSkills ? { skillsSource: projectSkillsSource } : {}),
  };
}
