import type { CatData } from '@/hooks/useCatData';
import type { TemplateCard } from '../../first-run-quest/TemplateStep';
import {
  autoSlug,
  type CodexRuntimeSettings,
  type HubCatEditorFormState,
  initialState,
  type StrategyFormState,
} from '../../hub-cat-editor.model';

export interface MemberDraft {
  version: 1;
  form: HubCatEditorFormState;
  baseline: CatData | null;
  templateId: string | null;
  section: string;
  strategy?: StrategyFormState | null;
  strategyBaseline?: StrategyFormState | null;
  codexSettings?: CodexRuntimeSettings;
  codexBaseline?: CodexRuntimeSettings;
}

export function changedFields(form: HubCatEditorFormState, baseline: CatData | null): number {
  const original = initialState(baseline);
  return Object.keys(form).filter((key) => {
    const field = key as keyof HubCatEditorFormState;
    return JSON.stringify(form[field]) !== JSON.stringify(original[field]);
  }).length;
}

/** Preserve only local edits; concurrent changes to untouched fields come from the server. */
export function rebaseMemberDraft(draft: MemberDraft, latest: CatData): MemberDraft {
  const before = initialState(draft.baseline);
  const form = initialState(latest);
  for (const key of Object.keys(draft.form) as (keyof HubCatEditorFormState)[]) {
    if (JSON.stringify(draft.form[key]) !== JSON.stringify(before[key])) {
      Object.assign(form, { [key]: draft.form[key] });
    }
  }
  return { ...draft, baseline: latest, form };
}

export function readMemberDraft(key: string): MemberDraft | null {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('form' in data))
      return null;
    const draft = data as MemberDraft;
    return typeof draft.form?.name === 'string' && typeof draft.form?.clientId === 'string' ? draft : null;
  } catch {
    return null;
  }
}

export function persistMemberDraft(key: string, draft: MemberDraft | null): boolean {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function templateForm(
  template: TemplateCard,
  cats: CatData[],
  current: HubCatEditorFormState,
): HubCatEditorFormState {
  const baseId = autoSlug(template.name);
  let id = baseId;
  for (let suffix = 2; cats.some((cat) => cat.id === id); suffix++) id = `${baseId}-${suffix}`;
  const used = new Set(cats.flatMap((cat) => cat.mentionPatterns.map((alias) => alias.toLowerCase())));
  let alias = `@${template.nickname || template.name}`;
  for (let suffix = 2; used.has(alias.toLowerCase()); suffix++)
    alias = `@${template.nickname || template.name}${suffix}`;
  // Templates recommend tools, never model/effort overrides or authentication.
  const recommended = /maine|缅因/i.test(template.id + template.name)
    ? 'openai'
    : /ragdoll|布偶/i.test(template.id + template.name)
      ? 'anthropic'
      : current.clientId;
  return {
    ...initialState(),
    catId: id,
    name: template.name,
    displayName: template.name,
    nickname: template.nickname ?? '',
    avatar: template.avatar,
    colorPrimary: template.color.primary,
    colorSecondary: template.color.secondary,
    roleDescription: template.roleDescription,
    personality: template.personality,
    teamStrengths: template.teamStrengths ?? '',
    mentionPatterns: alias,
    clientId: recommended,
    codexCarrier: recommended === 'openai' ? 'app_server' : '',
    defaultModel: '',
    cliEffort: '',
    accountRef: '',
  };
}
