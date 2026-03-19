#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/install-auth-config.mjs env-apply --env-file FILE [--set KEY=VALUE]... [--delete KEY]...
  node scripts/install-auth-config.mjs claude-profile set --project-dir DIR [--api-key KEY] [--base-url URL] [--model MODEL]
    API key can also be passed via _INSTALLER_API_KEY env var (preferred for security).
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
    ? readFileSync(envFile, 'utf8')
        .split(/\r?\n/)
        .filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
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
  if (!existsSync(file)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${path.basename(file)}: ${reason}`);
  }
}

const INSTALLER_PROFILE_ID = 'installer-managed';

function createDefaultProfiles() {
  return {
    version: 1,
    providers: {
      anthropic: {
        activeProfileId: '',
        profiles: [],
      },
    },
  };
}

function createDefaultSecrets() {
  return {
    version: 1,
    providers: {
      anthropic: {},
    },
  };
}

function normalizeInstallerMetaProfile(rawProfile) {
  if (!rawProfile?.id) {
    return null;
  }
  const now = new Date().toISOString();
  return {
    id: rawProfile.id,
    provider: 'anthropic',
    name:
      rawProfile.name ??
      rawProfile.displayName ??
      (rawProfile.id === INSTALLER_PROFILE_ID ? 'Installer API Key' : rawProfile.id),
    mode: rawProfile.mode === 'api_key' || rawProfile.authType === 'api_key' ? 'api_key' : 'subscription',
    ...(rawProfile.baseUrl ? { baseUrl: rawProfile.baseUrl } : {}),
    ...(rawProfile.modelOverride ? { modelOverride: rawProfile.modelOverride } : {}),
    createdAt: rawProfile.createdAt ?? now,
    updatedAt: rawProfile.updatedAt ?? now,
  };
}

function normalizeProfilesFile(raw) {
  if (raw?.version === 1 && raw.providers?.anthropic && Array.isArray(raw.providers.anthropic.profiles)) {
    return raw;
  }

  const next = createDefaultProfiles();
  if (raw?.version === 2 && Array.isArray(raw.profiles)) {
    const migratedProfiles = raw.profiles
      .map((profile) => normalizeInstallerMetaProfile(profile))
      .filter((profile) => profile !== null);
    if (migratedProfiles.length > 0) {
      next.providers.anthropic.profiles.push(...migratedProfiles);
      const activeProfileId = migratedProfiles.some((profile) => profile.id === raw.activeProfileId)
        ? raw.activeProfileId
        : migratedProfiles[0].id;
      next.providers.anthropic.activeProfileId = activeProfileId;
    }
  }
  return next;
}

function normalizeSecretsFile(raw) {
  if (raw?.version === 1 && raw.providers?.anthropic) {
    return raw;
  }

  const next = createDefaultSecrets();
  if (raw?.version === 2 && raw.profiles && typeof raw.profiles === 'object') {
    for (const [profileId, profileSecrets] of Object.entries(raw.profiles)) {
      if (profileSecrets?.apiKey) {
        next.providers.anthropic[profileId] = { apiKey: profileSecrets.apiKey };
      }
    }
  }
  return next;
}

function writeClaudeProfile(projectDir, apiKey, baseUrl, model) {
  const profileDir = path.join(projectDir, '.cat-cafe');
  mkdirSync(profileDir, { recursive: true });
  const profileFile = path.join(profileDir, 'provider-profiles.json');
  const secretsFile = path.join(profileDir, 'provider-profiles.secrets.local.json');
  const now = new Date().toISOString();
  const profiles = normalizeProfilesFile(readJson(profileFile, null));
  const secrets = normalizeSecretsFile(readJson(secretsFile, null));
  const anthropic = profiles.providers.anthropic ?? { activeProfileId: '', profiles: [] };
  const nextProfiles = anthropic.profiles.filter((profile) => profile.id !== INSTALLER_PROFILE_ID);
  nextProfiles.push({
    id: INSTALLER_PROFILE_ID,
    provider: 'anthropic',
    name: 'Installer API Key',
    mode: 'api_key',
    baseUrl: baseUrl || 'https://api.anthropic.com',
    createdAt: now,
    updatedAt: now,
    ...(model ? { modelOverride: model } : {}),
  });
  profiles.providers.anthropic = {
    ...anthropic,
    activeProfileId: INSTALLER_PROFILE_ID,
    profiles: nextProfiles,
  };
  secrets.providers.anthropic = {
    ...(secrets.providers.anthropic ?? {}),
    [INSTALLER_PROFILE_ID]: { apiKey },
  };
  writeFileSync(profileFile, `${JSON.stringify(profiles, null, 2)}\n`);
  writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`);
  chmodSync(secretsFile, 0o600);
}

function removeClaudeProfile(projectDir) {
  const profileDir = path.join(projectDir, '.cat-cafe');
  if (!existsSync(profileDir)) {
    return;
  }
  const profileFile = path.join(profileDir, 'provider-profiles.json');
  const secretsFile = path.join(profileDir, 'provider-profiles.secrets.local.json');
  if (!existsSync(profileFile) && !existsSync(secretsFile)) {
    return;
  }
  const profiles = normalizeProfilesFile(readJson(profileFile, null));
  const secrets = normalizeSecretsFile(readJson(secretsFile, null));
  if (!profiles?.providers?.anthropic) {
    return;
  }
  const anthropic = profiles.providers.anthropic;
  const nextProfiles = (anthropic.profiles ?? []).filter((profile) => profile.id !== INSTALLER_PROFILE_ID);
  profiles.providers.anthropic = {
    ...anthropic,
    profiles: nextProfiles,
    activeProfileId:
      anthropic.activeProfileId === INSTALLER_PROFILE_ID ? (nextProfiles[0]?.id ?? '') : anthropic.activeProfileId,
  };
  if (secrets?.providers?.anthropic?.[INSTALLER_PROFILE_ID]) {
    delete secrets.providers.anthropic[INSTALLER_PROFILE_ID];
  }
  writeFileSync(profileFile, `${JSON.stringify(profiles, null, 2)}\n`);
  if (secrets) {
    writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`);
  }
}

try {
  const { positionals, values } = parseArgs(process.argv.slice(2));
  if (positionals[0] === 'env-apply') {
    applyEnvChanges(getRequired(values, 'env-file'), values.get('set') ?? [], values.get('delete') ?? []);
    process.exit(0);
  }

  if (positionals[0] === 'claude-profile' && positionals[1] === 'set') {
    const apiKey = getOptional(values, 'api-key', '') || process.env._INSTALLER_API_KEY || '';
    if (!apiKey) {
      console.error('Error: API key required via --api-key or _INSTALLER_API_KEY env var');
      process.exit(1);
    }
    writeClaudeProfile(
      getRequired(values, 'project-dir'),
      apiKey,
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
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
