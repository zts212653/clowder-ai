import { LEGACY_GATE_RESOURCE_ENV_KEYS } from './gate-execution-command.mjs';

export const INHERITED_PRODUCTION_ENV_KEYS = Object.freeze([
  'NODE_ENV',
  'npm_config_production',
  'NPM_CONFIG_PRODUCTION',
]);

export function normalizedGateEnvironment(inheritedEnvironment = process.env, commandEnvironment = {}) {
  const normalized = { ...inheritedEnvironment };
  for (const key of [...INHERITED_PRODUCTION_ENV_KEYS, ...LEGACY_GATE_RESOURCE_ENV_KEYS]) delete normalized[key];
  return { ...normalized, ...commandEnvironment };
}
