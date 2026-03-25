import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { isSameProject } from '../utils/monorepo-root.js';
import type {
  AnthropicRuntimeProfile,
  BootstrapBinding,
  BootstrapBindings,
  BuiltinAccountClient,
  CreateProviderProfileInput,
  NormalizedState,
  ProviderProfileAuthType,
  ProviderProfileMeta,
  ProviderProfileMode,
  ProviderProfileProtocol,
  ProviderProfileProvider,
  ProviderProfilesMetaFile,
  ProviderProfilesSecretsFile,
  ProviderProfilesView,
  ProviderProfileView,
  RuntimeProviderProfile,
  UpdateProviderProfileInput,
} from './provider-profiles.types.js';
import {
  detectProjectLocalProfiles,
  listProviderProfilesProjectRoots,
  registerProjectRoot,
  resolveProviderProfilesRoot,
  resolveProviderProfilesRootSync,
} from './provider-profiles-root.js';

export type {
  AnthropicRuntimeProfile,
  BootstrapBinding,
  BootstrapBindings,
  BuiltinAccountClient,
  CreateProviderProfileInput,
  ProviderProfileAuthType,
  ProviderProfileMeta,
  ProviderProfileMode,
  ProviderProfileProtocol,
  ProviderProfileProvider,
  ProviderProfilesView,
  ProviderProfileView,
  RuntimeProviderProfile,
  UpdateProviderProfileInput,
} from './provider-profiles.types.js';

const CAT_CAFE_DIR = '.cat-cafe';
const META_FILENAME = 'provider-profiles.json';
const SECRETS_FILENAME = 'provider-profiles.secrets.local.json';

const BUILTIN_ACCOUNT_SPECS = [
  {
    id: 'claude',
    displayName: 'Claude (OAuth)',
    client: 'anthropic',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929'],
  },
  {
    id: 'codex',
    displayName: 'Codex (OAuth)',
    client: 'openai',
    models: ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.3-codex-spark', 'codex'],
  },
  {
    id: 'gemini',
    displayName: 'Gemini (OAuth)',
    client: 'google',
    models: ['gemini-3.1-pro-preview', 'gemini-2.5-pro'],
  },
  { id: 'dare', displayName: 'Dare (client-auth)', client: 'dare', models: ['z-ai/glm-4.7'] },
  {
    id: 'opencode',
    displayName: 'OpenCode (client-auth)',
    client: 'opencode',
    models: ['anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-5'],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  displayName: string;
  client: BuiltinAccountClient;
  models: string[];
}>;

const BUILTIN_CLIENT_IDS = Object.fromEntries(BUILTIN_ACCOUNT_SPECS.map((spec) => [spec.client, spec.id])) as Record<
  BuiltinAccountClient,
  string
>;

const LEGACY_BUILTIN_ID_MAP: Record<string, BuiltinAccountClient> = {
  'claude-oauth': 'anthropic',
  'codex-oauth': 'openai',
  'gemini-oauth': 'google',
};

const CLIENT_PROTOCOL_MAP: Partial<Record<BuiltinAccountClient, ProviderProfileProtocol>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  dare: 'openai',
  opencode: 'anthropic',
};

const DEFAULT_BOOTSTRAP_CLIENTS: BuiltinAccountClient[] = ['anthropic', 'openai', 'google'];
const ALL_BUILTIN_CLIENTS = BUILTIN_ACCOUNT_SPECS.map((spec) => spec.client) as BuiltinAccountClient[];
const providerStoreLocks = new Map<string, Promise<void>>();

async function withStorageRootLock<T>(storageRoot: string, action: () => Promise<T>): Promise<T> {
  const previous = providerStoreLocks.get(storageRoot) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = previous.then(() => gate);
  providerStoreLocks.set(storageRoot, running);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (providerStoreLocks.get(storageRoot) === running) {
      providerStoreLocks.delete(storageRoot);
    }
  }
}

async function withProviderStoreLock<T>(projectRoot: string, action: (storageRoot: string) => Promise<T>): Promise<T> {
  const storageRoot = await resolveProviderProfilesRoot(projectRoot);
  registerProjectRoot(projectRoot);
  return withStorageRootLock(storageRoot, async () => {
    const localRoot = detectProjectLocalProfiles(projectRoot);
    if (localRoot) {
      await migrateProjectLocalToGlobal(localRoot, storageRoot);
    }
    return action(storageRoot);
  });
}

type LegacyProviderProfilesMetaFileV1 = {
  version: 1;
  providers?: {
    anthropic?: {
      activeProfileId: string | null;
      profiles: Array<{
        id: string;
        provider?: string;
        name?: string;
        displayName?: string;
        mode?: ProviderProfileMode;
        authType?: ProviderProfileAuthType;
        baseUrl?: string;
        createdAt?: string;
        updatedAt?: string;
      }>;
    };
  };
};

