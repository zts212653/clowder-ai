'use client';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import { SelectField } from '../../hub-cat-editor-fields';
import { DshProviderSetup } from './DshProviderSetup';

export function MemberDshProviderSetup({
  form,
  patch,
  t,
}: {
  form: HubCatEditorFormState;
  patch: (value: Partial<HubCatEditorFormState>) => void;
  t: (zh: string, en: string) => string;
}) {
  const runtimes = useMemberModelCatalogs((state) => state.runtimes);
  const sources = runtimes.flatMap((runtime) =>
    runtime.installed && runtime.dshDesktop && runtime.acp ? [{ ...runtime, acp: runtime.acp }] : [],
  );
  const source =
    sources.find((runtime) => runtime.acp?.command === form.acpCommand) ??
    (sources.length === 1 ? sources[0] : undefined);
  return (
    <div className="space-y-3">
      {sources.length > 1 && (
        <SelectField
          label={t('DSH Desktop 安装位置', 'DSH Desktop installation')}
          value={source?.id ?? ''}
          options={[
            { value: '', label: t('请选择安装位置', 'Choose an installation') },
            ...sources.map((runtime) => ({ value: runtime.id, label: runtime.acp.command })),
          ]}
          onChange={(id) => {
            const next = sources.find((runtime) => runtime.id === id);
            if (next?.acp)
              patch({
                acpCommand: next.acp.command,
                acpStartupArgs: serializeCommandArgs(next.acp.startupArgs),
                env: next.env,
                defaultModel: '',
              });
          }}
        />
      )}
      {source ? (
        <DshProviderSetup
          runtimeId={source.id}
          selectedModel={form.defaultModel}
          onSelection={(defaultModel) => patch({ defaultModel })}
          t={t}
        />
      ) : (
        <p className="text-sm text-cafe-secondary">
          {t(
            '当前启动配置已保留。修改连接需要安装 DSH Desktop；仅修改名字或职责可直接保存。',
            'Your launch settings are preserved. Install DSH Desktop to change the connection. Name and role changes can be saved directly.',
          )}
        </p>
      )}
    </div>
  );
}
