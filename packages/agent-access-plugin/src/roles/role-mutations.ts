import type { CatBreed, CatCafeConfig, CatCarrier, CatVariant, CliConfig } from '@cat-cafe/shared';
import { backgroundImageUrlSchema, createCatId } from '@cat-cafe/shared';
import type { AcpVariantConfig, RuntimeCatInput, RuntimeCatUpdate } from '@clowder-ai/agent-contract';
import { readLocalAccountSelection } from './local-account-selection.js';
import { toAllCatConfigs } from './role-projection.js';
import { addTemplateVariantTombstone, type TemplateVariantTombstoneInput } from './template-variant-tombstones.js';

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type StoredVariant = Omit<Writable<CatVariant>, 'cli'> & {
  cli?: Writable<CliConfig> & { carrier?: 'exec_json' | 'app_server' };
  transport?: CatCarrier;
  acp?: AcpVariantConfig | null;
};
type StoredBreed = Omit<Writable<CatBreed>, 'variants'> & { variants: StoredVariant[] };
type StoredCatalog<T = CatCafeConfig> = T extends CatCafeConfig
  ? Omit<Writable<T>, 'breeds'> & { breeds: StoredBreed[] }
  : never;

function editableCatalog(current: CatCafeConfig): StoredCatalog {
  return structuredClone(current) as StoredCatalog;
}

interface BreedVariantLocation {
  breedIndex: number;
  variantIndex: number;
  breed: StoredBreed;
  variant: StoredVariant;
  resolvedCatId: string;
  isDefaultVariant: boolean;
}

function normalizeMentionPatterns(_catId: string, mentionPatterns: readonly string[]): string[] {
  const values = mentionPatterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => (pattern.startsWith('@') ? pattern : `@${pattern}`));
  return Array.from(new Set(values));
}

function normalizeRestrictions(restrictions: readonly string[]): string[] {
  return Array.from(new Set(restrictions.map((item) => item.trim()).filter((item) => item.length > 0)));
}

function findBreedVariant(catalog: StoredCatalog, catId: string): BreedVariantLocation | null {
  for (const [breedIndex, breed] of catalog.breeds.entries()) {
    for (const [variantIndex, variant] of breed.variants.entries()) {
      const resolvedCatId = variant.catId ?? breed.catId;
      if (resolvedCatId !== catId) continue;
      return {
        breedIndex,
        variantIndex,
        breed,
        variant,
        resolvedCatId,
        isDefaultVariant: variant.id === breed.defaultVariantId,
      };
    }
  }
  return null;
}

function createBreedFromInput(input: RuntimeCatInput): StoredBreed {
  const variantId = `${input.catId}-default`;
  return {
    id: input.breedId?.trim() || input.catId,
    catId: createCatId(input.catId),
    name: input.name,
    displayName: input.displayName,
    ...(input.nickname != null && input.nickname.trim().length > 0 ? { nickname: input.nickname.trim() } : {}),
    avatar: input.avatar,
    color: input.color,
    mentionPatterns: normalizeMentionPatterns(input.catId, input.mentionPatterns),
    roleDescription: input.roleDescription,
    defaultVariantId: variantId,
    ...(input.sessionChain !== undefined ? { features: { sessionChain: input.sessionChain } } : {}),
    variants: [
      {
        id: variantId,
        ...(input.banner ? { banner: input.banner } : {}),
        clientId: input.clientId,
        ...(input.creationReceipt ? { creationReceipt: input.creationReceipt } : {}),
        ...(input.configurationSource ? { configurationSource: input.configurationSource } : {}),
        ...(input.agentProvider !== undefined ? { agentProvider: input.agentProvider } : {}),
        carrier: input.carrier,
        ...(input.variantLabel != null && input.variantLabel.trim().length > 0
          ? { variantLabel: input.variantLabel.trim() }
          : {}),
        defaultModel: input.defaultModel,
        ...(input.executionApproval ? { executionApproval: input.executionApproval } : {}),
        mcpSupport: input.mcpSupport,
        ...(input.env ? { env: { ...input.env } } : {}),
        // F247 KD-17: omit cli for cloud-only cats (Remote MCP, no local dispatch).
        ...(input.cli ? { cli: input.cli } : {}),
        ...(input.accountRef != null && input.accountRef.trim().length > 0
          ? { accountRef: input.accountRef.trim() }
          : {}),
        ...(input.commandArgs && input.commandArgs.length > 0 ? { commandArgs: input.commandArgs } : {}),
        ...(input.cliConfigArgs && input.cliConfigArgs.length > 0 ? { cliConfigArgs: input.cliConfigArgs } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.contextWindow != null ? { contextWindow: input.contextWindow } : {}),
        ...(input.voiceConfig !== undefined ? { voiceConfig: input.voiceConfig } : {}),
        ...(input.personality != null && input.personality.trim().length > 0 ? { personality: input.personality } : {}),
        ...(input.teamStrengths != null && input.teamStrengths.trim().length > 0
          ? { teamStrengths: input.teamStrengths.trim() }
          : {}),
        ...(input.caution !== undefined
          ? { caution: input.caution && input.caution.trim().length > 0 ? input.caution.trim() : null }
          : {}),
        ...(input.restrictions !== undefined ? { restrictions: normalizeRestrictions(input.restrictions) } : {}),
        ...(input.strengths ? { strengths: input.strengths } : {}),
        ...(input.acp ? { acp: input.acp } : {}),
        ...(input.agyProfile ? { agyProfile: input.agyProfile } : {}),
      },
    ],
  };
}

