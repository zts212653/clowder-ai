#!/usr/bin/env node
// Node 24 can load this source module before any package artifacts exist.
import { deploymentDefaults } from '../packages/shared/src/deployment-defaults.ts';

const [field, ...extra] = process.argv.slice(2);
const allowed = new Set([
  'apiPort',
  'webPort',
  'envRegistryFrontendPort',
  'apiBaseUrl',
  'apiLoopbackUrl',
  'frontendBaseUrl',
  'roadmapPath',
  '--json',
]);
if (!allowed.has(field) || extra.length) throw new Error('Usage: read-deployment-default <deployment-field|--json>');
console.log(field === '--json' ? JSON.stringify(deploymentDefaults) : deploymentDefaults[field]);
