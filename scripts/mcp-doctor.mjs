#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';
import {
  collectSkillRequirements,
  inspectManifestSkills,
  loadCapabilitiesConfig,
  resolveRequiredMcpStatus,
} from './lib/mcp-health.mjs';

const repoRoot = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

function pad(value, width) {
  return `${value}`.padEnd(width, ' ');
}

const manifest = inspectManifestSkills(repoRoot);
if (manifest.error) {
  console.error(`MCP doctor: ${manifest.error}`);
  process.exit(1);
}

const skillsMap = manifest.skills;
const requirements = collectSkillRequirements(skillsMap);
const capabilities = loadCapabilitiesConfig(repoRoot);

if (requirements.size === 0) {
  console.log('MCP doctor: no requires_mcp declarations found in cat-cafe-skills/manifest.yaml');
  process.exit(0);
}

const requiredBy = new Map();
for (const [skillName, mcpIds] of requirements.entries()) {
  for (const mcpId of mcpIds) {
    const existing = requiredBy.get(mcpId) ?? [];
    existing.push(skillName);
    requiredBy.set(mcpId, existing);
  }
}

const uniqueIds = [...requiredBy.keys()].sort();
const results = [];
for (const mcpId of uniqueIds) {
  results.push(
    await resolveRequiredMcpStatus(repoRoot, mcpId, {
      capabilities,
      env: process.env,
    }),
  );
}

console.log('MCP doctor — required MCP dependencies');
console.log('');
for (const result of results) {
  const skills = requiredBy.get(result.id) ?? [];
  console.log(
    `${pad(result.id, 18)} ${pad(result.status, 10)} required by: ${skills.join(', ')}${
      result.reason ? ` — ${result.reason}` : ''
    }`,
  );
}

const readyCount = results.filter((result) => result.status === 'ready').length;
const missingCount = results.filter((result) => result.status === 'missing').length;
const unresolvedCount = results.filter((result) => result.status === 'unresolved').length;

console.log('');
console.log(`Summary: ready=${readyCount} missing=${missingCount} unresolved=${unresolvedCount}`);

process.exit(missingCount > 0 || unresolvedCount > 0 ? 1 : 0);