type LegacyProviderProfilesMetaFileV2 = {
  version: 2;
  activeProfileId?: string | null;
  activeProfileIds?: Partial<Record<'anthropic' | 'openai' | 'google', string | null>>;
  profiles?: Array<{
    id: string;
    provider?: string;
    displayName?: string;
    name?: string;
    authType?: ProviderProfileAuthType;
    mode?: ProviderProfileMode;
    protocol?: 'anthropic' | 'openai' | 'google';
    builtin?: boolean;
    baseUrl?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
};

type LegacyProviderProfilesSecretsFileV1 = {
  version: 1;
  providers?: {
    anthropic?: Record<string, { apiKey?: string }>;
  };
};

type LegacyProviderProfilesSecretsFileV2 = {
  version: 2;
  profiles?: Record<string, { apiKey?: string }>;
};

function safePath(projectRoot: string, ...segments: string[]): string {
  const root = resolve(projectRoot);
  const normalized = resolve(root, ...segments);
  const rel = relative(root, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

function normalizeProtocol(protocol: string | undefined): ProviderProfileProtocol | undefined {
  const trimmed = protocol?.trim();
  if (trimmed === 'anthropic' || trimmed === 'openai' || trimmed === 'google') {
    return trimmed;
  }
  return undefined;
}

function normalizeModels(models: string[] | undefined): string[] | undefined {
  if (!Array.isArray(models)) return undefined;
  return Array.from(new Set(models.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function normalizeBuiltinModels(models: string[] | undefined, builtinModels: string[]): string[] {
  const normalized = normalizeModels(models);
  if (!normalized) return [...builtinModels];
  return Array.from(new Set([...normalized, ...builtinModels]));
}

function authTypeToMode(authType: ProviderProfileAuthType): ProviderProfileMode {
  return authType === 'api_key' ? 'api_key' : 'subscription';
}

function modeToAuthType(mode: ProviderProfileMode | undefined): ProviderProfileAuthType {
  return mode === 'api_key' ? 'api_key' : 'oauth';
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `account-${randomUUID().slice(0, 8)}`;
}

function createUniqueAccountId(existingProfiles: ProviderProfileMeta[], displayName: string): string {
  const seed = slugify(displayName);
  const existingIds = new Set(existingProfiles.map((profile) => profile.id));
  if (!existingIds.has(seed)) return seed;
  let counter = 2;
  while (existingIds.has(`${seed}-${counter}`)) counter += 1;
  return `${seed}-${counter}`;
}

function createBuiltinProfiles(now = new Date().toISOString()): ProviderProfileMeta[] {
  return BUILTIN_ACCOUNT_SPECS.map((spec) => ({
    id: spec.id,
    displayName: spec.displayName,
    kind: 'builtin',
    authType: 'oauth',
    builtin: true,
    client: spec.client,
    ...(CLIENT_PROTOCOL_MAP[spec.client] ? { protocol: CLIENT_PROTOCOL_MAP[spec.client] } : {}),
    models: [...spec.models],
    createdAt: now,
    updatedAt: now,
  }));
}

function createDefaultBootstrapBindings(): BootstrapBindings {
  const next: BootstrapBindings = {};
  for (const client of ALL_BUILTIN_CLIENTS) {
    if (DEFAULT_BOOTSTRAP_CLIENTS.includes(client)) {
      next[client] = {
        enabled: true,
        mode: 'oauth',
        accountRef: BUILTIN_CLIENT_IDS[client],
      };
    } else {
      next[client] = {
        enabled: false,
        mode: 'skip',
      };
    }
  }
  return next;
}

function createDefaultMeta(): ProviderProfilesMetaFile {
  return {
    version: 3,
    activeProfileId: null,
    providers: createBuiltinProfiles(),
    bootstrapBindings: createDefaultBootstrapBindings(),
  };
}

function createDefaultSecrets(): ProviderProfilesSecretsFile {
  return {
    version: 3,
    profiles: {},
  };
}

function isBuiltinClient(value: string | undefined | null): value is BuiltinAccountClient {
  return value === 'anthropic' || value === 'openai' || value === 'google' || value === 'dare' || value === 'opencode';
}

function normalizeProfile(profile: ProviderProfileMeta): ProviderProfileMeta {
  if (profile.kind === 'builtin' || profile.builtin) {
    const client = isBuiltinClient(profile.client) ? profile.client : LEGACY_BUILTIN_ID_MAP[profile.id];
    if (!client) {
      throw new Error(`Unknown builtin client for account ${profile.id}`);
    }
    const builtin = BUILTIN_ACCOUNT_SPECS.find((spec) => spec.client === client)!;
    return {
      id: builtin.id,
      displayName: profile.displayName?.trim() || builtin.displayName,
      kind: 'builtin',
      authType: 'oauth',
      builtin: true,
      client,
      ...(CLIENT_PROTOCOL_MAP[client] ? { protocol: CLIENT_PROTOCOL_MAP[client] } : {}),
      // Builtin baselines may grow across releases; preserve user-added models
      // while automatically backfilling newly supported defaults.
      models: normalizeBuiltinModels(profile.models, builtin.models),
      createdAt: profile.createdAt || new Date().toISOString(),
      updatedAt: profile.updatedAt || profile.createdAt || new Date().toISOString(),
    };
  }

  return {
    id: profile.id,
    displayName: profile.displayName?.trim() || profile.id,
    kind: 'api_key',
    authType: 'api_key',
    builtin: false,
    ...(normalizeProtocol(profile.protocol) ? { protocol: normalizeProtocol(profile.protocol) } : {}),
    ...(normalizeBaseUrl(profile.baseUrl) ? { baseUrl: normalizeBaseUrl(profile.baseUrl) } : {}),
    ...(normalizeModels(profile.models) !== undefined ? { models: normalizeModels(profile.models) } : {}),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function inferLegacyProtocol(...candidates: Array<string | undefined>): ProviderProfileProtocol | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeProtocol(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function migrateLegacyMetaV1(meta: LegacyProviderProfilesMetaFileV1 | null): ProviderProfilesMetaFile {
  const next = createDefaultMeta();
  if (!meta?.providers?.anthropic?.profiles) return next;

  const now = new Date().toISOString();
  const migrated: ProviderProfileMeta[] = [];
  for (const legacyProfile of meta.providers.anthropic.profiles) {
    const legacyId = legacyProfile.id;
    if (legacyId === 'anthropic-subscription-default' || LEGACY_BUILTIN_ID_MAP[legacyId]) {
      continue;
    }
    migrated.push({
      id: legacyId,
      displayName: legacyProfile.displayName?.trim() || legacyProfile.name?.trim() || legacyId,
      kind: 'api_key',
      authType: 'api_key',
      builtin: false,
      protocol: inferLegacyProtocol(legacyProfile.provider, 'anthropic'),
      ...(normalizeBaseUrl(legacyProfile.baseUrl) ? { baseUrl: normalizeBaseUrl(legacyProfile.baseUrl) } : {}),
      createdAt: legacyProfile.createdAt || now,
      updatedAt: legacyProfile.updatedAt || legacyProfile.createdAt || now,
    });
  }
  next.providers.push(...migrated);

  const activeId = meta.providers.anthropic.activeProfileId;
  if (activeId && !LEGACY_BUILTIN_ID_MAP[activeId] && migrated.some((profile) => profile.id === activeId)) {
    next.bootstrapBindings.anthropic = {
      enabled: true,
      mode: 'api_key',
      accountRef: activeId,
    };
  }
  return next;
}

function migrateLegacyMetaV2(meta: LegacyProviderProfilesMetaFileV2 | null): ProviderProfilesMetaFile {
  const next = createDefaultMeta();
  if (!meta?.profiles) return next;

  const now = new Date().toISOString();
  const migrated: ProviderProfileMeta[] = [];
  for (const legacyProfile of meta.profiles) {
    const legacyId = legacyProfile.id;
    const builtinClient = LEGACY_BUILTIN_ID_MAP[legacyId];
    if (builtinClient) {
      continue;
    }
    if (legacyProfile.builtin) {
      continue;
    }
    migrated.push({
      id: legacyId,
      displayName: legacyProfile.displayName?.trim() || legacyProfile.name?.trim() || legacyId,
      kind: 'api_key',
      authType: 'api_key',
      builtin: false,
      ...(inferLegacyProtocol(legacyProfile.protocol, legacyProfile.provider)
        ? { protocol: inferLegacyProtocol(legacyProfile.protocol, legacyProfile.provider) }
        : {}),
      ...(normalizeBaseUrl(legacyProfile.baseUrl) ? { baseUrl: normalizeBaseUrl(legacyProfile.baseUrl) } : {}),
      createdAt: legacyProfile.createdAt || now,
      updatedAt: legacyProfile.updatedAt || legacyProfile.createdAt || now,
    });
  }
  next.providers.push(...migrated);

  const selected = meta.activeProfileIds ?? {};
  const legacyAnthropic = selected.anthropic ?? meta.activeProfileId ?? null;
  const legacyOpenAI = selected.openai ?? null;
  const legacyGoogle = selected.google ?? null;
  const picks: Array<[BuiltinAccountClient, string | null]> = [
    ['anthropic', legacyAnthropic],
    ['openai', legacyOpenAI],
    ['google', legacyGoogle],
  ];
  for (const [client, activeId] of picks) {
    if (!activeId || LEGACY_BUILTIN_ID_MAP[activeId]) continue;
    if (!migrated.some((profile) => profile.id === activeId)) continue;
    next.bootstrapBindings[client] = {
      enabled: true,
      mode: 'api_key',
      accountRef: activeId,
    };
  }
  return next;
}

function normalizeBootstrapBindings(
  raw: BootstrapBindings | undefined,
  profiles: ProviderProfileMeta[],
): BootstrapBindings {
  const defaults = createDefaultBootstrapBindings();
  const byId = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const next: BootstrapBindings = {};

  for (const client of ALL_BUILTIN_CLIENTS) {
    const candidate = raw?.[client];
    if (!candidate) {
      next[client] = defaults[client];
      continue;
    }

    if (candidate.mode === 'oauth') {
      next[client] =
        candidate.enabled === false
          ? defaults[client]
          : {
              enabled: true,
              mode: 'oauth',
              accountRef: BUILTIN_CLIENT_IDS[client],
            };
      continue;
    }

    if (candidate.mode === 'skip' || candidate.enabled === false) {
      next[client] = { enabled: false, mode: 'skip' };
      continue;
    }

    const accountRef = candidate.accountRef?.trim();
    const profile = accountRef ? byId.get(accountRef) : undefined;
    if (candidate.mode === 'api_key' && profile?.kind === 'api_key') {
      next[client] = { enabled: true, mode: 'api_key', accountRef: profile.id };
      continue;
    }

    next[client] = defaults[client];
  }

  return next;
}

function sortProfiles(profiles: ProviderProfileMeta[]): ProviderProfileMeta[] {
  const builtinOrder = new Map<string, number>(BUILTIN_ACCOUNT_SPECS.map((spec, index) => [spec.id, index]));
  return [...profiles].sort((a, b) => {
    const aBuiltin = builtinOrder.get(a.id);
    const bBuiltin = builtinOrder.get(b.id);
    if (aBuiltin != null && bBuiltin != null) return aBuiltin - bBuiltin;
    if (aBuiltin != null) return -1;
    if (bBuiltin != null) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function normalizeMeta(
  meta: ProviderProfilesMetaFile | LegacyProviderProfilesMetaFileV1 | LegacyProviderProfilesMetaFileV2 | null,
): NormalizedState<ProviderProfilesMetaFile> {
  if (!meta) {
    return { value: createDefaultMeta(), dirty: true };
  }

  let next: ProviderProfilesMetaFile;
  let dirty = false;

  if (meta.version === 1) {
    next = migrateLegacyMetaV1(meta);
    dirty = true;
  } else if (meta.version === 2) {
    next = migrateLegacyMetaV2(meta);
    dirty = true;
  } else {
    next = structuredClone(meta);
  }

  const normalizedProfiles = new Map<string, ProviderProfileMeta>();
  for (const builtin of createBuiltinProfiles()) {
    normalizedProfiles.set(builtin.id, builtin);
  }
  for (const rawProfile of next.providers ?? []) {
    const profile = normalizeProfile(rawProfile);
    normalizedProfiles.set(profile.id, profile);
  }

  const providers = sortProfiles(Array.from(normalizedProfiles.values()));
  const bootstrapBindings = normalizeBootstrapBindings(next.bootstrapBindings, providers);
  if (
    JSON.stringify(providers) !== JSON.stringify(next.providers ?? []) ||
    JSON.stringify(bootstrapBindings) !== JSON.stringify(next.bootstrapBindings ?? {})
  ) {
    dirty = true;
  }

  return {
    value: {
      version: 3,
      activeProfileId: null,
      providers,
      bootstrapBindings,
    },
    dirty,
  };
}

function migrateLegacySecrets(
  secrets:
    | ProviderProfilesSecretsFile
    | LegacyProviderProfilesSecretsFileV1
    | LegacyProviderProfilesSecretsFileV2
    | null,
): ProviderProfilesSecretsFile {
  if (!secrets) return createDefaultSecrets();
  if (secrets.version === 1) {
    return {
      version: 3,
      profiles: { ...(secrets.providers?.anthropic ?? {}) },
    };
  }
  if (secrets.version === 2) {
    return {
      version: 3,
      profiles: { ...(secrets.profiles ?? {}) },
    };
  }
  return secrets;
}

function normalizeSecrets(
  secrets:
    | ProviderProfilesSecretsFile
    | LegacyProviderProfilesSecretsFileV1
    | LegacyProviderProfilesSecretsFileV2
    | null,
): NormalizedState<ProviderProfilesSecretsFile> {
  if (!secrets) {
    return { value: createDefaultSecrets(), dirty: true };
  }
  if (secrets.version !== 3) {
    return { value: migrateLegacySecrets(secrets), dirty: true };
  }
  return { value: secrets, dirty: false };
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function migrateProjectLocalToGlobal(projectRoot: string, globalRoot: string): Promise<void> {
  const localResult = await readRawAtStorageRoot(projectRoot);
  const globalDir = safePath(globalRoot, CAT_CAFE_DIR);
  await mkdir(globalDir, { recursive: true });
  const globalMetaPath = safePath(globalRoot, CAT_CAFE_DIR, META_FILENAME);
  const globalSecretsPath = safePath(globalRoot, CAT_CAFE_DIR, SECRETS_FILENAME);

  // Merge: if global already has profiles, add non-duplicate local profiles
  if (existsSync(globalMetaPath)) {
    const globalResult = await readRawAtStorageRoot(globalRoot);
    const existingIds = new Set(globalResult.meta.providers.map((p) => p.id));
    for (const profile of localResult.meta.providers) {
      if (!existingIds.has(profile.id)) {
        globalResult.meta.providers.push(profile);
        if (localResult.secrets.profiles[profile.id]) {
          globalResult.secrets.profiles[profile.id] = localResult.secrets.profiles[profile.id];
        }
      }
    }
    await writeRaw(globalMetaPath, globalSecretsPath, globalResult.meta, globalResult.secrets);
  } else {
    await writeRaw(globalMetaPath, globalSecretsPath, localResult.meta, localResult.secrets);
  }

  // Mark local file as migrated to prevent re-processing
  const localMetaPath = safePath(projectRoot, CAT_CAFE_DIR, META_FILENAME);
  renameSync(localMetaPath, `${localMetaPath}.migrated`);
}

function migrateProjectLocalToGlobalSync(projectRoot: string, globalRoot: string): void {
  const localDir = safePath(projectRoot, CAT_CAFE_DIR);
  const globalDir = safePath(globalRoot, CAT_CAFE_DIR);
  mkdirSync(globalDir, { recursive: true });
  const localMetaPath = safePath(localDir, META_FILENAME);
  const localSecretsPath = safePath(localDir, SECRETS_FILENAME);
  const globalMetaPath = safePath(globalDir, META_FILENAME);
  const globalSecretsPath = safePath(globalDir, SECRETS_FILENAME);

  if (!existsSync(localMetaPath)) return;

  // Merge: if global already has profiles, add non-duplicate local profiles
  if (existsSync(globalMetaPath)) {
    const localMeta = JSON.parse(readFileSync(localMetaPath, 'utf-8')) as ProviderProfilesMetaFile;
    const globalMeta = JSON.parse(readFileSync(globalMetaPath, 'utf-8')) as ProviderProfilesMetaFile;
    const existingIds = new Set((globalMeta.providers ?? []).map((p) => p.id));
    const localProviders = (localMeta.providers ?? []).filter((p) => !existingIds.has(p.id));
    if (localProviders.length > 0) {
      globalMeta.providers = [...(globalMeta.providers ?? []), ...localProviders];
      writeFileSync(globalMetaPath, `${JSON.stringify(globalMeta, null, 2)}\n`);
      // Merge secrets too
      if (existsSync(localSecretsPath)) {
        const localSecrets = JSON.parse(readFileSync(localSecretsPath, 'utf-8'));
        const globalSecrets = existsSync(globalSecretsPath)
          ? JSON.parse(readFileSync(globalSecretsPath, 'utf-8'))
          : { profiles: {} };
        for (const p of localProviders) {
          if (localSecrets.profiles?.[p.id]) {
            globalSecrets.profiles[p.id] = localSecrets.profiles[p.id];
          }
        }
        writeFileSync(globalSecretsPath, `${JSON.stringify(globalSecrets, null, 2)}\n`);
        chmodSync(globalSecretsPath, 0o600);
      }
    }
  } else {
    copyFileSync(localMetaPath, globalMetaPath);
    if (existsSync(localSecretsPath)) {
      copyFileSync(localSecretsPath, globalSecretsPath);
      chmodSync(globalSecretsPath, 0o600);
    }
  }

  // Mark local file as migrated
  renameSync(localMetaPath, `${localMetaPath}.migrated`);
}

async function readRaw(projectRoot: string): Promise<{
  meta: ProviderProfilesMetaFile;
  secrets: ProviderProfilesSecretsFile;
  metaPath: string;
  secretsPath: string;
  dirty: boolean;
}> {
  const storageRoot = await resolveProviderProfilesRoot(projectRoot);
  const localRoot = detectProjectLocalProfiles(projectRoot);
  if (localRoot) {
    await migrateProjectLocalToGlobal(localRoot, storageRoot);
  }
  return readRawAtStorageRoot(storageRoot);
}

async function readRawAtStorageRoot(storageRoot: string): Promise<{
  meta: ProviderProfilesMetaFile;
  secrets: ProviderProfilesSecretsFile;
  metaPath: string;
  secretsPath: string;
  dirty: boolean;
}> {
  const dir = safePath(storageRoot, CAT_CAFE_DIR);
  const metaPath = safePath(storageRoot, CAT_CAFE_DIR, META_FILENAME);
  const secretsPath = safePath(storageRoot, CAT_CAFE_DIR, SECRETS_FILENAME);
  await mkdir(dir, { recursive: true });
  const normalizedMeta = normalizeMeta(
    await readJsonOrNull<
      ProviderProfilesMetaFile | LegacyProviderProfilesMetaFileV1 | LegacyProviderProfilesMetaFileV2
    >(metaPath),
  );
  const normalizedSecrets = normalizeSecrets(
    await readJsonOrNull<
      ProviderProfilesSecretsFile | LegacyProviderProfilesSecretsFileV1 | LegacyProviderProfilesSecretsFileV2
    >(secretsPath),
  );
  return {
    meta: normalizedMeta.value,
    secrets: normalizedSecrets.value,
    metaPath,
    secretsPath,
    dirty: normalizedMeta.dirty || normalizedSecrets.dirty,
  };
}

async function writeRaw(
  metaPath: string,
  secretsPath: string,
  meta: ProviderProfilesMetaFile,
  secrets: ProviderProfilesSecretsFile,
): Promise<void> {
  await writeJsonAtomic(secretsPath, secrets);
  await writeJsonAtomic(metaPath, meta);
}

function toViewProfile(profile: ProviderProfileMeta, secrets: ProviderProfilesSecretsFile): ProviderProfileView {
  return {
    ...profile,
    provider: profile.id,
    name: profile.displayName,
    mode: authTypeToMode(profile.authType),
    hasApiKey: Boolean(secrets.profiles[profile.id]?.apiKey),
  };
}

function toView(meta: ProviderProfilesMetaFile, secrets: ProviderProfilesSecretsFile): ProviderProfilesView {
  return {
    activeProfileId: null,
    providers: meta.providers.map((profile) => toViewProfile(profile, secrets)),
    bootstrapBindings: meta.bootstrapBindings,
  };
}

function requireDisplayName(input: CreateProviderProfileInput | UpdateProviderProfileInput): string {
  const displayName = input.displayName ?? input.name;
  const trimmed = displayName?.trim();
  if (!trimmed) throw new Error('displayName or name is required');
  return trimmed;
}

function findProfile(meta: ProviderProfilesMetaFile, profileId: string): ProviderProfileMeta | undefined {
  return meta.providers.find((profile) => profile.id === profileId);
}

function resolveClientFromSelector(
  selector: ProviderProfileProvider | undefined,
  profile?: ProviderProfileMeta,
): BuiltinAccountClient | null {
  const trimmed = selector?.trim();
  if (trimmed && isBuiltinClient(trimmed)) return trimmed;
  if (profile?.client) return profile.client;
  if (trimmed) {
    const legacyClient = LEGACY_BUILTIN_ID_MAP[trimmed];
    if (legacyClient) return legacyClient;
  }
  return null;
}

function assertProviderSelector(profile: ProviderProfileMeta, selector: ProviderProfileProvider): void {
  const trimmed = selector?.trim();
  if (!trimmed) return;
  if (trimmed === profile.id) return;
  if (profile.kind === 'api_key') {
    if (isBuiltinClient(trimmed)) return;
    if (LEGACY_BUILTIN_ID_MAP[trimmed]) return;
    throw new Error('profile not found');
  }
  if (profile.client && trimmed === profile.client) return;
  if (LEGACY_BUILTIN_ID_MAP[trimmed] && profile.client === LEGACY_BUILTIN_ID_MAP[trimmed]) return;
  throw new Error('profile not found');
}

function readRuntimeCatalog(projectRoot: string): any | null {
  const filePath = resolve(projectRoot, '.cat-cafe', 'cat-catalog.json');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function collectRuntimeCatsBoundToProfile(projectRoot: string, profileId: string): string[] {
  const catalog = readRuntimeCatalog(projectRoot);
  if (!catalog?.breeds || !Array.isArray(catalog.breeds)) return [];
  const result = new Set<string>();
  for (const breed of catalog.breeds) {
    for (const variant of breed.variants ?? []) {
      const accountRef = typeof variant.accountRef === 'string' ? variant.accountRef : variant.providerProfileId;
      if (accountRef !== profileId) continue;
      result.add(variant.catId ?? breed.catId);
    }
  }
  return Array.from(result);
}

async function collectRuntimeCatsBoundToProfileAcrossRoots(projectRoot: string, profileId: string): Promise<string[]> {
  const roots = await listProviderProfilesProjectRoots(projectRoot);
  const result = new Set<string>();
  for (const root of roots) {
    // Skip sibling worktrees — only scan the caller's own root and truly separate projects
    if (resolve(root) !== resolve(projectRoot) && isSameProject(root, projectRoot)) continue;
    for (const catId of collectRuntimeCatsBoundToProfile(root, profileId)) {
      result.add(catId);
    }
  }
  return Array.from(result);
}

function isReferencedByBootstrapBindings(meta: ProviderProfilesMetaFile, profileId: string): boolean {
  return Object.values(meta.bootstrapBindings).some((binding) => binding?.accountRef === profileId);
}

export function builtinAccountIdForClient(client: BuiltinAccountClient): string {
  return BUILTIN_CLIENT_IDS[client];
}

export async function readBootstrapBindings(projectRoot: string): Promise<BootstrapBindings> {
  return withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath, dirty } = await readRawAtStorageRoot(storageRoot);
    if (dirty) await writeRaw(metaPath, secretsPath, meta, secrets);
    return meta.bootstrapBindings;
  });
}

export function readBootstrapBindingsSync(projectRoot: string): BootstrapBindings {
  const storageRoot = resolveProviderProfilesRootSync(projectRoot);
  registerProjectRoot(projectRoot);
  const localRoot = detectProjectLocalProfiles(projectRoot);
  if (localRoot) {
    migrateProjectLocalToGlobalSync(localRoot, storageRoot);
  }
  const metaPath = safePath(storageRoot, CAT_CAFE_DIR, META_FILENAME);
  const raw = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, 'utf-8')) as
        | ProviderProfilesMetaFile
        | LegacyProviderProfilesMetaFileV1
        | LegacyProviderProfilesMetaFileV2)
    : null;
  return normalizeMeta(raw).value.bootstrapBindings;
}

export async function setBootstrapBinding(
  projectRoot: string,
  client: BuiltinAccountClient,
  binding: BootstrapBinding,
): Promise<BootstrapBindings> {
  return withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath } = await readRawAtStorageRoot(storageRoot);
    if (!isBuiltinClient(client)) {
      throw new Error(`unsupported client "${client}"`);
    }
    if (binding.mode === 'skip' || !binding.enabled) {
      meta.bootstrapBindings[client] = { enabled: false, mode: 'skip' };
    } else if (binding.mode === 'api_key') {
      const accountRef = binding.accountRef?.trim();
      const profile = accountRef ? findProfile(meta, accountRef) : undefined;
      if (!profile || profile.kind !== 'api_key') {
        throw new Error(`bootstrap api_key binding for "${client}" requires an existing api_key account`);
      }
      meta.bootstrapBindings[client] = {
        enabled: true,
        mode: 'api_key',
        accountRef: profile.id,
      };
    } else {
      meta.bootstrapBindings[client] = {
        enabled: true,
        mode: 'oauth',
        accountRef: builtinAccountIdForClient(client),
      };
    }
    await writeRaw(metaPath, secretsPath, meta, secrets);
    return meta.bootstrapBindings;
  });
}

export async function readProviderProfiles(projectRoot: string): Promise<ProviderProfilesView> {
  return withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath, dirty } = await readRawAtStorageRoot(storageRoot);
    if (dirty) await writeRaw(metaPath, secretsPath, meta, secrets);
    return toView(meta, secrets);
  });
}

export async function createProviderProfile(
  projectRoot: string,
  input: CreateProviderProfileInput,
): Promise<ProviderProfileView> {
  return withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath } = await readRawAtStorageRoot(storageRoot);
    const displayName = requireDisplayName(input);
    const authType = input.authType ?? modeToAuthType(input.mode);
    if (authType !== 'api_key') {
      throw new Error('only api_key accounts can be created');
    }
    const apiKey = input.apiKey?.trim();
    if (!apiKey) throw new Error('apiKey is required for api_key mode');

    const profile: ProviderProfileMeta = {
      id: createUniqueAccountId(meta.providers, displayName),
      displayName,
      kind: 'api_key',
      authType: 'api_key',
      builtin: false,
      ...(normalizeProtocol(input.protocol) ? { protocol: normalizeProtocol(input.protocol) } : {}),
      ...(normalizeBaseUrl(input.baseUrl) ? { baseUrl: normalizeBaseUrl(input.baseUrl) } : {}),
      ...(normalizeModels(input.models) !== undefined ? { models: normalizeModels(input.models) } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    meta.providers.push(profile);
    secrets.profiles[profile.id] = { apiKey };
    if (input.setActive) {
      const client = resolveClientFromSelector(input.provider ?? input.protocol, profile);
      if (!client) {
        throw new Error('client selector is required to bind an api_key account');
      }
      meta.bootstrapBindings[client] = {
        enabled: true,
        mode: 'api_key',
        accountRef: profile.id,
      };
    }
    await writeRaw(metaPath, secretsPath, meta, secrets);
    return toViewProfile(profile, secrets);
  });
}

export async function updateProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
  input: UpdateProviderProfileInput,
): Promise<ProviderProfileView> {
  return withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath } = await readRawAtStorageRoot(storageRoot);
    const profile = findProfile(meta, profileId);
    if (!profile) throw new Error('profile not found');
    assertProviderSelector(profile, provider);
    if (profile.kind === 'builtin') {
      const hasNonModelUpdates =
        input.name !== undefined ||
        input.displayName !== undefined ||
        input.mode !== undefined ||
        input.authType !== undefined ||
        input.protocol !== undefined ||
        input.baseUrl !== undefined ||
        input.apiKey !== undefined ||
        input.modelOverride !== undefined;
      if (hasNonModelUpdates) {
        throw new Error('builtin accounts only support model updates');
      }
      if (input.models !== undefined) {
        profile.models = normalizeModels(input.models);
      }
      profile.updatedAt = new Date().toISOString();
      await writeRaw(metaPath, secretsPath, meta, secrets);
      return toViewProfile(profile, secrets);
    }

    if (typeof input.name === 'string' || typeof input.displayName === 'string') {
      profile.displayName = requireDisplayName(input);
    }
    const nextAuthType = input.authType ?? (input.mode ? modeToAuthType(input.mode) : profile.authType);
    if (nextAuthType !== 'api_key') {
      throw new Error('api key accounts cannot be converted to oauth');
    }
    if (typeof input.baseUrl === 'string') {
      const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
      if (normalizedBaseUrl) profile.baseUrl = normalizedBaseUrl;
      else delete profile.baseUrl;
    }
    if (input.protocol !== undefined) {
      const normalizedProtocol = normalizeProtocol(input.protocol);
      if (normalizedProtocol) profile.protocol = normalizedProtocol;
      else delete profile.protocol;
    }
    if (input.models !== undefined) {
      profile.models = normalizeModels(input.models);
    }
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      secrets.profiles[profile.id] = { apiKey: input.apiKey.trim() };
    }
    profile.updatedAt = new Date().toISOString();
    await writeRaw(metaPath, secretsPath, meta, secrets);
    return toViewProfile(profile, secrets);
  });
}

