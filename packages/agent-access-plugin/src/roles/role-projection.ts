import { type CatCafeConfig, type CatCarrier, type CatConfig, type ClientId, createCatId } from '@cat-cafe/shared';
import { projectMemberIdentitySources } from './member-identity-sources.js';

type CarrierCompatInput = {
  configurationSource?: 'native_tool' | 'managed_account';
  carrier?: CatCarrier;
  transport?: CatCarrier;
  clientId?: string;
  cli?: { carrier?: 'exec_json' | 'app_server' };
  acp?: unknown;
};

/**
 * The only compatibility boundary for member access-mode configuration.
 * Canonical carrier wins, followed by the legacy top-level transport field.
 * When neither exists, migrate the two historical runtime selectors: an ACP
 * launch block selected ACP before provider routing, while OpenAI's CLI field
 * (then the retired process env selector) selected app-server vs exec-json.
 * Every downstream projection receives only the canonical vocabulary.
 */
export function resolveCatCarrier(
  input: CarrierCompatInput,
  codexCarrierEnv = process.env.CAT_CAFE_CODEX_CARRIER,
): CatCarrier {
  if (input.carrier) return input.carrier;
  if (input.transport) return input.transport;
  if (input.clientId && input.acp != null) return 'acp';
  if (input.clientId === 'openai') {
    if (input.cli?.carrier) return input.cli.carrier === 'app_server' ? 'app_server' : 'cli';
    if (input.configurationSource === 'native_tool') return 'app_server';
    const legacy = input.cli?.carrier ?? codexCarrierEnv;
    if (legacy === 'app_server') return 'app_server';
  }
  return 'cli';
}

/**
 * F32-b: Register ALL variants as independent cats.
 * Each variant becomes a CatConfig entry keyed by its catId.
 * Default variant inherits breed-level mentionPatterns; others default to @catId when unspecified.
 * @throws Error on duplicate catId (fail-fast at startup)
 */
