'use client';

import { BUILTIN_GPT_PRO_CANONICAL_MENTION, supportsCodexFastModel } from '@cat-cafe/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import {
  AccountSection,
  IdentitySection,
  ProtectedCloudIdentitySection,
  RoutingSection,
} from '../hub-cat-editor.sections';
import type { HubCatEditorProps } from '../hub-cat-editor.types';
import { AdvancedRuntimeSection } from '../hub-cat-editor-advanced';
import { requiredHubCatFields } from '../hub-cat-editor-required';
import { VoiceConfigSection } from '../hub-cat-editor-voice';
import { UnifiedAuthModal } from '../UnifiedAuthModal';
import type { HubCatEditorController } from '../useHubCatEditor';
import { MemberEditorPresentation, MemberFieldErrors, useMembersCopy, useMemberText } from './editor-presentation';
import { FamilyAvatarPicker, FamilyTemplatePicker } from './FamilyPickers';
import { MemberContextSection } from './MemberContextSection';
import { MemberSaveBar } from './MemberSaveBar';
import './members.css';

export function MemberEditorPage({
  editor: e,
  cat,
  hasDossier,
  onDelete,
  header,
  embedded = false,
}: HubCatEditorProps & { editor: HubCatEditorController; embedded?: boolean }) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const required = cat ? null : requiredHubCatFields(e.form, e.selectedProfile, true);
  const showRequired =
    required &&
    (e.hasUnsavedChanges || Object.values(e.fieldErrors).some(Boolean)) &&
    required.errorMessages.length > 0;
  const fieldNames: Record<string, string> = {
    Model: '模型',
    别名: '@ 名字',
    '请使用 provider/model 格式（如 minimax/MiniMax-M2.7），或填写 Provider 名称': '服务商名称',
  };
  const main = useRef<HTMLDivElement>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  useEffect(() => {
    main.current?.focus();
  }, []);
  useEffect(() => {
    if (validationAttempt === 0) return;
    const field =
      main.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      main.current?.querySelector<HTMLElement>('[role="alert"]');
    field?.focus({ preventScroll: true });
    if (!field?.closest('.member-save-bar')) field?.scrollIntoView?.({ block: 'center' });
  }, [validationAttempt]);
  const save = async () => {
    await e.handleSave();
    setValidationAttempt((attempt) => attempt + 1);
  };
  const editorId = useId();
  const sectionId = (name: string) => (embedded ? `member-${editorId}-${name}` : `member-${name}`);
  const showDelete = cat && (!embedded || onDelete);
  const sections = [
    { id: 'model', label: '模型与接入' },
    { id: 'mentions', label: '@ 名字' },
    { id: 'identity', label: '身份' },
    { id: 'voice', label: '语音' },
    ...(!e.protectedCloudIdentity
      ? [
          { id: 'context', label: '上下文' },
          { id: 'advanced', label: '高级' },
        ]
      : []),
    ...(showDelete ? [{ id: 'delete', label: '删除成员' }] : []),
  ];
  const identitySection = (
    <div id={sectionId('identity')}>
      <IdentitySection
        cat={cat}
        form={e.form}
        hasError={e.fieldErrors.identity}
        avatarUploading={e.uploadingAvatar}
        hasDossier={hasDossier}
        onChange={e.patchForm}
        onAvatarUpload={e.handleAvatarUpload}
        onRefAudioUpload={e.handleRefAudioUpload}
      />
    </div>
  );
  return (
    <MemberEditorPresentation.Provider value={true}>
      <MemberFieldErrors.Provider value={showRequired ? { ...e.fieldErrors, ...required.errors } : e.fieldErrors}>
        <div
          className={`members-v2 member-editor-page${embedded ? ' member-editor-embedded' : ''}`}
          data-testid="member-detail-page"
          ref={main}
          tabIndex={-1}
        >
          <div className={embedded ? 'member-editor-scroll' : undefined}>
            {!embedded && (
              <>
                <button type="button" className="member-button" onClick={() => void e.requestClose()}>
                  {t('‹ 成员')}
                </button>
                <header className="member-page-heading">
                  {cat && <AvatarImageWithFallback src={cat.avatar} alt="" className="member-heading-avatar" />}
                  <div>
                    <h2>{cat ? cat.nickname || cat.displayName : t('添加成员')}</h2>
                    <p>
                      {cat
                        ? `${cat.displayName} · ${cat.id} · ${cat.defaultModel}`
                        : t('从家里的一只猫开始：名字、性格、颜色都带过来，再按需要改。')}
                    </p>
                  </div>
                </header>
                {header}
              </>
            )}
            {!cat && (
              <>
                {showRequired && (
                  <p role="alert" className="member-error member-required-error">
                    {copy.requiredFields(required.errorMessages.map((field) => t(fieldNames[field] ?? field)))}
                  </p>
                )}
                {e.loadingTemplates && <p>{t('正在读取模板…')}</p>}
                {e.templatesError && (
                  <p role="alert">
                    {t(e.templatesError)}{' '}
                    <button type="button" className="member-button" onClick={e.retryTemplates}>
                      {t('重试')}
                    </button>
                  </p>
                )}
                <FamilyTemplatePicker
                  templates={e.templates}
                  selectedId={e.selectedTemplateId}
                  onSelect={e.handleTemplateSelect}
                />
                <FamilyAvatarPicker
                  value={e.form.avatar}
                  uploading={e.uploadingAvatar}
                  onSelect={(avatar) => e.patchForm({ avatar })}
                  onUpload={e.handleAvatarUpload}
                />
              </>
            )}
            <div className="member-editor-layout">
              {cat && (
                <nav aria-label={t('成员目录')}>
                  {sections.map(({ id, label }) => (
                    <a key={label} className="member-button" href={`#${sectionId(id)}`}>
                      {t(label)}
                    </a>
                  ))}
                </nav>
              )}
              <fieldset className="member-editor-fields" disabled={e.saving}>
                {!cat && identitySection}
                <div id={sectionId('model')}>
                  {cat?.id === 'gpt-dot' ? (
                    <p className="member-helper">
                      砚砚 · dot 身份独立，沿用 ChatGPT 已连接的猫咖插件。
                      <a className="underline" href="/settings?s=plugins#chatgpt-dot">
                        在插件集成中管理连接 ›
                      </a>
                    </p>
                  ) : cat && e.protectedCloudIdentity ? (
                    <ProtectedCloudIdentitySection
                      protection={e.protectedCloudIdentity}
                      restoring={e.restoringCloudIdentity}
                      onRestore={() => e.handleRestoreBuiltinCloudIdentity(cat.id)}
                    />
                  ) : (
                    <AccountSection
                      form={e.form}
                      hasError={e.fieldErrors.account}
                      modelOptions={e.modelOptions}
                      availableProfiles={e.availableProfiles}
                      loadingProfiles={e.loadingProfiles}
                      onChange={e.patchForm}
                    />
                  )}
                  {e.hasEmptyCreatableAccounts && (
                    <div>
                      <p>{t('当前没有可用账号。先新建或登录账号，再选择模型并保存成员。')}</p>
                      <button type="button" className="member-button" onClick={() => e.setShowAuthModal(true)}>
                        {t('新建 / 登录账号')}
                      </button>
                    </div>
                  )}
                </div>
                <div id={sectionId('mentions')}>
                  <RoutingSection
                    form={e.form}
                    hasError={e.fieldErrors.routing}
                    reservedPatterns={e.reservedPatterns}
                    fixedPatterns={e.protectedCloudIdentity ? [BUILTIN_GPT_PRO_CANONICAL_MENTION] : undefined}
                    onChange={e.patchForm}
                  />
                </div>
                {cat && identitySection}
                <section id={sectionId('voice')}>
                  <h3>{t('语音')}</h3>
                  <VoiceConfigSection form={e.form} onChange={e.patchForm} onRefAudioUpload={e.handleRefAudioUpload} />
                </section>
                {!e.protectedCloudIdentity && (
                  <>
                    <div id={sectionId('context')}>
                      <MemberContextSection editor={e} cat={cat} />
                    </div>
                    <div id={sectionId('advanced')}>
                      <AdvancedRuntimeSection
                        cat={cat}
                        form={e.form}
                        strategyForm={e.strategyForm}
                        loadingStrategy={e.loadingStrategy}
                        strategyError={e.strategyError}
                        codexSettings={e.codexSettings}
                        loadingCodexSettings={e.loadingCodexSettings}
                        codexSettingsError={e.codexSettingsError}
                        codexSettingsEditable={e.codexSettingsEditable}
                        showCodexSettings={e.showCodexSettings}
                        codexSpeedVisible={
                          e.form.clientId === 'openai' &&
                          e.selectedProfile?.authType === 'oauth' &&
                          e.form.carrier !== 'acp' &&
                          (cat ? cat.cli != null : true)
                        }
                        codexFastSupported={supportsCodexFastModel(e.form.defaultModel)}
                        onChange={e.patchForm}
                        onStrategyChange={e.patchStrategy}
                        onCodexChange={e.patchCodex}
                      />
                    </div>
                  </>
                )}
                {cat && showDelete && (
                  <section id={sectionId('delete')} className="member-delete-card">
                    <h3>{t('删除成员')}</h3>
                    {cat.identityProtection ? (
                      <p>{t('受保护成员不能删除。')}</p>
                    ) : (
                      <>
                        <p>{t('删除后无法恢复。停用成员可以保留资料。')}</p>
                        <button
                          type="button"
                          className="member-button"
                          onClick={() => void onDelete?.()}
                          disabled={!onDelete || e.saving}
                        >
                          {t('删除成员')}
                        </button>
                      </>
                    )}
                  </section>
                )}
              </fieldset>
            </div>
          </div>
          <MemberSaveBar editor={e} creating={!cat} onSave={save} modal={embedded} />
          <UnifiedAuthModal
            open={e.showAuthModal && e.createAccountClient !== undefined}
            initialClientId={e.createAccountClient}
            onClose={() => e.setShowAuthModal(false)}
            onCreated={(id) => {
              e.pendingProfileIdRef.current = id;
              e.setShowAuthModal(false);
              e.setProfilesVersion((v) => v + 1);
            }}
          />
        </div>
      </MemberFieldErrors.Provider>
    </MemberEditorPresentation.Provider>
  );
}
