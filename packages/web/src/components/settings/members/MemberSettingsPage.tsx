'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { MemberAdditionalFields } from './MemberAdditionalFields';
import { MemberCloudIdentity } from './MemberCloudIdentity';
import { MemberCodexOptions } from './MemberCodexOptions';
import { MemberRuntimeFields } from './MemberRuntimeFields';
import { useMemberEditor } from './useMemberEditor';

const sections = [
  ['runtime', '模型与工具', 'Model & tool'],
  ['identity', '身份与职责', 'Identity & role'],
  ['voice', '语音', 'Voice'],
  ['context', '上下文与会话', 'Context & sessions'],
  ['advanced', '高级接入', 'Advanced connection'],
] as const;

export function MemberSettingsPage({
  cat,
  cats,
  onSaved,
  onBack,
}: {
  cat: CatData | null;
  cats: CatData[];
  onSaved: (cat: CatData) => Promise<void>;
  onBack: () => void;
}) {
  const router = useRouter();
  const [runtimeValid, setRuntimeValid] = useState(true);
  const searchParams = useSearchParams();
  const english = searchParams.get('lang') === 'en';
  const toggleLanguage = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('lang', english ? 'zh' : 'en');
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };
  const t = (zh: string, en: string) => (english ? en : zh);
  const editor = useMemberEditor(cat, cats, onSaved);
  const { draft, accounts, ready, saving, dirtyCount } = editor;
  const { form, baseline, section } = draft;
  const identity = accounts.find((account) => account.id === form.accountRef);
  const tool = form.acpEnabled
    ? /dsh|deepseek/i.test(form.acpCommand + form.acpStartupArgs)
      ? 'DSH'
      : 'ACP'
    : form.clientId === 'openai'
      ? 'Codex'
      : form.clientId === 'anthropic'
        ? 'Claude Code'
        : form.clientId;
  const accountLabel =
    identity?.displayName || identity?.name || form.accountRef || t('使用工具当前配置', 'Current tool configuration');
  const query = new URLSearchParams(searchParams.toString());
  query.set('s', 'members');
  query.set('lang', english ? 'en' : 'zh');
  if (cat) query.set('cat', cat.id);
  else query.set('view', 'add');
  const returnTo = `/settings?${query.toString()}`;
  const accountQuery = new URLSearchParams(query);
  accountQuery.set('s', 'accounts');
  accountQuery.set('client', form.clientId);
  accountQuery.set('tool', tool);
  accountQuery.delete('cat');
  accountQuery.delete('view');
  accountQuery.set('returnTo', returnTo);
  const accountHref = `/settings?${accountQuery.toString()}`;
  return (
    <div className="relative min-w-0 pb-28 text-cafe" data-testid="member-settings-page">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <button type="button" className="mb-3 min-h-10 text-sm text-cafe-accent" onClick={onBack}>
            ← {t('成员与运行时', 'Members & runtimes')}
          </button>
          <h1 className="text-2xl font-semibold">{cat ? form.name : t('添加猫猫伙伴', 'Add a teammate')}</h1>
          <p className="mt-2 break-words text-sm text-cafe-secondary" data-testid="member-identity-summary">
            {tool}
            {form.accountRef ? ` · ${accountLabel}` : ''}
            {form.roleDescription ? ` · ${form.roleDescription}` : ''}
          </p>
        </div>
        <button type="button" onClick={toggleLanguage} className="min-h-10 px-2 text-sm text-cafe-secondary">
          {english ? '中文' : 'English'}
        </button>
      </div>
      {!ready ? (
        <div role="status" className="rounded-xl bg-[var(--console-card-bg)] p-6 text-sm">
          {editor.error || t('加载成员配置…', 'Loading configuration…')}
          {editor.error && (
            <button type="button" onClick={editor.retry} className="ml-4 text-cafe-accent">
              {t('重试', 'Retry')}
            </button>
          )}
        </div>
      ) : (
        <>
          {!cat && (
            <section className="mb-6 rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-5">
              <h2 className="text-lg font-semibold">{t('选择伙伴模板', 'Choose a teammate')}</h2>
              <p className="mb-4 mt-1 text-sm text-cafe-secondary">
                {t(
                  '选一个喜欢的伙伴，或从空白开始。',
                  'A template brings a name and personality. Tools can change; models and effort inherit.',
                )}
              </p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {editor.templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => editor.chooseTemplate(template)}
                    aria-pressed={draft.templateId === template.id}
                    className={`flex items-center gap-2 rounded-xl border p-2 text-left ${draft.templateId === template.id ? 'border-cafe-accent bg-[var(--console-field-bg)]' : 'border-[var(--console-border-soft)]'}`}
                  >
                    {/* Local template assets are already validated by the template API. */}
                    <img src={template.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
                    <span className="min-w-0">
                      <strong className="block text-sm">{template.nickname || template.name}</strong>
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => editor.chooseTemplate(null)}
                  aria-pressed={!draft.templateId}
                  className="min-h-11 rounded-xl border border-dashed border-[var(--console-border-soft)] px-4 text-sm"
                >
                  + {t('从空白开始', 'Start from scratch')}
                </button>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  {t('名字', 'Name')}
                  <input
                    className="mt-2 block w-full rounded-lg bg-[var(--console-field-bg)] p-3"
                    value={form.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      editor.patch({
                        name,
                        displayName: name,
                        ...(!form.catId ? { catId: `cat-${crypto.randomUUID().slice(0, 8)}` } : {}),
                        ...(!form.mentionPatterns || form.mentionPatterns === `@${form.name}`
                          ? { mentionPatterns: `@${name}` }
                          : {}),
                      });
                    }}
                  />
                </label>
                <label className="text-sm">
                  {t('职责（可选）', 'Role (optional)')}
                  <input
                    className="mt-2 block w-full rounded-lg bg-[var(--console-field-bg)] p-3"
                    value={form.roleDescription}
                    onChange={(event) => editor.patch({ roleDescription: event.target.value })}
                  />
                </label>
              </div>
            </section>
          )}
          <div className="grid items-start gap-5 md:grid-cols-[180px_minmax(0,1fr)]">
            <nav
              aria-label={t('成员配置目录', 'Member sections')}
              className="flex gap-2 overflow-x-auto pb-2 md:sticky md:top-4 md:flex-col"
            >
              {sections.map(([key, zh, en]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => {
                    editor.setSection(key);
                    document.getElementById('member-field-panel')?.scrollIntoView?.({ block: 'nearest' });
                  }}
                  aria-current={section === key ? 'page' : undefined}
                  className={`min-h-11 shrink-0 rounded-xl px-3 py-3 text-left text-sm ${section === key ? 'bg-[var(--console-field-bg)] font-semibold text-cafe-accent' : 'text-cafe-secondary'}`}
                >
                  {t(zh, en)}
                </button>
              ))}
            </nav>
            <fieldset
              id="member-field-panel"
              disabled={saving}
              className="min-w-0 rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-5 sm:p-6"
            >
              {section === 'runtime' ? (
                cat?.identityProtection ? (
                  <MemberCloudIdentity cat={cat} onSaved={onSaved} t={t} />
                ) : (
                  <MemberRuntimeFields
                    form={form}
                    accounts={accounts}
                    patch={editor.patch}
                    t={t}
                    accountHref={accountHref}
                    editing={Boolean(cat)}
                    onValidityChange={setRuntimeValid}
                  />
                )
              ) : (
                <MemberAdditionalFields
                  section={section}
                  form={form}
                  patch={editor.patch}
                  t={t}
                  editing={Boolean(cat)}
                  strategy={draft.strategy}
                  patchStrategy={editor.patchStrategy}
                />
              )}
              {section === 'advanced' && !cat?.identityProtection && (
                <MemberCodexOptions
                  form={form}
                  authType={identity?.authType}
                  settings={draft.codexSettings}
                  error={editor.codexError}
                  patch={editor.patch}
                  patchSettings={editor.patchCodex}
                  retry={editor.retryCodex}
                  t={t}
                />
              )}
            </fieldset>
          </div>
          {editor.error && (
            <div role="alert" className="mt-4 rounded-xl bg-conn-red-bg p-4 text-sm text-conn-red-text">
              {editor.error}
            </div>
          )}
          {editor.conflicted && (
            <button
              type="button"
              onClick={() => void editor.refreshBaseline()}
              className="mt-3 min-h-11 rounded-lg border px-4 text-sm"
            >
              {t('重新读取，保留我的修改并核对', 'Reload latest and keep my edits for review')}
            </button>
          )}
          {editor.notice && (
            <p role="status" className="mt-4 text-sm text-cafe-secondary">
              {editor.notice}
            </p>
          )}
          {editor.storageWarning && (
            <p role="alert" className="mt-4 text-sm">
              {t('浏览器无法保留草稿，请保存后再离开。', 'Draft storage is unavailable; save before leaving.')}
            </p>
          )}
          {(dirtyCount > 0 || !cat) && (
            <div
              className="sticky bottom-3 z-40 mx-auto mt-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 shadow-lg"
              data-testid="member-save-bar"
            >
              <span className="text-sm">
                {cat
                  ? t(`${dirtyCount} 处修改未保存`, `${dirtyCount} unsaved changes`)
                  : t('准备好就可以添加伙伴', 'Ready to add your teammate')}
                {editor.codexDirtyCount > 0 && (
                  <span className="block text-sm">
                    {t(
                      `含 ${editor.codexDirtyCount} 项全局 Codex 修改`,
                      `Includes ${editor.codexDirtyCount} global Codex changes`,
                    )}
                  </span>
                )}
              </span>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={saving}
                  onClick={editor.discard}
                  className="min-h-11 rounded-lg px-4 text-sm"
                >
                  {t('放弃', 'Discard')}
                </button>
                <button
                  type="button"
                  disabled={
                    saving ||
                    !form.name.trim() ||
                    (!runtimeValid &&
                      (!baseline ||
                        form.defaultModel !== baseline.defaultModel ||
                        form.cliEffort !== (baseline.cli?.effort ?? '')))
                  }
                  onClick={() => void editor.save()}
                  className="min-h-11 rounded-lg bg-cafe-accent px-5 text-sm font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
                >
                  {saving ? t('保存中…', 'Saving…') : cat ? t('保存', 'Save') : t('添加伙伴', 'Add teammate')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