function buildDefaultRuntimeRosterEntry(
  catId: string,
  family: string,
  displayName: string,
  available: boolean,
): { family: string; roles: string[]; lead: false; available: boolean; evaluation: string } {
  return {
    family,
    roles: ['assistant'],
    lead: false,
    available,
    evaluation: `${displayName} runtime member`,
  };
}

export function planRoleCreation(readCurrent: () => CatCafeConfig, input: RuntimeCatInput): CatCafeConfig {
  if (input.banner !== undefined) backgroundImageUrlSchema.parse(input.banner);
  const catalog = editableCatalog(readCurrent());
  if (findBreedVariant(catalog, input.catId)) {
    throw new Error(`Cat "${input.catId}" already exists in runtime catalog`);
  }
  const nextBreed = createBreedFromInput(input);
  const targetBreedId = input.breedId?.trim();
  if (targetBreedId && targetBreedId !== input.catId) {
    const targetBreed = catalog.breeds.find((breed: { id: string }) => breed.id === targetBreedId);
    if (!targetBreed) throw new Error(`Unknown breedId "${targetBreedId}"; choose an existing breed`);
    const variant = nextBreed.variants[0];
    if (targetBreed.variants.some((member: { id: string }) => member.id === variant.id)) {
      throw new Error(`Variant "${variant.id}" already exists in breed "${targetBreedId}"`);
    }
    targetBreed.variants.push({
      ...variant,
      catId: input.catId,
      relationshipKey: input.catId,
      name: input.name,
      displayName: input.displayName,
      nickname: input.nickname?.trim() || null,
      avatar: input.avatar,
      color: input.color,
      mentionPatterns: normalizeMentionPatterns(input.catId, input.mentionPatterns),
      roleDescription: input.roleDescription,
      ...(input.sessionChain !== undefined ? { sessionChain: input.sessionChain } : {}),
    });
  } else {
    if (catalog.breeds.some((breed: { id: string }) => breed.id === nextBreed.id)) {
      throw new Error(`Breed "${nextBreed.id}" already exists in runtime catalog`);
    }
    catalog.breeds = [...catalog.breeds, nextBreed];
  }
  if (catalog.version === 2) {
    catalog.roster = {
      ...catalog.roster,
      [input.catId]: buildDefaultRuntimeRosterEntry(input.catId, targetBreedId || input.catId, input.displayName, true),
    };
  }
  return catalog as CatCafeConfig;
}

