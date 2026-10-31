#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';
import {
  collectSkillRequirements,
  inspectManifestSkills,
  loadCapabilitiesConfig,
  resolveRequiredMcpStatus,
} from './lib/mcp-health.mjs';
import { probeMcpCapabilityLive } from './lib/mcp-live-probe.mjs';

function parseArgs(argv) {
  const result = {
    repoRoot: process.cwd(),
    probe: false,
    timeoutMs: undefined,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--probe') {
      result.probe = true;
      continue;
    }
    if (arg === '--probe-timeout-ms') {
      const next = argv[index + 1];
      index += 1;
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) result.timeoutMs = parsed;
      continue;
    }
    if (arg?.startsWith('--probe-timeout-ms=')) {
      const parsed = Number(arg.slice('--probe-timeout-ms='.length));
      if (Number.isFinite(parsed) && parsed > 0) result.timeoutMs = parsed;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    positional.push(arg);
  }

  if (positional[0]) result.repoRoot = resolve(positional[0]);
  return result;
}

function printHelp() {
  console.log('Usage: pnpm mcp:doctor -- [repoRoot] [--probe] [--probe-timeout-ms <ms>]');
  console.log('');
  console.log('Default mode is static: validate requires_mcp declarations against capabilities.json.');
  console.log('--probe additionally spawns ready stdio MCP servers and runs initialize + tools/list.');
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
const repoRoot = options.repoRoot;

function pad(value, width) {
  return `${value}`.padEnd(width, ' ');
}

function supportsLiveStdioProbe(capability) {
  const transport = capability?.mcpServer?.transport ?? 'stdio';
  return transport === 'stdio';
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

const capabilityById = new Map(
  (capabilities?.capabilities ?? [])
    .filter((entry) => entry?.id && entry.type === 'mcp')
    .map((entry) => [entry.id, entry]),
);
const probeResults = new Map();
if (options.probe) {
  for (const result of results) {
    if (result.status !== 'ready') continue;
    const capability = capabilityById.get(result.id);
    if (!capability) continue;
    if (!supportsLiveStdioProbe(capability)) continue;
    probeResults.set(
      result.id,
      await probeMcpCapabilityLive(capability, {
        projectRoot: repoRoot,
        timeoutMs: options.timeoutMs,
        env: process.env,
      }),
    );
  }
}

console.log('MCP doctor — required MCP dependencies');
if (options.probe) {
  console.log('Live probe enabled: ready stdio MCP servers are spawned and checked with initialize + tools/list');
}
console.log('');
for (const result of results) {
  const skills = requiredBy.get(result.id) ?? [];
  const probe = probeResults.get(result.id);
  const probeText = probe
    ? ` probe=${probe.connectionStatus}${
        probe.connectionStatus === 'connected' ? ` tools=${probe.tools?.join(',') || 0}` : ''
      }${probe.reason ? ` — ${probe.reason}` : ''}`
    : '';
  console.log(
    `${pad(result.id, 18)} ${pad(result.status, 10)} required by: ${skills.join(', ')}${
      result.reason ? ` — ${result.reason}` : ''
    }${probeText}`,
  );
}

const readyCount = results.filter((result) => result.status === 'ready').length;
const missingCount = results.filter((result) => result.status === 'missing').length;
const unresolvedCount = results.filter((result) => result.status === 'unresolved').length;
const disconnectedCount = [...probeResults.values()].filter(
  (result) => result.connectionStatus === 'disconnected',
).length;
const unknownProbeCount = [...probeResults.values()].filter((result) => result.connectionStatus === 'unknown').length;

console.log('');
console.log(
  `Summary: ready=${readyCount} missing=${missingCount} unresolved=${unresolvedCount}${
    options.probe ? ` probe_disconnected=${disconnectedCount} probe_unknown=${unknownProbeCount}` : ''
  }`,
);

process.exit(missingCount > 0 || unresolvedCount > 0 || disconnectedCount > 0 || unknownProbeCount > 0 ? 1 : 0);
