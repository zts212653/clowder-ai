import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';

export interface PluginSkillInfo {
  pluginId: string;
  skillName: string;
  skillsSource: string;
  enabled: boolean;
  mountPaths?: string[];
}

/** Declared plugin activation persists its admitted, materialized skill source. */
export function resolvePluginSkillSourcesForProject(
  config: CapabilitiesConfig | null,
  _canonicalPluginsDir: string,
  projectRoot: string,
): PluginSkillInfo[] {
  if (!config) return [];
  return config.capabilities.flatMap((cap) => {
    if (cap.type !== 'skill' || !cap.pluginId || !cap.skillsSource) return [];
    if (!/^[A-Za-z0-9._-]+$/.test(cap.id) || cap.id === '.' || cap.id === '..') return [];
    const skillsSource = isAbsolute(cap.skillsSource) ? cap.skillsSource : resolve(projectRoot, cap.skillsSource);
    if (!existsSync(join(skillsSource, cap.id))) return [];
    return [
      {
        pluginId: cap.pluginId,
        skillName: cap.id,
        skillsSource,
        enabled: cap.enabled !== false,
        ...(cap.mountPaths === undefined ? {} : { mountPaths: cap.mountPaths }),
      },
    ];
  });
}
