'use client';
import { BUILTIN_GPT_PRO_CANONICAL_MENTION, supportsCodexFastModel } from '@cat-cafe/shared';
import { createPortal } from 'react-dom';
import {
  AccountSection,
  IdentitySection,
  ProtectedCloudIdentitySection,
  RoutingSection,
} from './hub-cat-editor.sections';
import type { HubCatEditorProps } from './hub-cat-editor.types';
import { AdvancedRuntimeSection } from './hub-cat-editor-advanced';
import { MemberCopyProvider, MemberFieldErrors } from './members/editor-presentation';
import { MemberChanges } from './members/MemberChangeMark';
import { MemberEditorPage } from './members/MemberEditorPage';
import { MemberOperations } from './members/MemberOperationFeedback';
import { MemberSaveFeedback } from './members/MemberSaveFeedback';
import { NativeRuntimeSection } from './NativeRuntimeSection';
import { UnifiedAuthModal } from './UnifiedAuthModal';
import { useHubCatEditor } from './useHubCatEditor';

export function HubCatEditor(props: HubCatEditorProps) {
  return (
    <MemberCopyProvider>
      <HubCatEditorBody {...props} />
    </MemberCopyProvider>
  );
}
function HubCatEditorBody(props: HubCatEditorProps) {
  const { cat, hasDossier, open } = props;
  const editor = useHubCatEditor(props);
  const {
    loadingProfiles,
    loadingStrategy,
    loadingCodexSettings,
    uploadingAvatar,
    strategyError,
    codexSettingsError,
    restoringCloudIdentity,
    fieldErrors,
    form,
    strategyForm,
    codexSettings,
    templates,
    selectedTemplateId,
    showAuthModal,
    pendingProfileIdRef,
    availableProfiles,
    selectedProfile,
    modelOptions,
    protectedCloudIdentity,
    showCodexSettings,
    codexSettingsEditable,
    reservedPatterns,
    createAccountClient,
    hasEmptyCreatableAccounts,
    setShowAuthModal,
    setProfilesVersion,
    patchForm,
    patchStrategy,
    patchCodex,
    handleTemplateSelect,
    requestClose,
    handleAvatarUpload,
    handleRefAudioUpload,
    handleRestoreBuiltinCloudIdentity,
    handleSave,
  } = editor;
  if (!open) return null;
  if (props.presentation === 'page')
    return (
      <MemberOperations.Provider value={editor.operationIssues}>
        <MemberChanges.Provider value={editor.changes}>
          <MemberEditorPage editor={editor} {...props} />
        </MemberChanges.Provider>
      </MemberOperations.Provider>
    );
  const modal = createPortal(
    <MemberChanges.Provider value={editor.changes}>
      <MemberFieldErrors.Provider value={fieldErrors}>
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) void requestClose();
          }}
          data-bootcamp-host="cat-editor-modal"
        >
          <div
            className="member-editor-modal flex max-h-[88vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[28px] bg-[var(--console-card-bg)] shadow-[0_22px_48px_rgba(43,33,26,0.13)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="member-editor-title"
            data-guide-id="member-editor.profile"
            onClick={(event) => event.stopPropagation()}
            data-bootcamp-step="cat-editor"
          >
            <div className="flex shrink-0 items-start justify-between px-7 py-5">
              <p id="member-editor-title" className="text-compact font-extrabold text-[var(--console-modal-title)]">
                {cat ? cat.displayName || cat.name || cat.id : '添加成员'}
              </p>
              <button
                type="button"
                disabled={editor.saving}
                onClick={requestClose}
                className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--console-modal-close-bg)] text-lg font-extrabold leading-none text-[var(--console-modal-close-fg)] transition hover:opacity-80"
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <fieldset disabled={editor.saving} className="min-w-0 space-y-4 border-0 px-7 py-5">
                {!cat ? (
                  <p className="rounded-[14px] bg-[var(--console-field-bg)] px-4 py-3 text-xs font-semibold text-cafe-secondary">
                    首次安装默认只启用一个品种；可在成员管理继续添加其他成员。
                  </p>
                ) : null}
                {!cat && templates.length > 0 && (
                  <section
                    data-guide-id="add-member.template-picker"
                    className="space-y-3 rounded-[18px] bg-[var(--console-card-bg)] p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
                  >
                    <h4 className="text-base font-extrabold text-cafe">成员模板</h4>
                    <p className="text-xs font-semibold text-cafe-secondary">
                      从内置成员模板开始，选择后自动填充身份、模型与运行时默认值。
                    </p>
                    <div className="flex flex-wrap gap-2.5">
                      <button
                        type="button"
                        onClick={() => handleTemplateSelect(null)}
                        className={`h-8 rounded-2xl px-3.5 text-compact font-extrabold transition ${
                          selectedTemplateId === 'custom'
                            ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]'
                            : 'bg-[var(--console-field-bg)] text-[var(--console-template-text)]'
                        }`}
                      >
                        自定义
                      </button>
                      {templates.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => handleTemplateSelect(selectedTemplateId === t.id ? null : t)}
                          className={`h-8 rounded-2xl px-3.5 text-compact font-extrabold transition ${
                            selectedTemplateId === t.id
                              ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]'
                              : 'bg-[var(--console-field-bg)] text-[var(--console-template-text)]'
                          }`}
                        >
                          {t.nickname ?? t.name}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <IdentitySection
                  cat={cat}
                  form={form}
                  hasError={fieldErrors.identity}
                  avatarUploading={uploadingAvatar}
                  hasDossier={hasDossier}
                  onChange={patchForm}
                  onAvatarUpload={handleAvatarUpload}
                  onRefAudioUpload={handleRefAudioUpload}
                />
                {cat && protectedCloudIdentity ? (
                  <ProtectedCloudIdentitySection
                    protection={protectedCloudIdentity}
                    restoring={restoringCloudIdentity}
                    onRestore={() => handleRestoreBuiltinCloudIdentity(cat.id)}
                  />
                ) : (
                  <NativeRuntimeSection form={form} onChange={patchForm}>
                    <AccountSection
                      form={form}
                      hasError={fieldErrors.account}
                      modelOptions={modelOptions}
                      availableProfiles={availableProfiles}
                      loadingProfiles={hasEmptyCreatableAccounts ? true : loadingProfiles}
                      onChange={patchForm}
                    />
                  </NativeRuntimeSection>
                )}
                {hasEmptyCreatableAccounts ? (
                  <section
                    aria-label="认证账号空状态"
                    className="rounded-[18px] border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-[18px]"
                  >
                    <p className="text-xs leading-5 text-cafe-secondary">
                      当前没有可用的认证账号。先新建或登录账号，再继续选择模型并保存成员。
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowAuthModal(true)}
                      className="mt-2 rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition hover:bg-cafe-accent-hover"
                    >
                      新建 / 登录账号
                    </button>
                  </section>
                ) : null}
                <RoutingSection
                  form={form}
                  hasError={fieldErrors.routing}
                  reservedPatterns={reservedPatterns}
                  fixedPatterns={protectedCloudIdentity ? [BUILTIN_GPT_PRO_CANONICAL_MENTION] : undefined}
                  onChange={patchForm}
                />
                {!protectedCloudIdentity ? (
                  <AdvancedRuntimeSection
                    cat={cat}
                    form={form}
                    strategyForm={strategyForm}
                    loadingStrategy={loadingStrategy}
                    strategyError={strategyError}
                    codexSettings={codexSettings}
                    loadingCodexSettings={loadingCodexSettings}
                    codexSettingsError={codexSettingsError}
                    codexSettingsEditable={codexSettingsEditable}
                    showCodexSettings={showCodexSettings}
                    codexSpeedVisible={
                      form.clientId === 'openai' &&
                      selectedProfile?.authType === 'oauth' &&
                      form.carrier !== 'acp' &&
                      (cat ? cat.cli != null : true)
                    }
                    codexFastSupported={supportsCodexFastModel(form.defaultModel)}
                    onChange={patchForm}
                    onStrategyChange={patchStrategy}
                    onCodexChange={patchCodex}
                  />
                ) : null}
              </fieldset>
            </div>

            <div className="member-save-bar member-save-modal">
              <MemberSaveFeedback editor={editor} creating={!cat} onSave={() => void handleSave()} classic />
            </div>
          </div>
          <UnifiedAuthModal
            open={showAuthModal && createAccountClient !== undefined}
            initialClientId={createAccountClient}
            onClose={() => setShowAuthModal(false)}
            onCreated={(profileId) => {
              pendingProfileIdRef.current = profileId;
              setShowAuthModal(false);
              setProfilesVersion((version) => version + 1);
            }}
          />
        </div>
      </MemberFieldErrors.Provider>
    </MemberChanges.Provider>,
    document.body,
  );
  return <MemberOperations.Provider value={editor.operationIssues}>{modal}</MemberOperations.Provider>;
}