export function toAllCatConfigs(config: CatCafeConfig): Record<string, CatConfig> {
  const result: Record<string, CatConfig> = {};
  for (const breed of config.breeds) {
    // F32-b P4c: resolve default variant personality for non-default fallback
    const defaultVariant = breed.variants.find((v) => v.id === breed.defaultVariantId);

    for (const variant of breed.variants) {
      const isDefault = variant.id === breed.defaultVariantId;
      const catId = variant.catId ?? breed.catId;
      const fallbackMentionPatterns = isDefault ? breed.mentionPatterns : [`@${catId}`];
      const mentionPatterns =
        variant.mentionPatterns && variant.mentionPatterns.length > 0
          ? variant.mentionPatterns
          : fallbackMentionPatterns;

      // F32-b R3: catId uniqueness — duplicate is a hard error (startup failure)
      if (result[catId]) {
        throw new Error(
          `Duplicate catId "${catId}": variant "${variant.id}" in breed "${breed.id}" ` +
            `conflicts with already registered cat. Each variant must have a unique catId.`,
        );
      }

      const teamStrengths = variant.teamStrengths ?? breed.teamStrengths;
      // R1 fix: null = "explicitly no caution" (don't inherit breed).
      // undefined (omitted) = inherit from breed. ?? treats null as nullish, so use !== undefined.
      const caution = variant.caution !== undefined ? variant.caution : breed.caution;
      const nickname = variant.nickname !== undefined ? variant.nickname : breed.nickname;
      // F167 Phase E (KD-20): variant restrictions override breed (no merge);
      // undefined (omitted) inherits breed-level restrictions.
      const restrictions = variant.restrictions ?? breed.restrictions;
      const projectedCommandArgs =
        variant.commandArgs ??
        (variant.clientId === 'antigravity' && variant.cli?.defaultArgs && variant.cli.defaultArgs.length > 0
          ? variant.cli.defaultArgs
          : undefined);

      result[catId] = {
        id: createCatId(catId),
        // Identity fields normally follow a clean `variant.<field> ?? breed.<field>` chain.
        // The `variant.displayName` middle step in `name` is a LEGACY-COMPAT exception:
        // pre-clowder-ai#1090 catalogs shipped variants with `displayName` overrides but
        // no `name` field (that field was introduced by this PR), so their resolved name
        // came from `variant.displayName`. Keep this legacy branch here for read-time
        // continuity ONLY — write-time coupling is broken in `updateRuntimeCat` (which
        // snapshots the resolved name into `variant.name` before overwriting
        // `variant.displayName`). Do NOT extend this cross-field fallback to other
        // identity fields (nickname / avatar / color / role): they must stay
        // variant→breed same-field chains to prevent similar leaks.
        name: variant.name ?? variant.displayName ?? breed.name,
        displayName: variant.displayName ?? breed.displayName,
        ...(nickname != null ? { nickname } : {}),
        avatar: variant.avatar ?? breed.avatar, // F32-b P4c: variant can override
        ...(variant.banner ? { banner: variant.banner } : {}),
        color: variant.color ?? breed.color, // F32-b P4c: variant can override
        mentionPatterns,
        ...(variant.accountRef != null ? { accountRef: variant.accountRef } : {}),
        ...(variant.configurationSource ? { configurationSource: variant.configurationSource } : {}),
        ...(variant.agentProvider !== undefined ? { agentProvider: variant.agentProvider } : {}),
        ...(variant.accountBindingMode ? { accountBindingMode: variant.accountBindingMode } : {}),
        clientId: variant.clientId as ClientId, // #252: Zod now accepts any string; downstream switch/case has default branches
        carrier: resolveCatCarrier(variant as CarrierCompatInput),
        defaultModel: variant.defaultModel,
        ...(variant.executionApproval ? { executionApproval: variant.executionApproval } : {}),
        mcpSupport: variant.mcpSupport,
        ...(variant.env ? { env: { ...variant.env } } : {}),
        ...(variant.agyProfile != null ? { agyProfile: variant.agyProfile } : {}),
        ...(projectedCommandArgs != null ? { commandArgs: projectedCommandArgs } : {}),
        ...(variant.cliConfigArgs != null && variant.cliConfigArgs.length > 0
          ? { cliConfigArgs: [...variant.cliConfigArgs] }
          : {}),
        ...(variant.cli != null ? { cli: variant.cli } : {}),
        ...(variant.provider != null ? { provider: variant.provider } : {}),
        ...(variant.contextWindow != null ? { contextWindow: variant.contextWindow } : {}),
        ...(variant.voiceConfig != null ? { voiceConfig: variant.voiceConfig } : {}),
        roleDescription: variant.roleDescription ?? breed.roleDescription,
        personality: variant.personality ?? defaultVariant?.personality ?? '',
        identitySources: projectMemberIdentitySources(config, breed, variant),
        breedId: breed.id,
        relationshipKey: variant.relationshipKey ?? breed.relationshipKey ?? breed.id,
        breedDisplayName: breed.displayName,
        ...(variant.variantLabel != null ? { variantLabel: variant.variantLabel } : {}),
        isDefaultVariant: isDefault,
        ...(teamStrengths != null ? { teamStrengths } : {}),
        // R1 fix: preserve null (explicit no-caution) in CatConfig; only omit if undefined
        ...(caution !== undefined ? { caution } : {}),
        // F167 Phase E: preserve restrictions list for teammate roster + self-awareness injection
        ...(restrictions != null && restrictions.length > 0 ? { restrictions: [...restrictions] } : {}),
        ...(variant.strengths != null ? { strengths: variant.strengths } : {}),
        ...(variant.sessionChain !== undefined
          ? { sessionChain: variant.sessionChain }
          : breed.features?.sessionChain !== undefined
            ? { sessionChain: breed.features.sessionChain }
            : {}),
      };
    }
  }
  return result;
}
