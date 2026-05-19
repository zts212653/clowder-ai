'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  ConfigFilesSection,
  DataDirsSection,
  type EnvSaveResponse,
  type EnvSummaryData,
  EnvVarsSection,
  initialDraftValue,
  isEditableVariable,
  isMaskedUrlVariable,
  isSensitiveEditable,
  PageIntro,
} from './settings/EnvSubComponents';
import { SettingsStatusStrip } from './settings/primitives';

export function HubEnvFilesTab({ excludeCategories }: { excludeCategories?: string[] } = {}) {
  const [data, setData] = useState<EnvSummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const saveLockRef = useRef(false);
  const [saveState, setSaveState] = useState<{ saving: boolean; error: string | null; success: string | null }>({
    saving: false,
    error: null,
    success: null,
  });

  useEffect(() => {
    apiFetch('/api/config/env-summary')
      .then(async (res) => {
        if (res.ok) {
          const body = (await res.json()) as EnvSummaryData;
          setData(body);
          setDrafts(
            Object.fromEntries(
              body.variables.filter(isEditableVariable).map((variable) => [variable.name, initialDraftValue(variable)]),
            ),
          );
        } else {
          setError('环境信息加载失败');
        }
      })
      .catch(() => setError('环境信息加载失败'));
  }, []);

  if (error) return <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>;
  if (!data) return <SettingsStatusStrip tone="muted">加载中...</SettingsStatusStrip>;

  const editableVariables = data.variables.filter(isEditableVariable);
  const changedUpdates = editableVariables
    .map((variable) => ({
      name: variable.name,
      value: drafts[variable.name] ?? '',
      baselineValue: initialDraftValue(variable),
      maskedUrl: isMaskedUrlVariable(variable),
    }))
    .filter((variable) => variable.value !== variable.baselineValue)
    .filter((variable) => !variable.maskedUrl || variable.value.trim().length > 0)
    .map(({ name, value }) => ({ name, value }));

  const isDirty = changedUpdates.length > 0;

  const handleDraftChange = (name: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [name]: value }));
    setSaveState((prev) => ({ ...prev, error: null, success: null }));
  };

  const handleSave = async () => {
    if (saveLockRef.current) return;
    if (!isDirty) {
      setSaveState({ saving: false, error: null, success: '当前没有待写回的变更' });
      return;
    }
    saveLockRef.current = true;
    setSaveState({ saving: true, error: null, success: null });
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: changedUpdates }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<EnvSaveResponse> & { error?: string };
      if (!res.ok) {
        setSaveState({ saving: false, error: body.error ?? '保存失败', success: null });
        return;
      }
      const nextVariables = Array.isArray(body.summary)
        ? body.summary
        : data.variables.map((variable) => {
            const update = changedUpdates.find((item) => item.name === variable.name);
            if (!update) return variable;
            if (isSensitiveEditable(variable)) {
              return { ...variable, currentValue: update.value ? '***' : null };
            }
            return { ...variable, currentValue: update.value || null };
          });
      setData((prev) => (prev ? { ...prev, variables: nextVariables } : prev));
      setDrafts(
        Object.fromEntries(
          nextVariables.filter(isEditableVariable).map((variable) => [variable.name, initialDraftValue(variable)]),
        ),
      );
      setSaveState({ saving: false, error: null, success: '已写回 .env 并刷新摘要；部分变量需重启相关服务生效' });
    } catch {
      setSaveState({ saving: false, error: '保存失败', success: null });
    } finally {
      saveLockRef.current = false;
    }
  };

  return (
    <div className="space-y-4">
      <PageIntro />
      <EnvVarsSection
        categories={
          excludeCategories
            ? Object.fromEntries(Object.entries(data.categories).filter(([k]) => !excludeCategories.includes(k)))
            : data.categories
        }
        variables={
          excludeCategories ? data.variables.filter((v) => !excludeCategories.includes(v.category)) : data.variables
        }
        drafts={drafts}
        isDirty={isDirty}
        saveState={saveState}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />
      <ConfigFilesSection projectRoot={data.paths.projectRoot} />
      <DataDirsSection dataDirs={data.paths.dataDirs} projectRoot={data.paths.projectRoot} />
    </div>
  );
}