export async function activateProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
): Promise<void> {
  await withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath } = await readRawAtStorageRoot(storageRoot);
    const profile = findProfile(meta, profileId);
    if (!profile) throw new Error('profile not found');
    assertProviderSelector(profile, provider);
    const client = resolveClientFromSelector(provider, profile);
    if (!client) {
      throw new Error('client selector is required to bind an api_key account');
    }
    if (profile.kind === 'builtin') {
      meta.bootstrapBindings[client] = {
        enabled: true,
        mode: 'oauth',
        accountRef: builtinAccountIdForClient(client),
      };
    } else {
      meta.bootstrapBindings[client] = {
        enabled: true,
        mode: 'api_key',
        accountRef: profile.id,
      };
    }
    await writeRaw(metaPath, secretsPath, meta, secrets);
  });
}

export async function deleteProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
): Promise<void> {
  await withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath } = await readRawAtStorageRoot(storageRoot);
    const profile = findProfile(meta, profileId);
    if (!profile) throw new Error('profile not found');
    assertProviderSelector(profile, provider);
    if (profile.kind === 'builtin') {
      throw new Error('builtin provider cannot be deleted');
    }
    const boundCatIds = await collectRuntimeCatsBoundToProfileAcrossRoots(projectRoot, profileId);
    if (boundCatIds.length > 0) {
      throw new Error(`provider profile "${profileId}" is still referenced by runtime cats: ${boundCatIds.join(', ')}`);
    }
    if (isReferencedByBootstrapBindings(meta, profileId)) {
      throw new Error(`provider profile "${profileId}" is still referenced by bootstrap bindings`);
    }
    meta.providers = meta.providers.filter((item) => item.id !== profileId);
    delete secrets.profiles[profileId];
    await writeRaw(metaPath, secretsPath, meta, secrets);
  });
}

