'use client';

import { BUILTIN_GPT_PRO_CANONICAL_MENTION, resolveMemberIdentity } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import {
  autoSlug,
  type HubCatEditorFormState,
  initialState,
  normalizeMentionPattern,
  splitMentionPatterns,
} from '../../hub-cat-editor.model';
import { TextAreaField, TextField } from '../../hub-cat-editor-fields';
import { TagEditor } from '../../hub-tag-editor';
import { MemberChangeMark, MemberChanges } from '../../members/MemberChangeMark';
import { HelpTip } from '../HelpTip';
import { MemberRosterField } from './MemberRosterField';
import type { MemberText } from './MemberRuntimeFields';

type Props = {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  patch: (change: Partial<HubCatEditorFormState>) => void;
  t: MemberText;
  editing: boolean;
};
const fields = [
  ['displayName', '名字', 'Name'],
  ['nickname', '昵称', 'Nickname'],
  ['variantLabel', '版本备注', 'Version label'],
  ['mentionPatterns', '@ 名字', '@ names'],
  ['roleDescription', '职责', 'Role'],
  ['personality', '个性', 'Personality'],
  ['teamStrengths', '团队分工', 'Team contribution'],
  ['caution', '限制与注意事项', 'Limitations'],
] as const;
/** One form for settings and the chat profile card's settings action. */
export function MemberIdentityFields({ cat, form, patch, t, editing }: Props) {
  const baseline = initialState(cat);
  const profile = cat?.identityProfile ?? undefined;
  const identity = resolveMemberIdentity(cat ?? baseline, profile, form);
  const changes = editing
    ? fields
        .filter(([key]) => form[key] !== baseline[key])
        .map(([key, zh, en]) => ({ key, label: t(zh, en), fieldLabels: [t(zh, en)] }))
    : [];
  const aliases = splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean);
  const lockedAliases = cat?.identityProtection
    ? aliases.filter((alias) => alias === BUILTIN_GPT_PRO_CANONICAL_MENTION)
    : [];
  const changeAliases = (values: string[]) =>
    patch({ mentionPatterns: [...new Set([...lockedAliases, ...values])].join(', ') });
  const profileHref = `/settings?s=profiles#profile-${encodeURIComponent(form.catId)}`;
  const defaultHint = (field: 'displayName' | 'nickname' | 'roleDescription' | 'personality') =>
    identity.sources.fields !== 'configured' && identity.sources.fields[field] === 'template'
      ? t('默认', 'Default')
      : undefined;
  const group = (zh: string, en: string, helpZh: string, helpEn: string) => (
    <div className="flex items-center gap-1.5 border-t border-[var(--console-border-soft)] pt-[18px]">
      <h3 className="text-sm font-semibold">{t(zh, en)}</h3>
      <HelpTip topic={t(zh, en)}>{t(helpZh, helpEn)}</HelpTip>
    </div>
  );
  return (
    <MemberChanges.Provider value={changes}>
      <div className="space-y-4" data-member-identity-fields>
        <TextField
          label={t('名字', 'Name')}
          labelHint={defaultHint('displayName')}
          value={form.displayName}
          onChange={(name) => {
            const id = autoSlug(name, form.catId);
            patch({
              name,
              displayName: name,
              ...(!editing
                ? {
                    catId: id,
                    ...(!form.mentionPatterns || form.mentionPatterns === `@${form.catId}`
                      ? { mentionPatterns: `@${id}` }
                      : {}),
                  }
                : {}),
            });
          }}
        />
        <TextField
          label={t('昵称', 'Nickname')}
          value={form.nickname}
          labelHint={defaultHint('nickname')}
          onChange={(nickname) => patch({ nickname })}
        />
        <TextField
          label={t('版本备注', 'Version label')}
          value={form.variantLabel}
          onChange={(variantLabel) => patch({ variantLabel })}
        />
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {t('@ 名字', '@ names')}
            <MemberChangeMark label={t('@ 名字', '@ names')} />
          </p>
          <TagEditor
            tags={aliases}
            lockedTags={lockedAliases}
            minCount={lockedAliases.length ? 0 : 1}
            onChange={changeAliases}
            addLabel={t('添加', 'Add')}
            placeholder={t('@名字', '@name')}
            emptyLabel={t('尚未添加', 'None added')}
          />
        </div>
        {group('人设', 'Persona', '写进这只猫自己的提示词', "Goes into this cat's own prompt")}
        <TextAreaField
          label={t('职责', 'Role')}
          value={form.roleDescription}
          labelHint={defaultHint('roleDescription')}
          onChange={(roleDescription) => patch({ roleDescription })}
        />
        <TextAreaField
          label={t('个性', 'Personality')}
          value={form.personality}
          labelHint={defaultHint('personality')}
          onChange={(personality) => patch({ personality })}
        />
        {group(
          '名册',
          'Roster',
          '供其他猫派活时参考。限制进入所有名册；团队分工只在部分接入方式的名册中展示，长句会节选。',
          'Other cats use this when assigning work. Every roster includes limitations; some connection types also show team contribution. Long text may be shortened.',
        )}
        <MemberRosterField
          label={t('团队分工', 'Team contribution')}
          field={identity.rosterFields.teamStrengths}
          profileHref={profileHref}
          hasProfile={Boolean(profile)}
          t={t}
          onChange={(teamStrengths) => patch({ teamStrengths })}
        />
        <MemberRosterField
          label={t('限制与注意事项', 'Limitations')}
          field={identity.rosterFields.caution}
          profileHref={profileHref}
          hasProfile={Boolean(profile)}
          t={t}
          limitation
          onChange={(caution) => patch({ caution })}
        />
      </div>
    </MemberChanges.Provider>
  );
}
