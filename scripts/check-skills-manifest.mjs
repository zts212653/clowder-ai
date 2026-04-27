#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  collectSkillRequirements,
  loadCapabilitiesConfig,
  loadManifestSkills,
  resolveRequiredMcpStatus,
} from './lib/mcp-health.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const repoRoot = process.argv[2] ? resolve(process.argv[2]) : defaultRepoRoot;

const manifestPath = join(repoRoot, 'cat-cafe-skills', 'manifest.yaml');
const skillsRoot = join(repoRoot, 'cat-cafe-skills');
const catConfigPath = join(repoRoot, 'cat-config.json');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const skills = loadManifestSkills(repoRoot);
  if (!skills || typeof skills !== 'object' || Object.keys(skills).length === 0) {
    throw new Error('manifest.yaml missing top-level "skills" map');
  }
  return { skills };
}

function loadRosterHandles() {
  if (!existsSync(catConfigPath)) {
    throw new Error(`cat-config.json not found: ${catConfigPath}`);
  }
  const raw = readFileSync(catConfigPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed.roster || typeof parsed.roster !== 'object') {
    throw new Error('cat-config.json missing "roster" object');
  }

  const handles = Object.keys(parsed.roster)
    .map((id) => `@${id}`)
    .sort((a, b) => b.length - a.length);

  const nicknames = new Set();
  if (parsed.breeds && typeof parsed.breeds === 'object') {
    for (const breed of Object.values(parsed.breeds)) {
      if (breed.nickname && typeof breed.nickname === 'string') {
        nicknames.add(breed.nickname);
      }
    }
  }

  return { handles, nicknames: [...nicknames].sort((a, b) => b.length - a.length) };
}

function lintManifestStructure(skillsMap) {
  const errors = [];
  const skillNames = Object.keys(skillsMap);

  for (const skillName of skillNames) {
    const entry = skillsMap[skillName];
    if (!entry || typeof entry !== 'object') {
      errors.push(`[manifest] skills.${skillName} must be an object`);
      continue;
    }

    const triggers = asArray(entry.triggers);
    if (triggers.length === 0) {
      errors.push(`[manifest] skills.${skillName}.triggers must be a non-empty array`);
    }

    const notFor = asArray(entry.not_for);
    if (notFor.length === 0) {
      errors.push(`[manifest] skills.${skillName}.not_for must be a non-empty array`);
    }

    const output = asString(entry.output).trim();
    if (!output) {
      errors.push(`[manifest] skills.${skillName}.output must be a non-empty string`);
    }

    const requiresMcp = entry.requires_mcp;
    if (requiresMcp !== undefined) {
      if (!Array.isArray(requiresMcp)) {
        errors.push(`[manifest] skills.${skillName}.requires_mcp must be an array of MCP ids`);
      } else if (requiresMcp.some((value) => typeof value !== 'string' || !value.trim())) {
        errors.push(`[manifest] skills.${skillName}.requires_mcp contains non-string/empty MCP id`);
      }
    }

    if (!Array.isArray(entry.next)) {
      errors.push(`[manifest] skills.${skillName}.next must be an array (can be empty)`);
      continue;
    }

    for (const target of entry.next) {
      const targetName = asString(target).trim();
      if (!targetName) {
        errors.push(`[manifest] skills.${skillName}.next contains non-string target`);
        continue;
      }
      if (!Object.hasOwn(skillsMap, targetName)) {
        errors.push(`[manifest] skills.${skillName}.next -> "${targetName}" does not exist`);
      }
    }

    const skillDocPath = join(skillsRoot, skillName, 'SKILL.md');
    if (!existsSync(skillDocPath)) {
      errors.push(`[manifest] skills.${skillName} has no matching SKILL.md at ${relative(repoRoot, skillDocPath)}`);
    }
  }

  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillDocPath = join(skillsRoot, skillName, 'SKILL.md');
    if (!existsSync(skillDocPath)) continue;
    if (Object.hasOwn(skillsMap, skillName)) continue;
    errors.push(`[manifest] filesystem skill "${skillName}" has SKILL.md but is missing in manifest.yaml`);
  }

  return errors;
}

const NICKNAME_EXEMPT_PATTERNS = [/签名|signature/i, /来源：/, /教训/, /\[.*🐾\]/, /反面案例/];

