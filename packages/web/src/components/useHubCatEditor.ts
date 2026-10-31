'use client';

import { useEffect, useRef, useState } from 'react';
import type { TemplateCard } from './first-run-quest/TemplateStep';
import {
  autoSlug,
  buildStrategyPayload,
  type CodexRuntimeSettings,
  type HubCatEditorFormState,
  initialState,
  joinTags,
  normalizeMentionPattern,
  type StrategyFormState,
  toCodexRuntimeSettings,
} from './hub-cat-editor.model';
import type { HubCatEditorProps } from './hub-cat-editor.types';
import { useMembersCopy } from './members/editor-presentation';
import { memberEditorChanges, requiredMemberChangeErrors } from './members/member-editor-changes';
import { useMemberEditorOperations } from './members/useMemberEditorOperations';
import { saveHubCatEditor } from './saveHubCatEditor';
import { useShellLanguage } from './shell/shell-language';
import { useConfirm } from './useConfirm';
import { useHubCatEditorData } from './useHubCatEditorData';

export function useHubCatEditor(props: HubCatEditorProps) {
  const { onClose } = props;
  const confirm = useConfirm();
  const copy = useMembersCopy();
  const data = useHubCatEditorData(props);
  const baseline = useRef(data.form);
  useEffect(() => {
    if (!data.hasUnsavedChanges) baseline.current = data.form;
  }, [data.form, data.hasUnsavedChanges]);
  const english = useShellLanguage() === 'en';
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveNotice, setSaveNotice] = useState<'unchanged' | 'saved' | null>(null);
  const [savedConnection, setSavedConnection] = useState(false);
  const savingRef = useRef(false);
  const changes = memberEditorChanges(
    data.form,
    baseline.current,
    data.strategyForm,
    data.strategyBaseline,
    data.codexSettings,
    data.codexSettingsBaseline,
    english,
  );
  const dirtyCount = changes.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new editor session must not inherit another session's save receipt.
  useEffect(() => {
    setSavedAt(null);
    setSaveNotice(null);
  }, [props.cat?.id, props.open]);
  const discard = () => {
    setSaveNotice(null);
    data.setForm(baseline.current);
    data.setStrategyForm(data.strategyBaseline);
    data.setCodexSettings(data.codexSettingsBaseline);
    data.setHasUnsavedChanges(false);
    data.setSaveError(null);
    data.setFieldErrors({});
  };
  const {
    reservedPatterns,
    setForm,
    setFieldErrors,
    setSelectedTemplateId,
    setHasUnsavedChanges,
    setStrategyForm,
    setCodexSettings,
  } = data;
  const patchForm = (patch: Partial<HubCatEditorFormState>) => {
    setSaveNotice(null);
    setHasUnsavedChanges(true);
    setForm((prev) => ({ ...prev, ...patch }));
    {
      const fields: Partial<Record<keyof HubCatEditorFormState, string>> = {
        name: 'Name',
        roleDescription: 'Description',
        defaultModel: 'Model',
        provider: 'OC Provider Name',
        mentionPatterns: 'Aliases',
        accountRef: 'Account',
      };
      setFieldErrors((prev) => ({
        ...prev,
        ...Object.fromEntries(
          Object.keys(patch).flatMap((key) =>
            fields[key as keyof HubCatEditorFormState] ? [[fields[key as keyof HubCatEditorFormState], false]] : [],
          ),
        ),
      }));
    }
    if (patch.mentionPatterns !== undefined) {
      setFieldErrors((prev) => ({ ...prev, routing: false }));
    }
    if (patch.name !== undefined || patch.roleDescription !== undefined) {
      setFieldErrors((prev) => ({ ...prev, identity: false }));
    }
    if (patch.defaultModel !== undefined || patch.clientId !== undefined || patch.accountRef !== undefined) {
      setFieldErrors((prev) => ({ ...prev, account: false }));
    }
  };
  const patchStrategy = (patch: Partial<StrategyFormState>) => {
    setSaveNotice(null);
    setHasUnsavedChanges(true);
    setStrategyForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };
  const patchCodex = (patch: Partial<CodexRuntimeSettings>) => {
    setSaveNotice(null);
    setHasUnsavedChanges(true);
    setCodexSettings((prev) => ({
      ...(prev ?? toCodexRuntimeSettings()),
      ...patch,
    }));
  };

  const handleTemplateSelect = (t: TemplateCard | null) => {
    if (!t) {
      setSelectedTemplateId('custom');
      setForm(initialState(null, null));
      setHasUnsavedChanges(false);
      return;
    }
    setSelectedTemplateId(t.id);
    const name = t.name;
    const catId = autoSlug(name);
    // Auto-suffix aliases that conflict with existing cats
    const rawAliases = [t.nickname, name].filter((s): s is string => Boolean(s));
    const deduped = rawAliases.map((alias) => {
      const normalized = normalizeMentionPattern(alias);
      if (!reservedPatterns.has(normalized.toLowerCase())) return normalized;
      for (let i = 2; i <= 99; i++) {
        const candidate = normalizeMentionPattern(`${alias}${i}`);
        if (!reservedPatterns.has(candidate.toLowerCase())) return candidate;
      }
      return normalized; // fallback — backend will catch it
    });
    patchForm({
      name,
      displayName: name,
      nickname: t.nickname ?? '',
      avatar: t.avatar ?? '',
      colorPrimary: t.color.primary,
      colorSecondary: t.color.secondary,
      roleDescription: t.roleDescription,
      personality: t.personality,
      teamStrengths: t.teamStrengths ?? '',
      catId,
      mentionPatterns: joinTags(deduped),
    });
  };

  const requestClose = async () => {
    if (data.saving) return;
    if (dirtyCount === 0) {
      onClose();
      return;
    }
    const options =
      props.presentation === 'page'
        ? { title: copy.closeTitle, message: copy.unsavedPrompt, confirmLabel: copy.leave, cancelLabel: copy.取消 }
        : { title: '关闭确认', message: '有未保存的修改，确定要关闭吗？' };
    if (await confirm(options)) onClose();
  };

  const operations = useMemberEditorOperations(props, data, patchForm);

  const handleSave = async () => {
    if (savingRef.current || data.restoringCloudIdentity || data.saveBlockedByProfileBinding) return;
    if (props.cat && dirtyCount === 0) {
      data.setSaveError(null);
      data.setFieldErrors({});
      setSaveNotice('unchanged');
      return;
    }
    if (props.cat) {
      const invalid = requiredMemberChangeErrors(data.form, changes);
      if (Object.keys(invalid).length) {
        data.setFieldErrors(invalid);
        return;
      }
    }
    savingRef.current = true;
    setSaveNotice(null);
    try {
      const saved = await saveHubCatEditor({ ...props, onClose: props.cat ? () => {} : onClose }, data);
      if (!saved) return;
      baseline.current = data.form;
      if (
        data.strategyForm &&
        JSON.stringify(buildStrategyPayload(data.strategyForm)) !==
          JSON.stringify(data.strategyBaseline ? buildStrategyPayload(data.strategyBaseline) : null)
      )
        data.setStrategyBaselineHasOverride(true);
      data.setStrategyBaseline(data.strategyForm);
      data.setCodexSettingsBaseline(data.codexSettings);
      data.setHasUnsavedChanges(false);
      setSavedConnection(
        changes.some((change) =>
          ['defaultModel', 'clientId', 'carrier', 'accountRef', 'accountBindingMode'].includes(change.key),
        ),
      );
      setSavedAt(Date.now());
      setSaveNotice('saved');
    } finally {
      savingRef.current = false;
    }
  };

  return {
    ...data,
    dirtyCount,
    changes,
    savedAt,
    saveNotice,
    savedConnection,
    discard,
    patchForm,
    patchStrategy,
    patchCodex,
    handleTemplateSelect,
    requestClose,
    ...operations,
    handleSave,
  };
}

export type HubCatEditorController = ReturnType<typeof useHubCatEditor>;
