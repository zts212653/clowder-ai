'use client';
import { useEffect, useState } from 'react';
import { dshModelLabel } from '@/lib/dsh-model-label';
import { type DshInspection, dshSetupError, dshSetupRequest } from './dsh-setup-client';
import { MemberChoicePicker } from './MemberChoicePicker';

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
  const defaultValue =
    inspection?.provider && inspection.model ? JSON.stringify([inspection.provider, inspection.model]) : '';
  const defaultLabel = choices.find((choice) => choice.value === defaultValue)?.label;
  const automatic = t('自动选择（官方优先）', 'Automatic selection (official first)');
  return (
    <div className="space-y-3 text-sm">
      <MemberChoicePicker
        label={t('模型', 'Model')}
        value={selectedModel ?? ''}
        formatValue={dshModelLabel}
        options={choices}
        onChange={onSelection}
        inheritLabel={automatic}
        inheritValueLabel={
          defaultLabel
            ? `${defaultLabel} · ${t('自动选择', 'Automatic selection')}`
            : inspection || error
              ? automatic
              : t('正在读取 Desktop 模型…', 'Reading Desktop models…')
        }
        inheritedValue={defaultValue}
        searchable
        english={t('zh', 'en') === 'en'}
      />
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
