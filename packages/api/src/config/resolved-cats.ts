import { catRegistry } from '@cat-cafe/shared';
import { loadRuntimeCatConfig, toAllCatConfigs } from './cat-config-loader.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

export function getProjectResolvedCats(projectRoot: string) {
  try {
    const templatePath = resolveProjectTemplatePath(projectRoot);
    return toAllCatConfigs(loadRuntimeCatConfig(templatePath));
  } catch {
    return {};
  }
}

export function getResolvedCats(projectRoot: string) {
  try {
    const resolved = getProjectResolvedCats(projectRoot);
    for (const [id, config] of Object.entries(catRegistry.getAllConfigs())) {
      if (!resolved[id]) resolved[id] = config;
    }
    return resolved;
  } catch {
    return catRegistry.getAllConfigs();
  }
}