export async function getProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
): Promise<ProviderProfileView | null> {
  return withProviderStoreLock(projectRoot, async (storageRoot) => {
    const { meta, secrets, metaPath, secretsPath, dirty } = await readRawAtStorageRoot(storageRoot);
    if (dirty) await writeRaw(metaPath, secretsPath, meta, secrets);
    const profile = findProfile(meta, profileId);
    if (!profile) return null;
    assertProviderSelector(profile, provider);
    return toViewProfile(profile, secrets);
  });
}

function toRuntimeProviderProfile(
  profile: ProviderProfileMeta,
  secrets: ProviderProfilesSecretsFile,
): RuntimeProviderProfile | null {
  if (profile.kind === 'api_key') {
    const apiKey = secrets.profiles[profile.id]?.apiKey;
    if (!apiKey) return null;
    return {
      id: profile.id,
      kind: 'api_key',
      authType: 'api_key',
      ...(profile.protocol ? { protocol: profile.protocol } : {}),
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      ...(profile.models ? { models: profile.models } : {}),
      apiKey,
    };
  }

  return {
    id: profile.id,
    kind: 'builtin',
    authType: 'oauth',
    client: profile.client,
    ...(profile.protocol ? { protocol: profile.protocol } : {}),
    ...(profile.models ? { models: profile.models } : {}),
  };
}

