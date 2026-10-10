'use client';
import { useState } from 'react';
import { uploadAvatarAsset, uploadRefAudioAsset } from '../../hub-cat-editor.client';
import { autoSlug, type HubCatEditorFormState, type StrategyFormState } from '../../hub-cat-editor.model';
import { SelectField, TextAreaField, TextField } from '../../hub-cat-editor-fields';
import { TagEditor } from '../../hub-tag-editor';
import { MemberAdvancedFields } from './MemberAdvancedFields';
import type { MemberText } from './MemberRuntimeFields';
import { MemberSessionFields } from './MemberSessionFields';

type StringField = {
  [K in keyof HubCatEditorFormState]: HubCatEditorFormState[K] extends string ? K : never;
}[keyof HubCatEditorFormState];
export type MemberField = [NonNullable<StringField>, string, string];
const identityFields: MemberField[] = [
  ['nickname', '昵称', 'Nickname'],
  ['mentionPatterns', '呼叫别名', 'Mention aliases'],
  ['roleDescription', '职责', 'Role'],
  ['personality', '个性', 'Personality'],
  ['teamStrengths', '团队分工', 'Team contribution'],
  ['strengths', '擅长', 'Strengths'],
  ['caution', '限制与注意事项', 'Limitations'],
  ['variantLabel', '版本备注', 'Version label'],
];
const voiceFields: MemberField[] = [
  ['voiceVoice', '音色', 'Voice'],
  ['voiceLangCode', '语言代码', 'Language code'],
  ['voiceSpeed', '语速', 'Speed'],
  ['voiceRefAudio', '参考音频', 'Reference audio'],
  ['voiceRefText', '参考文本', 'Reference text'],
  ['voiceInstruct', '语音指令', 'Voice instruction'],
  ['voiceTemperature', '温度', 'Temperature'],
];