export function planRoleUpdate(readCurrent: () => CatCafeConfig, catId: string, patch: RuntimeCatUpdate) {
  if (patch.banner != null) backgroundImageUrlSchema.parse(patch.banner);
  const catalog = editableCatalog(readCurrent());
  const previous = {
    cat: toAllCatConfigs(catalog as CatCafeConfig)[catId],
    available: catalog.version !== 2 || catalog.roster[catId]?.available !== false,
  };
  const located = findBreedVariant(catalog, catId);
  if (!located) {
    throw new Error(`Cat "${catId}" not found in runtime catalog`);
  }

  const breed = catalog.breeds[located.breedIndex];
  const variant = breed.variants[located.variantIndex];
  const shouldWriteBreedIdentity = located.isDefaultVariant && breed.variants.length === 1;
  const bindingClient = (patch.clientId ?? variant.clientId) === 'anthropic' ? 'anthropic' : 'openai';
  const selectedAccountRef = readLocalAccountSelection(catalog as CatCafeConfig, bindingClient).accountRef;

  if (patch.name !== undefined) {
    if (shouldWriteBreedIdentity) {
      breed.name = patch.name;
      delete variant.name;
    } else {
      variant.name = patch.name;
    }
  }
  if (patch.nickname !== undefined) {
    const nickname = patch.nickname.trim();
    if (shouldWriteBreedIdentity) {
      if (nickname.length > 0) {
        breed.nickname = nickname;
      } else {
        delete breed.nickname;
      }
      delete variant.nickname;
    } else if (nickname.length > 0) {
      variant.nickname = nickname;
    } else {
      variant.nickname = null;
    }
  }
  if (patch.roleDescription !== undefined) variant.roleDescription = patch.roleDescription;

  if (patch.displayName !== undefined) {
    if (shouldWriteBreedIdentity) {
      breed.displayName = patch.displayName;
      delete variant.displayName;
    } else {
      // Multi-variant breed: keep name/displayName editing independent.
      // toAllCatConfigs resolves `name` as `variant.name ?? variant.displayName ?? breed.name`;
      // if we overwrite variant.displayName without a variant.name override,
      // the resolved name silently follows the new displayName (P2 finding on
      // clowder-ai#1090). Snapshot the currently-resolved name into variant.name
      // so a displayName-only patch cannot alter this member's resolved name.
      // Legacy variants that inherited name via variant.displayName fallback
      // keep that name explicitly on their first displayName edit.
      if (variant.name === undefined) {
        variant.name = variant.displayName ?? breed.name;
      }
      variant.displayName = patch.displayName;
    }
  }

  if (patch.variantLabel !== undefined) {
    if (patch.variantLabel && patch.variantLabel.trim().length > 0) {
      variant.variantLabel = patch.variantLabel.trim();
    } else {
      delete variant.variantLabel;
    }
  }

  if (patch.avatar !== undefined) {
    if (located.isDefaultVariant) {
      breed.avatar = patch.avatar;
      delete variant.avatar;
    } else {
      variant.avatar = patch.avatar;
    }
  }

  if (patch.banner !== undefined) {
    // Null is a durable removal, including a value inherited from the shipped template.
    variant.banner = patch.banner;
  }

  if (patch.color !== undefined) {
    if (located.isDefaultVariant) {
      breed.color = patch.color;
      delete variant.color;
    } else {
      variant.color = patch.color;
    }
  }

  if (patch.mentionPatterns !== undefined) {
    const normalized = normalizeMentionPatterns(catId, patch.mentionPatterns);
    if (located.isDefaultVariant) {
      breed.mentionPatterns = normalized;
      delete variant.mentionPatterns;
    } else {
      variant.mentionPatterns = normalized;
    }
  }

  if (patch.configurationSource !== undefined) {
    if (patch.configurationSource) variant.configurationSource = patch.configurationSource;
    else delete variant.configurationSource;
  }
  if (patch.agentProvider !== undefined) variant.agentProvider = patch.agentProvider;
  if (patch.personality !== undefined) {
    if (patch.personality && patch.personality.trim().length > 0) {
      variant.personality = patch.personality;
    } else {
      delete variant.personality;
    }
  }
  if (patch.teamStrengths !== undefined) {
    if (patch.teamStrengths && patch.teamStrengths.trim().length > 0) {
      variant.teamStrengths = patch.teamStrengths.trim();
    } else {
      delete variant.teamStrengths;
    }
  }
  if (patch.caution !== undefined) {
    variant.caution = patch.caution && patch.caution.trim().length > 0 ? patch.caution.trim() : null;
  }
  if (patch.restrictions !== undefined) {
    if (patch.restrictions === null) {
      delete variant.restrictions;
    } else {
      variant.restrictions = normalizeRestrictions(patch.restrictions);
    }
  }
  if (patch.strengths !== undefined) {
    if (patch.strengths.length > 0) {
      variant.strengths = patch.strengths;
    } else {
      delete variant.strengths;
    }
  }
  if (patch.sessionChain !== undefined) variant.sessionChain = patch.sessionChain;
  if (patch.clientId !== undefined) {
    if (patch.clientId !== variant.clientId) delete variant.accountBindingMode;
    variant.clientId = patch.clientId;
  }
  if (patch.carrier !== undefined) {
    variant.carrier = patch.carrier;
    // Access-mode compatibility exists only at read time. Any write converges
    // the catalog to the canonical top-level field.
    delete variant.transport;
    if (variant.cli && typeof variant.cli === 'object') delete variant.cli.carrier;
  }
  if (patch.defaultModel !== undefined) variant.defaultModel = patch.defaultModel;
  if (patch.executionApproval !== undefined) variant.executionApproval = patch.executionApproval;
  if (patch.mcpSupport !== undefined) variant.mcpSupport = patch.mcpSupport;
  if (patch.env !== undefined) {
    if (patch.env === null) delete variant.env;
    else variant.env = { ...patch.env };
  }
  // F247 KD-17: patch.cli === null means remove (cloud-only mode); object means update.
  if (patch.cli !== undefined) {
    if (patch.cli === null) {
      delete variant.cli;
    } else {
      variant.cli = patch.cli;
    }
  }
  if (!['openai', 'anthropic'].includes(variant.clientId) || !variant.cli || catId === 'gpt-pro')
    delete variant.accountBindingMode;
  if (patch.accountRef !== undefined) {
    if (patch.accountRef && patch.accountRef.trim().length > 0) {
      variant.accountRef = patch.accountRef.trim();
      if (['openai', 'anthropic'].includes(variant.clientId) && variant.cli && catId !== 'gpt-pro')
        variant.accountBindingMode = selectedAccountRef === variant.accountRef ? 'follow' : 'override';
    } else {
      delete variant.accountRef;
      delete variant.accountBindingMode;
    }
  }
  if (patch.accountBindingMode !== undefined) {
    if (!['openai', 'anthropic'].includes(variant.clientId) || !variant.cli || catId === 'gpt-pro')
      throw new Error('跟随账号仅适用于本地 Codex / Claude');
    const selected = selectedAccountRef;
    if (patch.accountBindingMode === 'follow') {
      if (
        !selected ||
        (patch.accountRef ?? variant.accountRef ?? (bindingClient === 'anthropic' ? 'claude' : 'codex')) !== selected
      )
        throw new Error('请先在账号页选定正在用的账号，再恢复跟随');
      catalog.selectedAccountRefs = { ...catalog.selectedAccountRefs, [bindingClient]: selected };
      variant.accountRef = selected;
    }
    variant.accountBindingMode =
      (patch.accountRef ?? variant.accountRef ?? (bindingClient === 'anthropic' ? 'claude' : 'codex')) === selected
        ? 'follow'
        : patch.accountBindingMode;
  }
  if (
    patch.available === true &&
    patch.accountRef === undefined &&
    patch.accountBindingMode === undefined &&
    variant.accountBindingMode === 'follow' &&
    ['openai', 'anthropic'].includes(variant.clientId) &&
    variant.cli &&
    catId !== 'gpt-pro' &&
    selectedAccountRef
  )
    variant.accountRef = selectedAccountRef;
  if (patch.contextWindow !== undefined) {
    if (patch.contextWindow != null) {
      variant.contextWindow = patch.contextWindow;
    } else {
      delete variant.contextWindow;
    }
  }
  if (patch.voiceConfig !== undefined) {
    if (patch.voiceConfig) {
      variant.voiceConfig = patch.voiceConfig;
    } else {
      delete variant.voiceConfig;
    }
  }
  if (patch.commandArgs !== undefined) {
    if (patch.commandArgs.length > 0) {
      variant.commandArgs = patch.commandArgs;
    } else {
      delete variant.commandArgs;
    }
  }
  if (patch.cliConfigArgs !== undefined) {
    if (patch.cliConfigArgs.length > 0) {
      variant.cliConfigArgs = patch.cliConfigArgs;
    } else {
      delete variant.cliConfigArgs;
    }
  }
  if (patch.provider !== undefined) {
    if (patch.provider) {
      variant.provider = patch.provider;
    } else {
      delete variant.provider;
    }
  }
  // F161: ACP transport config — null removes it (revert to CLI transport).
  if (patch.agyProfile !== undefined) variant.agyProfile = patch.agyProfile;
  if (patch.acp !== undefined) {
    if (patch.acp) {
      variant.acp = patch.acp;
    } else {
      variant.acp = null;
    }
  }
  if (patch.available !== undefined && catalog.version === 2) {
    const existingEntry = catalog.roster[catId];
    catalog.roster = {
      ...catalog.roster,
      [catId]: existingEntry
        ? { ...existingEntry, available: patch.available }
        : buildDefaultRuntimeRosterEntry(
            catId,
            String(breed.id ?? catId),
            String(breed.displayName ?? breed.name ?? catId),
            patch.available,
          ),
    };
  }

  if (patch.breedId !== undefined && patch.breedId !== breed.id) {
    const targetBreed = catalog.breeds.find((candidate: { id: string }) => candidate.id === patch.breedId);
    if (!targetBreed) throw new Error(`Unknown breedId "${patch.breedId}"; choose an existing breed`);
    if (located.isDefaultVariant && breed.variants.length > 1) {
      throw new Error(`Cannot move default member "${catId}" from a multi-member breed`);
    }
    if (targetBreed.variants.some((member: { id: string }) => member.id === variant.id)) {
      throw new Error(`Variant "${variant.id}" already exists in breed "${patch.breedId}"`);
    }

    // A standalone cat stores its identity at breed level. Snapshot the resolved
    // member before moving so target-breed defaults cannot silently rename it or
    // replace its avatar, aliases, role, or session behavior.
    const resolved = toAllCatConfigs(catalog as CatCafeConfig)[catId];
    if (!resolved.relationshipKey) {
      throw new Error(`Cat "${catId}" has no relationshipKey; refusing breed move`);
    }
    const movingVariant = {
      ...variant,
      catId,
      relationshipKey: resolved.relationshipKey,
      name: resolved.name,
      displayName: resolved.displayName,
      nickname: resolved.nickname ?? null,
      avatar: resolved.avatar,
      color: resolved.color,
      mentionPatterns: [...resolved.mentionPatterns],
      roleDescription: resolved.roleDescription,
      personality: resolved.personality,
      teamStrengths: resolved.teamStrengths ?? '',
      caution: resolved.caution ?? null,
      restrictions: resolved.restrictions ?? [],
      sessionChain: resolved.sessionChain ?? true,
      ...((variant.sessionStrategy ?? breed.features?.sessionStrategy)
        ? { sessionStrategy: variant.sessionStrategy ?? breed.features?.sessionStrategy }
        : {}),
    };
    breed.variants.splice(located.variantIndex, 1);
    if (breed.variants.length === 0) {
      catalog.breeds.splice(located.breedIndex, 1);
    }
    targetBreed.variants.push(movingVariant);
    if (catalog.version === 2) {
      const existingEntry = catalog.roster[catId];
      catalog.roster[catId] = existingEntry
        ? { ...existingEntry, family: patch.breedId }
        : buildDefaultRuntimeRosterEntry(catId, patch.breedId, resolved.displayName, true);
    }
  }

  return { catalog: catalog as CatCafeConfig, previous };
}