function resolveBuiltinFromProtocol(protocol: 'anthropic' | 'openai' | 'google'): ProviderProfileMeta {
  const client: BuiltinAccountClient =
    protocol === 'anthropic' ? 'anthropic' : protocol === 'openai' ? 'openai' : 'google';
  return resolveBuiltinFromClient(client);
}

function resolveBuiltinFromClient(client: BuiltinAccountClient): ProviderProfileMeta {
  const id = builtinAccountIdForClient(client);
  const spec = BUILTIN_ACCOUNT_SPECS.find((item) => item.id === id);
  if (!spec) {
    throw new Error(`builtin account "${id}" is not registered`);
  }
  return {
    id,
    displayName: spec.displayName,
    kind: 'builtin',
    authType: 'oauth',
    builtin: true,
    client,
    ...(CLIENT_PROTOCOL_MAP[client] ? { protocol: CLIENT_PROTOCOL_MAP[client] } : {}),
    models: [...spec.models],
    createdAt: '',
    updatedAt: '',
  };
}

export async function resolveRuntimeProviderProfile(
  projectRoot: string,
  protocol: 'anthropic' | 'openai' | 'google',
  preferredProfileId?: string,
): Promise<RuntimeProviderProfile | null> {
  const { meta, secrets, dirty } = await readRaw(projectRoot);
  if (dirty) {
    await withProviderStoreLock(projectRoot, async (storageRoot) => {
      const normalized = await readRawAtStorageRoot(storageRoot);
      if (normalized.dirty) {
        await writeRaw(normalized.metaPath, normalized.secretsPath, normalized.meta, normalized.secrets);
      }
    });
  }

  const preferred = preferredProfileId ? findProfile(meta, preferredProfileId) : null;
  if (preferred) {
    return toRuntimeProviderProfile(preferred, secrets);
  }

  const bootstrapBinding = meta.bootstrapBindings[protocol];
  if (bootstrapBinding?.mode === 'api_key') {
    const boundProfile = bootstrapBinding.accountRef ? findProfile(meta, bootstrapBinding.accountRef) : undefined;
    const runtime = boundProfile ? toRuntimeProviderProfile(boundProfile, secrets) : null;
    if (runtime) return runtime;
  }

  const builtin = findProfile(meta, builtinAccountIdForClient(protocol));
  if (builtin) {
    return toRuntimeProviderProfile(builtin, secrets);
  }

  return toRuntimeProviderProfile(resolveBuiltinFromProtocol(protocol), secrets);
}