export function MemberAdditionalFields({
  section,
  form,
  patch,
  t,
  editing,
  strategy,
  patchStrategy,
}: {
  section: string;
  form: HubCatEditorFormState;
  patch: (change: Partial<HubCatEditorFormState>) => void;
  t: MemberText;
  editing: boolean;
  strategy: StrategyFormState | null | undefined;
  patchStrategy: (change: Partial<StrategyFormState>) => void;
}) {
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fields = (items: MemberField[]) =>
    items.map(([key, zh, en]) => {
      if (key === 'mentionPatterns' || key === 'strengths')
        return (
          <div key={key} className="space-y-2">
            <p className="text-sm font-medium">{t(zh, en)}</p>
            <TagEditor
              tags={String(form[key])
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean)}
              onChange={(values) => patch({ [key]: values.join(', ') })}
              addLabel={t('添加', 'Add')}
              placeholder={key === 'mentionPatterns' ? '@名字' : t('例如：代码审查', 'e.g. Code review')}
              emptyLabel={t('尚未添加', 'None added')}
            />
          </div>
        );
      const Field = [
        'roleDescription',
        'personality',
        'teamStrengths',
        'caution',
        'voiceRefText',
        'voiceInstruct',
      ].includes(key)
        ? TextAreaField
        : TextField;
      return (
        <Field
          key={key}
          label={t(zh, en)}
          value={String(form[key] ?? '')}
          onChange={(value) => patch({ [key]: value })}
        />
      );
    });
  const upload = async (file: File, kind: 'avatar' | 'audio') => {
    setUploading(true);
    setUploadError('');
    try {
      patch(
        kind === 'avatar'
          ? { avatar: await uploadAvatarAsset(file) }
          : { voiceRefAudio: (await uploadRefAudioAsset(file)).url },
      );
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t('上传失败', 'Upload failed'));
    } finally {
      setUploading(false);
    }
  };
  if (section === 'identity')
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('身份与职责', 'Identity & role')}</h2>
        {editing && <p className="text-sm text-cafe-secondary">ID · {form.catId}</p>}
        <TextField
          label={t('名字', 'Name')}
          value={form.name}
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
        {fields(identityFields.filter(([key]) => !['teamStrengths', 'caution', 'variantLabel'].includes(key)))}
        <details className="rounded-xl border border-[var(--console-border-soft)] p-4">
          <summary className="cursor-pointer text-sm">{t('更多角色设置', 'More role settings')}</summary>
          <div className="mt-4 space-y-4">
            {fields(identityFields.filter(([key]) => ['teamStrengths', 'caution', 'variantLabel'].includes(key)))}
          </div>
        </details>
        <details className="rounded-xl border border-[var(--console-border-soft)] p-4" open>
          <summary className="mb-4 cursor-pointer text-sm">
            {t('外观', 'Appearance')} · {form.colorPrimary}
          </summary>
          <div className="space-y-4">
            {form.avatar && (form.avatar.startsWith('/') || /^https?:\/\//.test(form.avatar)) && (
              <img
                src={form.avatar}
                alt={t('头像预览', 'Avatar preview')}
                className="h-16 w-16 rounded-full object-cover"
              />
            )}
            <details>
              <summary className="cursor-pointer text-sm">{t('使用图片地址', 'Use an image URL')}</summary>
              <TextField label={t('头像', 'Avatar')} value={form.avatar} onChange={(avatar) => patch({ avatar })} />
            </details>
            <label className="block text-sm">
              {t('上传头像', 'Upload avatar')}
              <input
                className="mt-2 block w-full text-sm"
                type="file"
                accept="image/*"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file, 'avatar');
                }}
              />
            </label>
            <label className="flex items-center gap-3 text-sm">
              {t('成员主色', 'Member color')}
              <input
                type="color"
                value={form.colorPrimary}
                onChange={(event) => patch({ colorPrimary: event.target.value })}
              />
              <span className="rounded-full border px-4 py-2" style={{ color: form.colorPrimary }}>
                {form.name || t('我的伙伴', 'My teammate')}
              </span>
            </label>
          </div>
        </details>
        {uploadError && (
          <p role="alert" className="text-sm text-conn-red-text">
            {uploadError}
          </p>
        )}
      </div>
    );
  if (section === 'voice')
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('语音', 'Voice')}</h2>
        <p className="text-sm text-cafe-secondary">
          {t(
            '语音独立于运行工具；换工具或模型时保留。',
            'Voice stays with this teammate when changing tools or models.',
          )}
        </p>
        <SelectField
          label={t('语言', 'Language')}
          value={form.voiceLangCode}
          options={[
            { value: '', label: t('跟随语音服务', 'Follow voice service') },
            { value: 'zh', label: '中文' },
            { value: 'z', label: '中文 (z)' },
            { value: 'en-us', label: 'English' },
            { value: 'ja', label: '日本語' },
            ...(!['', 'zh', 'z', 'en-us', 'ja'].includes(form.voiceLangCode)
              ? [{ value: form.voiceLangCode, label: form.voiceLangCode }]
              : []),
          ]}
          onChange={(voiceLangCode) => patch({ voiceLangCode })}
        />
        {fields(voiceFields.filter(([key]) => ['voiceVoice', 'voiceSpeed'].includes(key)))}
        <details className="rounded-xl border border-[var(--console-border-soft)] p-4">
          <summary className="cursor-pointer text-sm">
            {t('声音克隆与高级设置', 'Voice cloning & advanced settings')}
          </summary>
          <div className="mt-4 space-y-4">
            <TextField
              label={t('自定义语言代码', 'Custom language code')}
              value={form.voiceLangCode}
              onChange={(voiceLangCode) => patch({ voiceLangCode })}
            />
            {fields(
              voiceFields.filter(
                ([key]) => !['voiceVoice', 'voiceSpeed', 'voiceLangCode', 'voiceRefAudio'].includes(key),
              ),
            )}
            <p className="break-words text-sm">
              {t('参考音频', 'Reference audio')}：
              {form.voiceRefAudio.split(/[\\/]/).pop() || t('尚未上传', 'Not uploaded')}
            </p>
            <TextField
              label={t('参考音频地址', 'Reference audio URL')}
              value={form.voiceRefAudio}
              onChange={(voiceRefAudio) => patch({ voiceRefAudio })}
            />
            <label className="block text-sm">
              {t('上传参考音频', 'Upload reference audio')}
              <input
                className="mt-2 block w-full text-sm"
                type="file"
                accept="audio/*"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file, 'audio');
                }}
              />
            </label>
            {uploadError && (
              <p role="alert" className="text-sm text-conn-red-text">
                {uploadError}
              </p>
            )}
          </div>
        </details>
      </div>
    );
  if (section === 'context')
    return (
      <MemberSessionFields
        form={form}
        patch={patch}
        strategy={strategy}
        patchStrategy={patchStrategy}
        editing={editing}
        t={t}
      />
    );

  return <MemberAdvancedFields form={form} patch={patch} t={t} fields={fields} />;
}
