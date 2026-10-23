import type { CatData } from '@/hooks/useCatData';
import { autoSlug, type HubCatEditorFormState, initialState } from '../hub-cat-editor.model';
import { matchesRuntime, type RuntimeChoice, runtimeDefaults } from '../settings/members/member-runtime-draft';
import { withLegacyNativeIdentityRepair } from './native-identity-repair';
import { usesDetectedRuntimeConfiguration } from './native-partner-config';
import { nativePartnerIdentity } from './native-partner-identity';
import {
  nativeRuntimeRecommendations,
  preferredNativeBinding,
  uniqueIntranetPartners,
} from './native-runtime-recommendations';
import { stableOnboardingMemberId } from './onboarding-journey';
import type { TemplateCard } from './TemplateStep';

export interface NativePartner {
  id: string;
  runtime: RuntimeChoice;
  form: HubCatEditorFormState;
  selected: boolean;
  /** Persisted before POST; independent of descriptor-based UI identity and member ID. */
  creationRequestKey?: string;
  /** Upgrade-only marker: several old descriptors shared this pending request key. */
  legacySharedRequestKey?: string;
  /** A missing-CLI catalog upgrade retained this pending CodeAgent role, independently of its launch descriptor. */
  retainedCodeagentRole?: string;
  existingId?: string;
  /** User-confirmed creation prepared this route; never inferred from launch arguments. */
  dshSetupPrepared?: boolean;
  dshSetupBaseline?: CatData;
  missingExisting?: boolean;
  recoverable?: { id: string; form: HubCatEditorFormState };
}

