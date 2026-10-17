import type { CatData } from '@/hooks/useCatData';
import { autoSlug, type HubCatEditorFormState, initialState } from '../hub-cat-editor.model';
import { matchesRuntime, type RuntimeChoice, runtimeDefaults } from '../settings/members/member-runtime-draft';
import { nativePartnerIdentity } from './native-partner-identity';
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
  existingId?: string;
  missingExisting?: boolean;
  recoverable?: { id: string; form: HubCatEditorFormState };
}

export const newNativeRequestKey = () =>
  `acp-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

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
): NativePartner[] {
  const seen = new Set<string>();
  const reservedIds = new Set(cats.map((cat) => cat.id.toLowerCase()));
  const reservedAliases = new Set(cats.flatMap((cat) => cat.mentionPatterns.map((alias) => alias.toLowerCase())));
  return runtimes.flatMap((runtime) => {
    // Keep existing/manual OpenCode members, but do not recommend new ones during the compatibility pause.
    if (runtime.clientId === 'opencode') return [];
    const descriptor = JSON.stringify([
      runtime.clientId,
      runtime.acp?.command,
      runtime.acp?.startupArgs,
      runtime.acp?.transport ?? 'stdio',
    ]);
    // Full descriptor equality prevents short-hash collisions in the local partner index.
    const key = runtime.acp ? `acp:${encodeURIComponent(descriptor)}` : runtime.id;
    const discoveryIdentity = runtime.acp ? descriptor : runtime.id;
    if (seen.has(discoveryIdentity)) return [];
    seen.add(discoveryIdentity);
    const form = nativePartnerIdentity(runtime, templates, cats);
    if (!form.name) form.name = form.displayName = `${runtime.label} 伙伴`;
    const alias = `@${runtime.label.replace(/\s+/g, '-').toLowerCase()}`;
    let uniqueAlias = alias;
    for (let n = 2; reservedAliases.has(uniqueAlias); n++) uniqueAlias = `${alias}-${n}`;
    reservedAliases.add(uniqueAlias);
    const legacyId = stableOnboardingMemberId(journeyId, 'partner', partnerKey(runtime));
    const existing = cats.find(
      (cat) =>
        (cat.id === legacyId || cat.configurationSource === 'native_tool') &&
        matchesRuntime(initialState(cat), runtime),
    );
    const baseId = autoSlug(runtime.label);
    let catId = baseId;
    for (let n = 2; reservedIds.has(catId.toLowerCase()); n++) {
      const suffix = `-${n}`;
      catId = `${baseId.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    }
    reservedIds.add(catId.toLowerCase());
    const existingForm = existing ? initialState(existing) : undefined;
    const persistedForm = existingForm
      ? {
          ...existingForm,
          // Older native creations could be persisted before the role asset
          // was included in the response. Fill only missing identity fields;
          // never overwrite a user's custom name, nickname, or role text.
          avatar: existingForm.avatar.trim() || form.avatar,
          nickname: existingForm.nickname.trim() || form.nickname,
        }
      : undefined;
    return [
      {
        id: key,
        creationRequestKey: runtime.acp ? newNativeRequestKey() : key,
        runtime,
        form: persistedForm
          ? persistedForm
          : { ...form, ...runtimeDefaults(runtime), catId, mentionPatterns: uniqueAlias },
        selected: runtime.installed && (runtime.clientId !== 'acp' || Boolean(runtime.acp)),
        ...(existing ? { existingId: existing.id } : {}),
      },
    ];
  });
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