export async function resolveRuntimeProviderProfileForClient(
  projectRoot: string,
  client: BuiltinAccountClient,
  preferredProfileId?: string,
): Promise<RuntimeProviderProfile | null> {
  const { meta, secrets, dirty } = await readRaw(projectRoot);
  if (dirty) {
    await withProviderStoreLock(projectRoot, async (storageRoot) => {
      const normalized = await readRawAtStorageRoot(storageRoot);
      if (normalized.dirty) {
        await writeRaw(normalized.metaPath, normalized.secretsPath, normalized.meta, normalized.secrets);
      }
    });
  }

  const preferred = preferredProfileId ? findProfile(meta, preferredProfileId) : null;
  if (preferred) {
    return toRuntimeProviderProfile(preferred, secrets);
  }

  const bootstrapBinding = meta.bootstrapBindings[client];
  if (bootstrapBinding?.mode === 'api_key') {
    const boundProfile = bootstrapBinding.accountRef ? findProfile(meta, bootstrapBinding.accountRef) : undefined;
    const runtime = boundProfile ? toRuntimeProviderProfile(boundProfile, secrets) : null;
    if (runtime) return runtime;
  }

  const builtin = findProfile(meta, builtinAccountIdForClient(client));
  if (builtin) {
    return toRuntimeProviderProfile(builtin, secrets);
  }

  return toRuntimeProviderProfile(resolveBuiltinFromClient(client), secrets);
}