const REFS_EXEMPT_FILES = new Set([
  'commit-signatures.md',
  'hyperfocus-brake-messages.md',
  'creator-context.md',
  'mcp-tool-description-standard.md',
]);

const NICKNAME_EXEMPT_SKILLS = new Set(['hyperfocus-brake', 'bootcamp-guide', 'incident-response']);

function isNicknameExemptLine(line) {
  return NICKNAME_EXEMPT_PATTERNS.some((re) => re.test(line));
}

function stripQuotedContent(line) {
  return line
    .replace(/`[^`]*`/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '');
}

function collectLintTargets(skillsMap) {
  const targets = [];

  for (const skillName of Object.keys(skillsMap)) {
    const skillDocPath = join(skillsRoot, skillName, 'SKILL.md');
    if (existsSync(skillDocPath)) {
      targets.push(skillDocPath);
    }
  }

  const refsDir = join(skillsRoot, 'refs');
  if (existsSync(refsDir)) {
    for (const entry of readdirSync(refsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (REFS_EXEMPT_FILES.has(entry.name)) continue;
      targets.push(join(refsDir, entry.name));
    }
  }

  return targets;
}

function lintHardcodedHandles(skillsMap, handles, nicknames) {
  const errors = [];
  const targets = collectLintTargets(skillsMap);

  for (const filePath of targets) {
    const text = readFileSync(filePath, 'utf-8');
    const lines = text.split(/\r?\n/);
    const relPath = relative(repoRoot, filePath);
    const skillName = relPath.split('/')[1] ?? '';
    const skipNicknames = NICKNAME_EXEMPT_SKILLS.has(skillName);

    let inCodeFence = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';

      if (/^```/.test(line.trimStart())) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) continue;

      if (line.includes('@猫名') || line.includes('@显示名')) continue;

      const stripped = stripQuotedContent(line);

      for (const handle of handles) {
        const re = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(handle)}(?![A-Za-z0-9_.-])`);
        if (!re.test(stripped)) continue;

        errors.push(
          `[hardcoded-handle] ${relPath}:${index + 1} contains ${handle} — use role/roster reference instead`,
        );
      }

      if (skipNicknames) continue;
      if (isNicknameExemptLine(line)) continue;

      for (const name of nicknames) {
        if (!stripped.includes(name)) continue;

        errors.push(
          `[hardcoded-name] ${relPath}:${index + 1} contains "${name}" — use role description instead (主执行猫/QA审查猫/视觉把关猫)`,
        );
      }
    }
  }

  return errors;
}

async function collectMcpWarnings(skillsMap) {
  const warnings = [];
  const capabilities = loadCapabilitiesConfig(repoRoot);
  const requirements = collectSkillRequirements(skillsMap);
  const cache = new Map();

  for (const [skillName, mcpIds] of requirements.entries()) {
    for (const mcpId of mcpIds) {
      if (!cache.has(mcpId)) {
        cache.set(mcpId, await resolveRequiredMcpStatus(repoRoot, mcpId, { capabilities, env: process.env }));
      }
      const dependency = cache.get(mcpId);
      if (dependency.status === 'ready') continue;
      warnings.push(
        `[requires_mcp] ${skillName} -> ${mcpId}: ${dependency.status}${dependency.reason ? ` (${dependency.reason})` : ''}`,
      );
    }
  }

  return warnings;
}

async function lintManifest() {
  const parsed = loadManifest();
  const skillsMap = parsed.skills;
  const { handles, nicknames } = loadRosterHandles();

  const errors = [...lintManifestStructure(skillsMap), ...lintHardcodedHandles(skillsMap, handles, nicknames)];
  const warnings = await collectMcpWarnings(skillsMap);

  return {
    skillCount: Object.keys(skillsMap).length,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
  };
}

try {
  const result = await lintManifest();
  if (result.errorCount > 0) {
    console.error(`FAIL check-skills-manifest: ${result.errorCount} issue(s) found`);
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(`PASS check-skills-manifest: ${result.skillCount} skills validated`);
  if (result.warningCount > 0) {
    console.log(`WARN check-skills-manifest: ${result.warningCount} advisory issue(s) found`);
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL check-skills-manifest: ${message}`);
  process.exit(1);
}