export function planRoleDeletion(
  current: CatCafeConfig,
  catId: string,
  templateVariantTombstoneInput: TemplateVariantTombstoneInput | null,
): CatCafeConfig {
  const catalog = editableCatalog(current);
  const located = findBreedVariant(catalog, catId);
  if (!located) {
    throw new Error(`Cat "${catId}" not found in runtime catalog`);
  }

  const breed = catalog.breeds[located.breedIndex];
  if (breed.variants.length === 1) {
    catalog.breeds = catalog.breeds.filter((_: unknown, index: number) => index !== located.breedIndex);
  } else {
    breed.variants = breed.variants.filter((_: unknown, index: number) => index !== located.variantIndex);
    if (located.isDefaultVariant) {
      breed.defaultVariantId = breed.variants[0]?.id ?? breed.defaultVariantId;
    }
  }

  if (catalog.version === 2 && catId in catalog.roster) {
    const nextRoster = { ...catalog.roster };
    delete nextRoster[catId];
    catalog.roster = nextRoster;
  }

  if (templateVariantTombstoneInput) {
    addTemplateVariantTombstone(catalog as Record<string, unknown>, templateVariantTombstoneInput);
  }

  return catalog as CatCafeConfig;
}
export type { RuntimeCatInput, RuntimeCatUpdate };

export function assertUniqueMentionAliases(catalog: CatCafeConfig): void {
  const aliasHolders = new Map<string, string>();
  for (const [catId, config] of Object.entries(toAllCatConfigs(catalog))) {
    for (const mentionPattern of config.mentionPatterns) {
      const trimmed = mentionPattern.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const holder = aliasHolders.get(key);
      if (holder && holder !== catId) {
        throw new Error(`mention alias "${trimmed}" is already used by cat "${holder}"`);
      }
      aliasHolders.set(key, catId);
    }
  }

  const coCreatorMentionPatterns = catalog.version === 2 ? (catalog.coCreator?.mentionPatterns ?? []) : [];
  for (const mentionPattern of coCreatorMentionPatterns) {
    const trimmed = mentionPattern.trim();
    if (!trimmed) continue;
    const holder = aliasHolders.get(trimmed.toLowerCase());
    if (holder) {
      throw new Error(`co-creator mention alias "${trimmed}" conflicts with cat "${holder}"`);
    }
  }
}
