#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/install-auth-config.mjs env-apply --env-file FILE [--set KEY=VALUE]... [--delete KEY]...
  node scripts/install-auth-config.mjs claude-profile set --project-dir DIR --api-key KEY [--base-url URL] [--model MODEL]
  node scripts/install-auth-config.mjs claude-profile remove --project-dir DIR`);
  process.exit(1);
}

function parseArgs(argv) {
  const positionals = [];
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      usage();
    }
    if (!values.has(key)) {
      values.set(key, []);
    }
    values.get(key).push(next);
    index += 1;
  }

  return { positionals, values };
}

function getRequired(values, key) {
  const value = values.get(key)?.[0];
  if (!value) {
    usage();
  }
  return value;
}

function getOptional(values, key, fallback = '') {
  return values.get(key)?.[0] ?? fallback;
}

function envQuote(value) {
  const stringValue = String(value);
  if (!stringValue.includes("'")) {
    return `'${stringValue}'`;
  }
  return `"${stringValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function applyEnvChanges(envFile, setPairs, deleteKeys) {
  const existing = existsSync(envFile)
    ? readFileSync(envFile, 'utf8').split(/\r?\n/).filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
    : [];
  const setMap = new Map();
  for (const pair of setPairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      usage();
    }
    setMap.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const deleteSet = new Set(deleteKeys);
  const filtered = existing.filter((line) => {
    const separator = line.indexOf('=');
    if (separator === -1) {
      return true;
    }
    const key = line.slice(0, separator);
    return !deleteSet.has(key) && !setMap.has(key);
  });
  for (const [key, value] of setMap.entries()) {
    filtered.push(`${key}=${envQuote(value)}`);
  }
  writeFileSync(envFile, filtered.length > 0 ? `${filtered.join('\n')}\n` : '', 'utf8');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function createDefaultProfiles() {
  const now = new Date().toISOString();
  return {
    version: 2,
    activeProfileId: 'claude-oauth',
    profiles: [
      {
        id: 'claude-oauth',
        provider: 'claude-oauth',
        displayName: 'Claude (OAuth)',
        authType: 'oauth',
        protocol: 'anthropic',
        builtin: true,
        models: ['claude-opus-4-6', 'claude-sonnet-4'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'codex-oauth',
        provider: 'codex-oauth',
        displayName: 'Codex (OAuth)',
        authType: 'oauth',
        protocol: 'openai',
        builtin: true,
        models: ['gpt-5.4', 'gpt-5.3-codex'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'gemini-oauth',
        provider: 'gemini-oauth',
        displayName: 'Gemini (OAuth)',
        authType: 'oauth',
        protocol: 'google',
        builtin: true,
        models: ['gemini-3.1-pro', 'gemini-2.5-pro'],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function createDefaultSecrets() {
  return { version: 2, profiles: {} };
}

function normalizeProfilesFile(raw) {
  if (raw?.version === 2 && Array.isArray(raw.profiles)) {
    const next = raw;
    const required = createDefaultProfiles().profiles;
    for (const builtin of required) {
      if (!next.profiles.some((profile) => profile.id === builtin.id)) {
        next.profiles.unshift(builtin);
      }
    }
    if (!next.activeProfileId || !next.profiles.some((profile) => profile.id === next.activeProfileId)) {
      next.activeProfileId = 'claude-oauth';
    }
    return next;
  }

  if (raw?.version === 1 && raw.providers?.anthropic) {
    const next = createDefaultProfiles();
    for (const legacyProfile of raw.providers.anthropic.profiles ?? []) {
      if (legacyProfile.id === 'anthropic-subscription-default') continue;
      next.profiles.push({
        id: legacyProfile.id,
        provider: legacyProfile.id,
        displayName: legacyProfile.name,
        authType: legacyProfile.mode === 'api_key' ? 'api_key' : 'oauth',
        protocol: 'anthropic',
        builtin: false,
        ...(legacyProfile.baseUrl ? { baseUrl: legacyProfile.baseUrl } : {}),
        models: legacyProfile.modelOverride ? [legacyProfile.modelOverride] : [],
        ...(legacyProfile.modelOverride ? { modelOverride: legacyProfile.modelOverride } : {}),
        createdAt: legacyProfile.createdAt,
        updatedAt: legacyProfile.updatedAt,
      });
    }
    if (raw.providers.anthropic.activeProfileId && raw.providers.anthropic.activeProfileId !== 'anthropic-subscription-default') {
      next.activeProfileId = raw.providers.anthropic.activeProfileId;
    }
    return next;
  }

  return createDefaultProfiles();
}

function normalizeSecretsFile(raw) {
  if (raw?.version === 2 && raw.profiles) {
    return raw;
  }
  if (raw?.version === 1 && raw.providers?.anthropic) {
    return { version: 2, profiles: { ...raw.providers.anthropic } };
  }
  return createDefaultSecrets();
}

function writeClaudeProfile(projectDir, apiKey, baseUrl, model) {
  const profileDir = path.join(projectDir, '.cat-cafe');
  mkdirSync(profileDir, { recursive: true });
  const profileFile = path.join(profileDir, 'provider-profiles.json');
  const secretsFile = path.join(profileDir, 'provider-profiles.secrets.local.json');
  const profileId = 'installer-managed';
  const now = new Date().toISOString();
  const profiles = normalizeProfilesFile(readJson(profileFile, null));
  const secrets = normalizeSecretsFile(readJson(secretsFile, null));
  const nextProfiles = profiles.profiles.filter((profile) => profile.id !== profileId);
  nextProfiles.push({
    id: profileId,
    provider: profileId,
    displayName: 'Installer API Key',
    authType: 'api_key',
    protocol: 'anthropic',
    builtin: false,
    baseUrl: baseUrl || 'https://api.anthropic.com',
    models: model ? [model] : [],
    createdAt: now,
    updatedAt: now,
    ...(model ? { modelOverride: model } : {}),
  });
  profiles.profiles = nextProfiles;
  profiles.activeProfileId = profileId;
  secrets.profiles[profileId] = { apiKey };
  writeFileSync(profileFile, `${JSON.stringify(profiles, null, 2)}\n`);
  writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`);
  chmodSync(secretsFile, 0o600);
}

function removeClaudeProfile(projectDir) {
  const profileDir = path.join(projectDir, '.cat-cafe');
  const profileFile = path.join(profileDir, 'provider-profiles.json');
  const secretsFile = path.join(profileDir, 'provider-profiles.secrets.local.json');
  const profileId = 'installer-managed';
  const profiles = normalizeProfilesFile(readJson(profileFile, null));
  const secrets = normalizeSecretsFile(readJson(secretsFile, null));
  if (!profiles?.profiles) {
    return;
  }
  profiles.profiles = profiles.profiles.filter((profile) => profile.id !== profileId);
  if (profiles.activeProfileId === profileId) {
    profiles.activeProfileId = 'claude-oauth';
  }
  delete secrets.profiles[profileId];
  writeFileSync(profileFile, `${JSON.stringify(profiles, null, 2)}\n`);
  if (secrets) {
    writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`);
  }
}

const { positionals, values } = parseArgs(process.argv.slice(2));
if (positionals[0] === 'env-apply') {
  applyEnvChanges(getRequired(values, 'env-file'), values.get('set') ?? [], values.get('delete') ?? []);
  process.exit(0);
}

if (positionals[0] === 'claude-profile' && positionals[1] === 'set') {
  writeClaudeProfile(
    getRequired(values, 'project-dir'),
    getRequired(values, 'api-key'),
    getOptional(values, 'base-url', 'https://api.anthropic.com'),
    getOptional(values, 'model', ''),
  );
  process.exit(0);
}

if (positionals[0] === 'claude-profile' && positionals[1] === 'remove') {
  removeClaudeProfile(getRequired(values, 'project-dir'));
  process.exit(0);
}

usage();
