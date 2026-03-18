'use client';

import type { CatData } from '@/hooks/useCatData';
import {
  CLIENT_OPTIONS,
  splitMentionPatterns,
  splitStrengthTags,
  type HubCatEditorFormState,
} from './hub-cat-editor.model';
import type { ProfileItem } from './hub-provider-profiles.types';
import { SectionCard, SelectField, TextAreaField, TextField } from './hub-cat-editor-fields';

type FormPatch = Partial<HubCatEditorFormState>;

function fieldInputClass() {
  return 'w-full rounded-xl border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2.5 text-sm text-[#2D2118] outline-none transition focus:border-[#D49266] focus:ring-2 focus:ring-[#F5D2B8]';
}

export function IdentitySection({
  cat,
  form,
  onChange,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  onChange: (patch: FormPatch) => void;
}) {
  const strengthTags = splitStrengthTags(form.strengths);

  return (
    <SectionCard
      title="身份信息"
      description="成员身份信息与对外展示文案。编辑现有成员时，Name 会同步 name/displayName，避免两处漂移。"
    >
      {!cat ? (
        <div className="grid gap-4 md:grid-cols-3">
          <TextField label="Cat ID" value={form.catId} onChange={(value) => onChange({ catId: value })} />
          <TextField label="Name" value={form.name} onChange={(value) => onChange({ name: value })} />
          <TextField
            label="Display Name"
            value={form.displayName}
            onChange={(value) => onChange({ displayName: value })}
          />
        </div>
      ) : (
        <TextField label="Name" value={form.name} onChange={(value) => onChange({ name: value, displayName: value })} />
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[#5C4B42]">Avatar</span>
          <span className="text-xs text-[#8A776B]">点击上传新头像覆盖</span>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-[#E8DCCF] bg-white/80 p-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-[#E8DCCF] bg-[#F7F3F0] text-xs text-[#8A776B]">
            {form.avatar ? '已设置' : 'Avatar'}
          </div>
          <input
            aria-label="Avatar"
            value={form.avatar}
            onChange={(event) => onChange({ avatar: event.target.value })}
            className={fieldInputClass()}
            placeholder="/avatars/codex.png"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[#5C4B42]">Background Color</span>
          <span className="text-xs text-[#8A776B]">点击调色盘</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-3 rounded-2xl border border-[#E8DCCF] bg-white/80 px-3 py-2.5 text-sm text-[#5C4B42]">
            <span className="h-8 w-8 rounded-full border border-white shadow-sm" style={{ backgroundColor: form.colorPrimary }} />
            <span className="flex-1">Primary</span>
            <input
              type="color"
              aria-label="Background Color Primary"
              value={form.colorPrimary}
              onChange={(event) => onChange({ colorPrimary: event.target.value })}
              className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
          <label className="flex items-center gap-3 rounded-2xl border border-[#E8DCCF] bg-white/80 px-3 py-2.5 text-sm text-[#5C4B42]">
            <span className="h-8 w-8 rounded-full border border-white shadow-sm" style={{ backgroundColor: form.colorSecondary }} />
            <span className="flex-1">Secondary</span>
            <input
              type="color"
              aria-label="Background Color Secondary"
              value={form.colorSecondary}
              onChange={(event) => onChange({ colorSecondary: event.target.value })}
              className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Nickname" value={form.nickname} onChange={(value) => onChange({ nickname: value })} />
        <TextField
          label="Description"
          value={form.roleDescription}
          onChange={(value) => onChange({ roleDescription: value })}
        />
        <TextField
          label="Team Strengths"
          value={form.teamStrengths}
          onChange={(value) => onChange({ teamStrengths: value })}
        />
        <TextField
          label="Personality"
          value={form.personality}
          onChange={(value) => onChange({ personality: value })}
        />
        <TextField label="Caution" value={form.caution} onChange={(value) => onChange({ caution: value })} placeholder="(无)" />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[#5C4B42]">Strengths</span>
          <button
            type="button"
            className="rounded-full border border-[#D9C5EF] bg-[#F3EDFA] px-3 py-1 text-xs font-medium text-[#8B68B7]"
          >
            + 选择
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {strengthTags.length > 0 ? (
            strengthTags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[#D9C5EF] bg-[#F3EDFA] px-2.5 py-1 text-xs font-medium text-[#8B68B7]"
              >
                {tag}
              </span>
            ))
          ) : (
            <span className="text-sm italic text-[#8A776B]">(无)</span>
          )}
        </div>
        <input
          aria-label="Strengths"
          value={form.strengths}
          onChange={(event) => onChange({ strengths: event.target.value })}
          className={fieldInputClass()}
          placeholder="security, testing"
        />
      </div>

      <div className="rounded-2xl border border-dashed border-[#DCC9B8] bg-[#FFF7F0] px-4 py-3">
        <p className="text-sm font-medium text-[#5C4B42]">▸ Voice Config (点击展开)</p>
        <p className="mt-1 text-xs leading-5 text-[#8A776B]">需对接和启用语音功能后才支持配置</p>
      </div>
    </SectionCard>
  );
}

export function AccountSection({
  form,
  availableProfiles,
  selectedProfile,
  loadingProfiles,
  onChange,
}: {
  form: HubCatEditorFormState;
  availableProfiles: ProfileItem[];
  selectedProfile: ProfileItem | null;
  loadingProfiles: boolean;
  onChange: (patch: FormPatch) => void;
}) {
  return (
    <SectionCard
      title="账号与运行方式"
      description="普通成员绑定 Client / Provider / Model；Antigravity 走命令行直连。切换 Provider 后会重算可选模型。"
    >
      <p className="rounded-2xl border border-[#F1E7DF] bg-white/80 px-4 py-3 text-xs leading-5 text-[#8A776B]">
        Provider 下拉展示具体账号标签，例如 `Claude (OAuth)`；如果 Provider 模型列表为空，则回退为手动输入 Model。
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <SelectField
          label="Client"
          value={form.client}
          options={CLIENT_OPTIONS}
          onChange={(value) => onChange({ client: value as HubCatEditorFormState['client'] })}
        />

        {form.client === 'antigravity' ? (
          <>
            <TextField label="CLI Command" value={form.commandArgs} onChange={(value) => onChange({ commandArgs: value })} />
            <TextField label="Model" value={form.defaultModel} onChange={(value) => onChange({ defaultModel: value })} />
          </>
        ) : (
          <>
            <SelectField
              label="Provider"
              value={form.providerProfileId}
              options={[
                { value: '', label: loadingProfiles ? '加载中…' : '未绑定' },
                ...availableProfiles.map((profile) => ({ value: profile.id, label: profile.displayName })),
              ]}
              onChange={(value) => onChange({ providerProfileId: value })}
              disabled={loadingProfiles}
            />
            {selectedProfile?.models.length ? (
              <SelectField
                label="Model"
                value={form.defaultModel}
                options={selectedProfile.models.map((model) => ({ value: model, label: model }))}
                onChange={(value) => onChange({ defaultModel: value })}
              />
            ) : (
              <TextField label="Model" value={form.defaultModel} onChange={(value) => onChange({ defaultModel: value })} />
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

export function RoutingSection({
  form,
  onChange,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: FormPatch) => void;
}) {
  const aliases = splitMentionPatterns(form.mentionPatterns);

  return (
    <SectionCard title="别名与 @ 路由" description="默认 alias、中文名和历史 mention pattern 在这里维护。当前 + 添加 按钮先作为占位入口。">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#7F7168]">支持逗号或换行分隔；chip 区展示最终会参与 @ 路由的 pattern。</p>
        <button
          type="button"
          className="rounded-full border border-[#D9C5EF] bg-[#F3EDFA] px-3 py-1 text-xs font-medium text-[#8B68B7]"
        >
          + 添加
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {aliases.length > 0 ? (
          aliases.map((alias) => (
            <span
              key={alias}
              className="rounded-full border border-[#D9C5EF] bg-[#F3EDFA] px-2.5 py-1 text-xs font-medium text-[#8B68B7]"
            >
              {alias}
            </span>
          ))
        ) : (
          <span className="text-sm italic text-[#8A776B]">(暂无别名)</span>
        )}
      </div>
      <TextAreaField
        label="Aliases"
        value={form.mentionPatterns}
        onChange={(value) => onChange({ mentionPatterns: value })}
        placeholder="@codex, @缅因猫"
      />
    </SectionCard>
  );
}
