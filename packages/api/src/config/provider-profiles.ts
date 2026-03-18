import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type {
  ActiveProviderProfileIds,
  AnthropicRuntimeProfile,
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
import { readCatCatalog } from './cat-catalog-store.js';
import { resolveProviderProfilesRoot } from './provider-profiles-root.js';

export type {
  ActiveProviderProfileIds,
  AnthropicRuntimeProfile,
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
const DEFAULT_CLAUDE_OAUTH_PROVIDER_ID = 'claude-oauth';
const DEFAULT_CODEX_OAUTH_PROVIDER_ID = 'codex-oauth';
const DEFAULT_GEMINI_OAUTH_PROVIDER_ID = 'gemini-oauth';

type LegacyProviderProfilesMetaFile = {
  version: 1;
  providers?: {
    anthropic?: {
      activeProfileId: string | null;
      profiles: Array<{
        id: string;
        provider: 'anthropic';
        name: string;
        mode: ProviderProfileMode;
        baseUrl?: string;
        modelOverride?: string;
        createdAt: string;
        updatedAt: string;
      }>;
    };
  };
};

type LegacyProviderProfilesSecretsFile = {
  version: 1;
  providers?: {
    anthropic?: Record<string, { apiKey?: string }>;
  };
};

const BUILTIN_PROVIDER_SPECS = [
  {
    id: DEFAULT_CLAUDE_OAUTH_PROVIDER_ID,
    provider: DEFAULT_CLAUDE_OAUTH_PROVIDER_ID,
    displayName: 'Claude (OAuth)',
    authType: 'oauth' as const,
    protocol: 'anthropic' as const,
    builtin: true,
    models: ['claude-opus-4-6', 'claude-sonnet-4'],
  },
  {
    id: DEFAULT_CODEX_OAUTH_PROVIDER_ID,
    provider: DEFAULT_CODEX_OAUTH_PROVIDER_ID,
    displayName: 'Codex (OAuth)',
    authType: 'oauth' as const,
    protocol: 'openai' as const,
    builtin: true,
    models: ['gpt-5.4', 'gpt-5.3-codex'],
  },
  {
    id: DEFAULT_GEMINI_OAUTH_PROVIDER_ID,
    provider: DEFAULT_GEMINI_OAUTH_PROVIDER_ID,
    displayName: 'Gemini (OAuth)',
    authType: 'oauth' as const,
    protocol: 'google' as const,
    builtin: true,
    models: ['gemini-3.1-pro', 'gemini-2.5-pro'],
  },
] satisfies Array<
  Pick<ProviderProfileMeta, 'id' | 'provider' | 'displayName' | 'authType' | 'protocol' | 'builtin' | 'models'>
>;

const PROTOCOL_DEFAULT_PROFILE_IDS: Record<ProviderProfileProtocol, string> = {
  anthropic: DEFAULT_CLAUDE_OAUTH_PROVIDER_ID,
  openai: DEFAULT_CODEX_OAUTH_PROVIDER_ID,
  google: DEFAULT_GEMINI_OAUTH_PROVIDER_ID,
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

function isKnownProtocol(value: string | undefined | null): value is ProviderProfileProtocol {
  return value === 'anthropic' || value === 'openai' || value === 'google';
}

function authTypeToMode(authType: ProviderProfileAuthType): ProviderProfileMode {
  return authType === 'api_key' ? 'api_key' : 'subscription';
}

function modeToAuthType(mode: ProviderProfileMode | undefined): ProviderProfileAuthType {
  return mode === 'api_key' ? 'api_key' : 'oauth';
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

function findRuntimeCatsBoundToProfile(projectRoot: string, profileId: string): string[] {
  const catalog = readCatCatalog(projectRoot);
  if (!catalog) return [];

  const boundCatIds = new Set<string>();
  for (const breed of catalog.breeds) {
    for (const variant of breed.variants) {
      if (variant.providerProfileId === profileId) {
        boundCatIds.add(variant.catId ?? breed.catId);
      }
    }
  }
  return Array.from(boundCatIds);
}

function normalizeModels(models: string[] | undefined, modelOverride?: string): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const model of models ?? []) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  const trimmedOverride = modelOverride?.trim();
  if (trimmedOverride && !seen.has(trimmedOverride)) {
    next.push(trimmedOverride);
  }
  return next;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `provider-${randomUUID().slice(0, 8)}`;
}

function createUniqueProviderId(existingProfiles: ProviderProfileMeta[], seed: string): string {
  const existingIds = new Set(existingProfiles.map((profile) => profile.id));
  if (!existingIds.has(seed)) return seed;
  let counter = 2;
  while (existingIds.has(`${seed}-${counter}`)) counter += 1;
  return `${seed}-${counter}`;
}

function inferProtocol(input: CreateProviderProfileInput | UpdateProviderProfileInput, fallback: ProviderProfileProtocol) {
  const candidate = 'protocol' in input ? input.protocol : undefined;
  if (isKnownProtocol(candidate)) return candidate;
  const legacyProvider = 'provider' in input ? input.provider : undefined;
  if (isKnownProtocol(legacyProvider)) return legacyProvider;
  return fallback;
}

function createBuiltinProfiles(now = new Date().toISOString()): ProviderProfileMeta[] {
  return BUILTIN_PROVIDER_SPECS.map((builtin) => ({
    ...builtin,
    models: [...builtin.models],
    createdAt: now,
    updatedAt: now,
  }));
}

function createDefaultActiveProfileIds(): ActiveProviderProfileIds {
  return {
    anthropic: DEFAULT_CLAUDE_OAUTH_PROVIDER_ID,
    openai: DEFAULT_CODEX_OAUTH_PROVIDER_ID,
    google: DEFAULT_GEMINI_OAUTH_PROVIDER_ID,
  };
}

function ensureActiveProfileIds(meta: ProviderProfilesMetaFile): ActiveProviderProfileIds {
  if (meta.activeProfileIds) return meta.activeProfileIds;
  const next = createDefaultActiveProfileIds();
  meta.activeProfileIds = next;
  return next;
}

function syncLegacyActiveProfileId(meta: ProviderProfilesMetaFile): void {
  const activeIds = ensureActiveProfileIds(meta);
  meta.activeProfileId = activeIds.anthropic ?? DEFAULT_CLAUDE_OAUTH_PROVIDER_ID;
}

function findProtocolFallbackProfileId(meta: ProviderProfilesMetaFile, protocol: ProviderProfileProtocol): string | null {
  const preferred = PROTOCOL_DEFAULT_PROFILE_IDS[protocol];
  const builtin = meta.profiles.find((profile) => profile.id === preferred && profile.protocol === protocol);
  if (builtin) return builtin.id;
  const firstSameProtocol = meta.profiles.find((profile) => profile.protocol === protocol);
  return firstSameProtocol?.id ?? null;
}

function setActiveProfile(meta: ProviderProfilesMetaFile, protocol: ProviderProfileProtocol, profileId: string | null): void {
  const activeIds = ensureActiveProfileIds(meta);
  activeIds[protocol] = profileId;
  syncLegacyActiveProfileId(meta);
}

function createDefaultMeta(): ProviderProfilesMetaFile {
  return {
    version: 2,
    activeProfileId: DEFAULT_CLAUDE_OAUTH_PROVIDER_ID,
    activeProfileIds: createDefaultActiveProfileIds(),
    profiles: createBuiltinProfiles(),
  };
}

function createDefaultSecrets(): ProviderProfilesSecretsFile {
  return {
    version: 2,
    profiles: {},
  };
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function normalizeProfile(profile: ProviderProfileMeta): ProviderProfileMeta {
  return {
    ...profile,
    provider: profile.provider || profile.id,
    displayName: profile.displayName?.trim() || profile.provider || profile.id,
    authType: profile.authType === 'api_key' ? 'api_key' : 'oauth',
    protocol: isKnownProtocol(profile.protocol) ? profile.protocol : 'anthropic',
    builtin: Boolean(profile.builtin),
    ...(normalizeBaseUrl(profile.baseUrl) ? { baseUrl: normalizeBaseUrl(profile.baseUrl) } : {}),
    models: normalizeModels(profile.models, profile.modelOverride),
    ...(profile.modelOverride?.trim() ? { modelOverride: profile.modelOverride.trim() } : {}),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function migrateLegacyMeta(meta: LegacyProviderProfilesMetaFile): ProviderProfilesMetaFile {
  const next = createDefaultMeta();
  const legacyAnthropic = meta.providers?.anthropic;
  if (!legacyAnthropic?.profiles) {
    return next;
  }

  for (const profile of legacyAnthropic.profiles) {
    if (profile.id === 'anthropic-subscription-default') {
      const builtin = next.profiles.find((item) => item.id === DEFAULT_CLAUDE_OAUTH_PROVIDER_ID);
      if (builtin && profile.modelOverride?.trim()) {
        builtin.modelOverride = profile.modelOverride.trim();
        builtin.models = normalizeModels(builtin.models, builtin.modelOverride);
        builtin.updatedAt = profile.updatedAt;
      }
      continue;
    }

    next.profiles.push({
      id: profile.id,
      provider: profile.id,
      displayName: profile.name,
      authType: modeToAuthType(profile.mode),
      protocol: 'anthropic',
      builtin: false,
      ...(normalizeBaseUrl(profile.baseUrl) ? { baseUrl: normalizeBaseUrl(profile.baseUrl) } : {}),
      models: normalizeModels(undefined, profile.modelOverride),
      ...(profile.modelOverride?.trim() ? { modelOverride: profile.modelOverride.trim() } : {}),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
  }

  next.activeProfileId =
    legacyAnthropic.activeProfileId === 'anthropic-subscription-default' || !legacyAnthropic.activeProfileId
      ? DEFAULT_CLAUDE_OAUTH_PROVIDER_ID
      : legacyAnthropic.activeProfileId;
  setActiveProfile(next, 'anthropic', next.activeProfileId);
  return next;
}

function normalizeMeta(
  meta: ProviderProfilesMetaFile | LegacyProviderProfilesMetaFile | null,
): NormalizedState<ProviderProfilesMetaFile> {
  if (!meta) {
    return { value: createDefaultMeta(), dirty: true };
  }

  const next = meta.version === 1 ? migrateLegacyMeta(meta) : structuredClone(meta);
  let dirty = meta.version !== 2;

  if (next.version !== 2 || !Array.isArray(next.profiles)) {
    return { value: createDefaultMeta(), dirty: true };
  }

  const normalizedProfiles: ProviderProfileMeta[] = [];
  const seenIds = new Set<string>();
  for (const rawProfile of next.profiles) {
    if (!rawProfile?.id || seenIds.has(rawProfile.id)) {
      dirty = true;
      continue;
    }
    seenIds.add(rawProfile.id);
    normalizedProfiles.push(normalizeProfile(rawProfile));
  }

  const byId = new Map(normalizedProfiles.map((profile) => [profile.id, profile] as const));
  for (const builtinSpec of createBuiltinProfiles()) {
    const existing = byId.get(builtinSpec.id);
    if (!existing) {
      normalizedProfiles.push(builtinSpec);
      byId.set(builtinSpec.id, builtinSpec);
      dirty = true;
      continue;
    }

    const normalizedBuiltin: ProviderProfileMeta = {
      ...existing,
      provider: builtinSpec.provider,
      displayName: existing.displayName || builtinSpec.displayName,
      authType: 'oauth',
      protocol: builtinSpec.protocol,
      builtin: true,
      models: existing.models.length > 0 ? normalizeModels(existing.models, existing.modelOverride) : [...builtinSpec.models],
      createdAt: existing.createdAt || builtinSpec.createdAt,
      updatedAt: existing.updatedAt || existing.createdAt || builtinSpec.updatedAt,
      ...(existing.modelOverride ? { modelOverride: existing.modelOverride } : {}),
    };
    const idx = normalizedProfiles.findIndex((profile) => profile.id === builtinSpec.id);
    normalizedProfiles[idx] = normalizedBuiltin;
    byId.set(builtinSpec.id, normalizedBuiltin);
    if (
      existing.provider !== normalizedBuiltin.provider ||
      existing.authType !== 'oauth' ||
      existing.protocol !== normalizedBuiltin.protocol ||
      existing.builtin !== true
    ) {
      dirty = true;
    }
  }

  const builtinOrder = new Map(BUILTIN_PROVIDER_SPECS.map((profile, index) => [profile.id, index] as const));
  normalizedProfiles.sort((a, b) => {
    const aBuiltinOrder = builtinOrder.get(a.id);
    const bBuiltinOrder = builtinOrder.get(b.id);
    if (aBuiltinOrder != null && bBuiltinOrder != null) return aBuiltinOrder - bBuiltinOrder;
    if (aBuiltinOrder != null) return -1;
    if (bBuiltinOrder != null) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  next.profiles = normalizedProfiles;
  const rawActiveProfileIds = (next as Partial<ProviderProfilesMetaFile>).activeProfileIds;
  const normalizedActiveProfileIds = createDefaultActiveProfileIds();
  if (rawActiveProfileIds && typeof rawActiveProfileIds === 'object') {
    for (const protocol of Object.keys(PROTOCOL_DEFAULT_PROFILE_IDS) as ProviderProfileProtocol[]) {
      const selectedId = rawActiveProfileIds[protocol];
      if (selectedId == null) {
        normalizedActiveProfileIds[protocol] = null;
        continue;
      }
      const matched = byId.get(selectedId);
      if (matched?.protocol === protocol) {
        normalizedActiveProfileIds[protocol] = matched.id;
      } else {
        dirty = true;
      }
    }
  } else {
    dirty = true;
  }

  if (next.activeProfileId && byId.has(next.activeProfileId)) {
    const legacyActive = byId.get(next.activeProfileId)!;
    if (normalizedActiveProfileIds[legacyActive.protocol] !== legacyActive.id) {
      normalizedActiveProfileIds[legacyActive.protocol] = legacyActive.id;
      if (!rawActiveProfileIds) dirty = true;
    }
  }

  for (const protocol of Object.keys(PROTOCOL_DEFAULT_PROFILE_IDS) as ProviderProfileProtocol[]) {
    const selectedId = normalizedActiveProfileIds[protocol];
    const selected = selectedId ? byId.get(selectedId) : undefined;
    if (selectedId && selected?.protocol === protocol) continue;
    normalizedActiveProfileIds[protocol] = findProtocolFallbackProfileId(next, protocol);
    dirty = true;
  }

  next.activeProfileIds = normalizedActiveProfileIds;
  syncLegacyActiveProfileId(next);
  return { value: next, dirty };
}

function migrateLegacySecrets(secrets: LegacyProviderProfilesSecretsFile): ProviderProfilesSecretsFile {
  return {
    version: 2,
    profiles: { ...(secrets.providers?.anthropic ?? {}) },
  };
}

function normalizeSecrets(
  secrets: ProviderProfilesSecretsFile | LegacyProviderProfilesSecretsFile | null,
): NormalizedState<ProviderProfilesSecretsFile> {
  if (!secrets) {
    return { value: createDefaultSecrets(), dirty: true };
  }
  if (secrets.version === 1) {
    return { value: migrateLegacySecrets(secrets), dirty: true };
  }
  if (secrets.version === 2 && secrets.profiles) {
    return { value: secrets, dirty: false };
  }
  return { value: createDefaultSecrets(), dirty: true };
}

async function readRaw(projectRoot: string): Promise<{
  meta: ProviderProfilesMetaFile;
  secrets: ProviderProfilesSecretsFile;
  metaPath: string;
  secretsPath: string;
  dirty: boolean;
}> {
  const storageRoot = await resolveProviderProfilesRoot(projectRoot);
  const dir = safePath(storageRoot, CAT_CAFE_DIR);
  const metaPath = safePath(storageRoot, CAT_CAFE_DIR, META_FILENAME);
  const secretsPath = safePath(storageRoot, CAT_CAFE_DIR, SECRETS_FILENAME);
  await mkdir(dir, { recursive: true });
  const normalizedMeta = normalizeMeta(
    await readJsonOrNull<ProviderProfilesMetaFile | LegacyProviderProfilesMetaFile>(metaPath),
  );
  const normalizedSecrets = normalizeSecrets(
    await readJsonOrNull<ProviderProfilesSecretsFile | LegacyProviderProfilesSecretsFile>(secretsPath),
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
  await Promise.all([writeJson(metaPath, meta), writeJson(secretsPath, secrets)]);
}

function toViewProfile(profile: ProviderProfileMeta, secrets: ProviderProfilesSecretsFile): ProviderProfileView {
  return {
    ...profile,
    name: profile.displayName,
    mode: authTypeToMode(profile.authType),
    hasApiKey: Boolean(secrets.profiles[profile.id]?.apiKey),
  };
}

function toView(meta: ProviderProfilesMetaFile, secrets: ProviderProfilesSecretsFile): ProviderProfilesView {
  const activeProfileIds = ensureActiveProfileIds(meta);
  return {
    activeProfileId: meta.activeProfileId,
    activeProfileIds: { ...activeProfileIds },
    providers: meta.profiles.map((profile) => toViewProfile(profile, secrets)),
  };
}

function requireDisplayName(input: CreateProviderProfileInput | UpdateProviderProfileInput): string {
  const displayName = input.displayName ?? input.name;
  const trimmed = displayName?.trim();
  if (!trimmed) throw new Error('name is required');
  return trimmed;
}

function findProfile(meta: ProviderProfilesMetaFile, profileId: string): ProviderProfileMeta | undefined {
  return meta.profiles.find((profile) => profile.id === profileId);
}

function assertProviderSelector(profile: ProviderProfileMeta, selector: ProviderProfileProvider): void {
  if (isKnownProtocol(selector) && profile.protocol !== selector) {
    throw new Error(`unsupported provider: ${selector}`);
  }
  if (!isKnownProtocol(selector) && selector !== profile.id && selector !== profile.provider) {
    throw new Error('profile not found');
  }
}

export async function readProviderProfiles(projectRoot: string): Promise<ProviderProfilesView> {
  const { meta, secrets, metaPath, secretsPath, dirty } = await readRaw(projectRoot);
  if (dirty) await writeRaw(metaPath, secretsPath, meta, secrets);
  return toView(meta, secrets);
}

export async function createProviderProfile(
  projectRoot: string,
  input: CreateProviderProfileInput,
): Promise<ProviderProfileView> {
  const { meta, secrets, metaPath, secretsPath } = await readRaw(projectRoot);
  const displayName = requireDisplayName(input);
  const authType = input.authType ?? modeToAuthType(input.mode);
  const protocol = inferProtocol(input, 'anthropic');
  const providerSeed = isKnownProtocol(input.provider) ? slugify(displayName) : slugify(input.provider || displayName);
  const providerId = createUniqueProviderId(meta.profiles, providerSeed);
  const now = new Date().toISOString();
  const modelOverride = input.modelOverride?.trim();
  const profile: ProviderProfileMeta = {
    id: providerId,
    provider: providerId,
    displayName,
    authType,
    protocol,
    builtin: false,
    ...(normalizeBaseUrl(input.baseUrl) ? { baseUrl: normalizeBaseUrl(input.baseUrl) } : {}),
    models: normalizeModels(input.models, modelOverride),
    ...(modelOverride ? { modelOverride } : {}),
    createdAt: now,
    updatedAt: now,
  };

  if (profile.authType === 'api_key') {
    if (!input.apiKey?.trim()) throw new Error('apiKey is required for api_key mode');
    if (!profile.baseUrl) throw new Error('baseUrl is required for api_key mode');
    secrets.profiles[profile.id] = { apiKey: input.apiKey.trim() };
  }

  meta.profiles.push(profile);
  if (input.setActive) {
    setActiveProfile(meta, profile.protocol, profile.id);
  }
  await writeRaw(metaPath, secretsPath, meta, secrets);
  return toViewProfile(profile, secrets);
}

export async function updateProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
  input: UpdateProviderProfileInput,
): Promise<ProviderProfileView> {
  const { meta, secrets, metaPath, secretsPath } = await readRaw(projectRoot);
  const profile = findProfile(meta, profileId);
  if (!profile) throw new Error('profile not found');
  assertProviderSelector(profile, provider);

  if (typeof input.name === 'string' || typeof input.displayName === 'string') {
    profile.displayName = requireDisplayName(input);
  }

  const nextAuthType = input.authType ?? (input.mode ? modeToAuthType(input.mode) : profile.authType);
  if (profile.builtin && nextAuthType !== profile.authType) {
    throw new Error('builtin provider auth type is immutable');
  }
  profile.authType = nextAuthType;

  if (typeof input.baseUrl === 'string') {
    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    if (normalizedBaseUrl) profile.baseUrl = normalizedBaseUrl;
    else delete profile.baseUrl;
  }

  if (input.modelOverride === null || input.modelOverride === '') {
    delete profile.modelOverride;
  } else if (typeof input.modelOverride === 'string') {
    const trimmedOverride = input.modelOverride.trim();
    if (trimmedOverride) profile.modelOverride = trimmedOverride;
    else delete profile.modelOverride;
  }

  if (input.models) {
    profile.models = normalizeModels(input.models, profile.modelOverride);
  } else if (profile.modelOverride) {
    profile.models = normalizeModels(profile.models, profile.modelOverride);
  }

  profile.updatedAt = new Date().toISOString();

  if (profile.authType === 'api_key') {
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      secrets.profiles[profile.id] = { apiKey: input.apiKey.trim() };
    }
    if (!profile.baseUrl) throw new Error('baseUrl is required for api_key mode');
    if (!secrets.profiles[profile.id]?.apiKey) throw new Error('apiKey is required for api_key mode');
  } else {
    delete secrets.profiles[profile.id];
    delete profile.baseUrl;
  }

  await writeRaw(metaPath, secretsPath, meta, secrets);
  return toViewProfile(profile, secrets);
}

export async function activateProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
): Promise<void> {
  const { meta, secrets, metaPath, secretsPath } = await readRaw(projectRoot);
  const profile = findProfile(meta, profileId);
  if (!profile) throw new Error('profile not found');
  assertProviderSelector(profile, provider);
  setActiveProfile(meta, profile.protocol, profileId);
  await writeRaw(metaPath, secretsPath, meta, secrets);
}

export async function deleteProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
): Promise<void> {
  const { meta, secrets, metaPath, secretsPath } = await readRaw(projectRoot);
  const profile = findProfile(meta, profileId);
  if (!profile) throw new Error('profile not found');
  assertProviderSelector(profile, provider);
  if (profile.builtin) {
    throw new Error('builtin provider cannot be deleted');
  }
  const boundCatIds = findRuntimeCatsBoundToProfile(projectRoot, profileId);
  if (boundCatIds.length > 0) {
    throw new Error(`provider profile "${profileId}" is still referenced by runtime cats: ${boundCatIds.join(', ')}`);
  }

  meta.profiles = meta.profiles.filter((item) => item.id !== profileId);
  delete secrets.profiles[profileId];
  const activeProfileIds = ensureActiveProfileIds(meta);
  if (activeProfileIds[profile.protocol] === profileId) {
    setActiveProfile(meta, profile.protocol, findProtocolFallbackProfileId(meta, profile.protocol));
  } else {
    syncLegacyActiveProfileId(meta);
  }
  await writeRaw(metaPath, secretsPath, meta, secrets);
}

export async function getProviderProfile(
  projectRoot: string,
  provider: ProviderProfileProvider,
  profileId: string,
): Promise<ProviderProfileView | null> {
  const { meta, secrets, metaPath, secretsPath, dirty } = await readRaw(projectRoot);
  if (dirty) await writeRaw(metaPath, secretsPath, meta, secrets);
  const profile = findProfile(meta, profileId);
  if (!profile) return null;
  assertProviderSelector(profile, provider);
  return toViewProfile(profile, secrets);
}

function toRuntimeProviderProfile(
  profile: ProviderProfileMeta,
  secrets: ProviderProfilesSecretsFile,
): RuntimeProviderProfile | null {
  if (profile.authType === 'api_key') {
    const apiKey = secrets.profiles[profile.id]?.apiKey;
    if (!apiKey || !profile.baseUrl) return null;
    return {
      id: profile.id,
      protocol: profile.protocol,
      mode: 'api_key',
      baseUrl: profile.baseUrl,
      apiKey,
      ...(profile.modelOverride ? { modelOverride: profile.modelOverride } : {}),
    };
  }

  return {
    id: profile.id,
    protocol: profile.protocol,
    mode: 'subscription',
    ...(profile.modelOverride ? { modelOverride: profile.modelOverride } : {}),
  };
}

function resolveRuntimeProviderCandidate(
  meta: ProviderProfilesMetaFile,
  secrets: ProviderProfilesSecretsFile,
  protocol: ProviderProfileProtocol,
  preferredProfileId?: string,
): RuntimeProviderProfile | null {
  const activeProfileIds = ensureActiveProfileIds(meta);
  const candidates = [preferredProfileId, activeProfileIds[protocol], findProtocolFallbackProfileId(meta, protocol)].filter(
    (id): id is string => Boolean(id),
  );
  const seen = new Set<string>();
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const profile = findProfile(meta, id);
    if (!profile || profile.protocol !== protocol) continue;
    const runtime = toRuntimeProviderProfile(profile, secrets);
    if (runtime) return runtime;
  }
  return null;
}

export async function resolveRuntimeProviderProfile(
  projectRoot: string,
  protocol: ProviderProfileProtocol,
  preferredProfileId?: string,
): Promise<RuntimeProviderProfile | null> {
  const { meta, secrets, metaPath, secretsPath, dirty } = await readRaw(projectRoot);
  if (dirty) await writeRaw(metaPath, secretsPath, meta, secrets);
  return resolveRuntimeProviderCandidate(meta, secrets, protocol, preferredProfileId);
}

export async function resolveRuntimeProviderProfileById(
  projectRoot: string,
  profileId: string,
): Promise<RuntimeProviderProfile | null> {
  const { meta, secrets, metaPath, secretsPath, dirty } = await readRaw(projectRoot);
  if (dirty) await writeRaw(metaPath, secretsPath, meta, secrets);
  const profile = findProfile(meta, profileId);
  if (!profile) return null;
  return toRuntimeProviderProfile(profile, secrets);
}

export async function resolveAnthropicRuntimeProfile(projectRoot: string): Promise<AnthropicRuntimeProfile> {
  const runtime =
    (await resolveRuntimeProviderProfile(projectRoot, 'anthropic')) ??
    ({
      id: DEFAULT_CLAUDE_OAUTH_PROVIDER_ID,
      protocol: 'anthropic',
      mode: 'subscription',
    } satisfies RuntimeProviderProfile);

  return {
    id: runtime.id,
    mode: runtime.mode,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
    ...(runtime.modelOverride ? { modelOverride: runtime.modelOverride } : {}),
  };
}

export async function resolveAnthropicRuntimeProfileById(
  projectRoot: string,
  profileId: string,
): Promise<AnthropicRuntimeProfile | null> {
  const runtime = await resolveRuntimeProviderProfileById(projectRoot, profileId);
  if (!runtime || runtime.protocol !== 'anthropic') return null;
  return {
    id: runtime.id,
    mode: runtime.mode,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
    ...(runtime.modelOverride ? { modelOverride: runtime.modelOverride } : {}),
  };
}
