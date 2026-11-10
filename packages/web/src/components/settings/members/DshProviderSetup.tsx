'use client';
import { useEffect, useState } from 'react';
import { SelectField } from '../../hub-cat-editor-fields';
import { type DshInspection, dshSetupError, dshSetupRequest } from './dsh-setup-client';

/** Reading is free; preparing and checking belong to the explicit save action. */
export function DshProviderSetup({
  runtimeId,
  selectedModel,
  onSelection,
  t,
}: {
  runtimeId: string;
  selectedModel?: string;
  onSelection: (model: string) => void;
  t: (zh: string, en: string) => string;
}) {
  const [inspection, setInspection] = useState<DshInspection>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void refresh; // Explicit recovery rereads metadata without preparing or billing.
    let current = true;
    setInspection(undefined);
    setError('');
    dshSetupRequest<DshInspection>('inspect', { runtimeId })
      .then((data) => {
        if (current) setInspection(data);
      })
      .catch((cause: unknown) => {
        if (current) setError(dshSetupError(cause));
      });
    return () => {
      current = false;
    };
  }, [runtimeId, refresh]);
  const choices =
    inspection?.providers.flatMap((route) =>
      route.credential === 'missing'
        ? []
        : route.models.map((model) => ({
            value: JSON.stringify([route.id, model.id]),
            label: `${model.label} · ${route.id}`,
          })),
    ) ?? [];
  const value =
    selectedModel ||
    (inspection?.provider && inspection.model ? JSON.stringify([inspection.provider, inspection.model]) : '');
  const label = choices.find((choice) => choice.value === value)?.label;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-cafe-secondary">
        {label ??
          (value
            ? t('保留已选模型', 'Selected model preserved')
            : t(
                '添加时自动读取 Desktop 模型与认证',
                'Desktop models and authentication are prepared automatically when adding',
              ))}
      </p>
      <details className="space-y-3">
        <summary className="cursor-pointer text-cafe-accent">{t('调整模型', 'Choose another model')}</summary>
        <SelectField
          label={t('DSH 模型', 'DSH model')}
          value={value}
          options={
            choices.some((choice) => choice.value === value)
              ? choices
              : [{ value, label: t('保留当前选择', 'Keep current selection') }, ...choices]
          }
          onChange={onSelection}
        />
      </details>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="min-h-10 text-cafe-accent" onClick={() => setRefresh((value) => value + 1)}>
            {t('重新读取配置', 'Reload configuration')}
          </button>
        </div>
      )}
    </div>
  );
}
