import type { CatData } from '@/hooks/useCatData';
import { autoSlug, type HubCatEditorFormState } from '../hub-cat-editor.model';
import { matchesRuntime, type RuntimeChoice } from '../settings/members/member-runtime-draft';
import type { NativePartner } from './native-onboarding';

function expandRoleRecommendations(runtime: RuntimeChoice): RuntimeChoice[] {
  return runtime.roleTemplates?.length
    ? runtime.roleTemplates.map((role) => ({ ...runtime, roleTemplateId: role.id, priority: role.priority }))
    : [runtime];
}

function intranetRecommendations(runtime: RuntimeChoice): RuntimeChoice[] {
  // Availability in the editor is independent of the supported default team.
  if ([runtime.harnessId, runtime.id].some((id) => id === 'codex' || id === 'pi')) return [];
  if (runtime.harnessId === 'codeagent' || /^codeagent(?::|$)/.test(runtime.id)) {
    if (runtime.roleTemplateId && runtime.roleTemplateId !== 'maine-coon') return [];
    return [{ ...runtime, roleTemplateId: 'maine-coon', priority: 100 }];
  }
  return expandRoleRecommendations(runtime);
}

/** Roles decorate a recommendation, never the ordinary tool catalog. */
export function nativeRuntimeRecommendations(
  runtimes: RuntimeChoice[],
  edition: 'intranet' | 'public' = 'public',
): RuntimeChoice[] {
  return runtimes.flatMap((runtime) => {
    if (runtime.kind === 'binding') return [];
    return edition === 'intranet' ? intranetRecommendations(runtime) : expandRoleRecommendations(runtime);
  });
}

/** Suppress new duplicate identities without changing, merging or removing persisted members. */
export function uniqueIntranetPartners(partners: NativePartner[], cats: CatData[]): NativePartner[] {
  const identity = (name: string) => name.trim().normalize('NFKC').toLowerCase();
  const seen = new Set<string>();
  return partners.filter((partner) => {
    const key = identity(partner.form.nickname || partner.form.displayName || partner.form.name);
    if (!key || seen.has(key)) return false;
    if (!partner.existingId && cats.some((cat) => identity(cat.nickname || cat.displayName) === key)) return false;
    seen.add(key);
    return true;
  });
}

/** A narrowed catalog must not erase pending configuration or its original idempotency key. */
export function parkedNativePartners(previous: NativePartner[] = [], current: NativePartner[]): NativePartner[] {
  // Old releases could assign one request key to several roles; a shared key is not identity.
  return previous.filter((old) => !current.some((partner) => partner.id === old.id));
}

export function preferredNativeBinding(
  candidate: RuntimeChoice,
  runtimes: RuntimeChoice[],
  cats: CatData[],
  form: HubCatEditorFormState,
): RuntimeChoice | undefined {
  if (!candidate.harnessId) return undefined;
  const roleId =
    candidate.roleTemplateId && candidate.harnessId === 'codeagent'
      ? `codeagent-${candidate.roleTemplateId}`
      : autoSlug(candidate.label);
  return runtimes.find(
    (binding) =>
      binding.kind === 'binding' &&
      binding.harnessId === candidate.harnessId &&
      binding.acp &&
      cats.some(
        (cat) =>
          cat.id === binding.sourceCatId &&
          cat.configurationSource === 'native_tool' &&
          (cat.nickname === form.nickname || cat.id === roleId),
      ),
  );
}

export function restoredNativeLead(partners: NativePartner[], previous: NativePartner[] = [], lead?: string): string {
  const exact = partners.find((partner) => partner.id === lead);
  if (exact) return exact.id;
  const old = previous.find((partner) => partner.id === lead);
  return (
    partners.find(
      (partner) =>
        old?.form &&
        old.runtime.roleTemplateId === partner.runtime.roleTemplateId &&
        matchesRuntime(old.form, partner.runtime),
    )?.id ??
    partners.find((partner) => partner.selected)?.id ??
    ''
  );
}