export const newNativeRequestKey = () =>
  `acp-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * A runtime can be installed while its default connection is unusable. Keep
 * those default connections visible for repair, but never preselect or submit
 * them. A different account or launch configuration has no matching login
 * evidence and must be admitted by the server using its own identity. Kimi,
 * Pi and ACP runtimes intentionally report unknown readiness because their
 * clients do not expose a safe read-only login check; their installed state is
 * still the strongest non-invasive signal available.
 */
export function nativeRuntimeSelectable(runtime: RuntimeChoice, form?: HubCatEditorFormState): boolean {
  if (!runtime.installed || (runtime.clientId === 'acp' && !runtime.acp)) return false;
  if (form && !usesDetectedRuntimeConfiguration(form, runtime)) return true;
  if (runtime.dshSetupRequired) return runtime.dshSetup?.status === 'configured';
  if (['openai', 'anthropic'].includes(runtime.clientId) && runtime.readiness) {
    return runtime.readiness.status === 'configured';
  }
  return runtime.readiness?.status !== 'login_required';
}

/** A prior uncreated custom choice is not consent to replace it with the detected default route. */
export function requiresDshDraftConfirmation(partner: NativePartner): boolean {
  return Boolean(
    !partner.existingId &&
      !partner.dshSetupPrepared &&
      partner.runtime.dshSetupRequired &&
      usesDetectedRuntimeConfiguration(partner.form, partner.runtime) &&
      (partner.form.defaultModel.trim() || partner.form.cliEffort.trim()),
  );
}

export const nativePartnerSelectable = (partner: NativePartner) =>
  !requiresDshDraftConfirmation(partner) && nativeRuntimeSelectable(partner.runtime, partner.form);

/** Registry-generated ACP ids change after creation; the launch descriptor does not. */
function partnerKey(runtime: RuntimeChoice): string {
  if (!runtime.acp) return runtime.id;
  const descriptor = JSON.stringify([runtime.acp.command, runtime.acp.startupArgs, runtime.acp.transport ?? 'stdio']);
  let hash = 2166136261;
  for (const char of descriptor) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `acp-${(hash >>> 0).toString(16)}`;
}

export function recommendNativePartners(
  runtimes: RuntimeChoice[],
  templates: TemplateCard[],
  cats: CatData[],
  journeyId: string,
  edition: 'intranet' | 'public' = 'public',
): NativePartner[] {
  const recommendations = nativeRuntimeRecommendations(runtimes, edition);
  const seen = new Set<string>();
  const reservedIds = new Set(cats.map((cat) => cat.id.toLowerCase()));
  const reservedAliases = new Set(cats.flatMap((cat) => cat.mentionPatterns.map((alias) => alias.toLowerCase())));
  const prioritizedRoles = new Set(
    recommendations
      .filter((runtime) => runtime.installed && runtime.priority && runtime.roleTemplateId)
      .map((runtime) => runtime.roleTemplateId),
  );
  const partners = recommendations
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .flatMap((candidate) => {
      const form = nativePartnerIdentity(candidate, templates, cats);
      const existingBinding = preferredNativeBinding(candidate, runtimes, cats, form);
      const runtime = existingBinding
        ? {
            ...candidate,
            acp: existingBinding.acp,
            installed: existingBinding.installed,
            discoveryStatus: existingBinding.discoveryStatus,
            dshSetupRequired: existingBinding.dshSetupRequired,
            dshSetup: existingBinding.dshSetup,
            dshSetupRuntimeId: existingBinding.dshSetupRuntimeId ?? existingBinding.id,
            models: existingBinding.models,
          }
        : candidate;
      // Keep existing/manual OpenCode members, but do not recommend new ones during the compatibility pause.
      if (runtime.clientId === 'opencode') return [];
      const descriptor = JSON.stringify([
        runtime.clientId,
        runtime.acp?.command,
        runtime.acp?.startupArgs,
        runtime.acp?.transport ?? 'stdio',
      ]);
      // Full descriptor equality prevents short-hash collisions in the local partner index.
      const roleKey = runtime.roleTemplateId ? `:${runtime.roleTemplateId}` : '';
      const key = (runtime.acp ? `acp:${encodeURIComponent(descriptor)}` : runtime.id) + roleKey;
      const discoveryIdentity = (runtime.acp ? descriptor : runtime.id) + roleKey;
      if (seen.has(discoveryIdentity)) return [];
      seen.add(discoveryIdentity);
      if (!form.name) form.name = form.displayName = `${runtime.label} 伙伴`;
      const alias = runtime.roleTemplateId
        ? `@${form.nickname || form.name}`
        : `@${runtime.label.replace(/\s+/g, '-').toLowerCase()}`;
      let uniqueAlias = alias;
      for (let n = 2; reservedAliases.has(uniqueAlias); n++) uniqueAlias = `${alias}-${n}`;
      reservedAliases.add(uniqueAlias);
      const legacyId = stableOnboardingMemberId(journeyId, 'partner', partnerKey(runtime));
      const existing = cats.find(
        (cat) =>
          (cat.id === legacyId || cat.configurationSource === 'native_tool') &&
          matchesRuntime(initialState(cat), runtime) &&
          (!runtime.roleTemplateId || cat.id === existingBinding?.sourceCatId || cat.nickname === form.nickname),
      );
      const codeagentRole =
        runtime.roleTemplateId && (runtime.harnessId === 'codeagent' || runtime.id.startsWith('codeagent:'));
      const baseId = codeagentRole ? `codeagent-${runtime.roleTemplateId}` : autoSlug(runtime.label);
      let catId = baseId;
      for (let n = 2; reservedIds.has(catId.toLowerCase()); n++) {
        const suffix = `-${n}`;
        catId = `${baseId.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
      }
      reservedIds.add(catId.toLowerCase());
      const existingForm = existing ? initialState(existing) : undefined;
      const persistedForm = existingForm ? withLegacyNativeIdentityRepair(existingForm, form, runtime) : undefined;
      return [
        {
          id: key,
          creationRequestKey: runtime.acp ? newNativeRequestKey() : key,
          runtime,
          form: persistedForm
            ? persistedForm
            : { ...form, ...runtimeDefaults(runtime), catId, mentionPatterns: uniqueAlias },
          selected:
            nativeRuntimeSelectable(runtime, persistedForm) &&
            (Boolean(existing) ||
              Boolean(runtime.priority) ||
              !prioritizedRoles.has(
                ({ anthropic: 'ragdoll', openai: 'maine-coon', kimi: 'turkish-van' } as Record<string, string>)[
                  runtime.clientId
                ],
              )) &&
            (!runtime.roleTemplateId || Boolean(existing) || !cats.some((cat) => cat.nickname === form.nickname)),
          ...(existing ? { existingId: existing.id } : {}),
          ...(existing && runtime.dshSetupRequired ? { dshSetupBaseline: structuredClone(existing) } : {}),
        },
      ];
    });
  return edition === 'intranet' ? uniqueIntranetPartners(partners, cats) : partners;
}

export const SMALL_GOALS = [
  {
    title: '把想法变成行动',
    content: '我想做一个简单的个人待办清单。请帮我梳理最小可用版本，并给出今天就能完成的 3 个步骤。先不要修改文件。',
  },
  {
    title: '整理一段文字',
    content:
      '请把这段想法整理为清晰的待办：我想把零散的阅读笔记归档，每周选一篇写摘要，周末回顾。请给出分类建议和本周的 3 个行动项。',
  },
  { title: '写自己的目标', content: '' },
] as const;