export async function resolveRuntimeProviderProfileById(
  projectRoot: string,
  profileId: string,
): Promise<RuntimeProviderProfile | null> {
  const { meta, secrets, dirty } = await readRaw(projectRoot);
  if (dirty) {
    await withProviderStoreLock(projectRoot, async (storageRoot) => {
      const normalized = await readRawAtStorageRoot(storageRoot);
      if (normalized.dirty) {
        await writeRaw(normalized.metaPath, normalized.secretsPath, normalized.meta, normalized.secrets);
      }
    });
  }
  const profile = findProfile(meta, profileId);
  if (!profile) return null;
  return toRuntimeProviderProfile(profile, secrets);
}

export async function resolveAnthropicRuntimeProfile(projectRoot: string): Promise<AnthropicRuntimeProfile> {
  const runtime =
    (await resolveRuntimeProviderProfile(projectRoot, 'anthropic')) ??
    ({
      id: builtinAccountIdForClient('anthropic'),
      kind: 'builtin',
      authType: 'oauth',
      client: 'anthropic',
    } satisfies RuntimeProviderProfile);

  return {
    id: runtime.id,
    mode: authTypeToMode(runtime.authType),
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
  };
}

export async function resolveAnthropicRuntimeProfileById(
  projectRoot: string,
  profileId: string,
): Promise<AnthropicRuntimeProfile | null> {
  const runtime = await resolveRuntimeProviderProfileById(projectRoot, profileId);
  if (!runtime) return null;
  return {
    id: runtime.id,
    mode: authTypeToMode(runtime.authType),
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
  };
}
