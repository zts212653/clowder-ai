import { SelectField } from '../../hub-cat-editor-fields';
import type { MemberText } from './MemberRuntimeFields';
import type { RuntimeChoice } from './member-runtime-draft';
import { memberRuntimeOptions, type RuntimeEdition } from './member-runtime-tools';

/** A harness is a product; exact configurations and plugin grants remain separate choices. */
export function MemberToolSelector({
  tools,
  selected,
  current = selected,
  tool,
  edition,
  loading = false,
  onChange,
  t,
}: {
  tools: RuntimeChoice[];
  selected?: RuntimeChoice;
  current?: RuntimeChoice;
  tool: string;
  edition?: RuntimeEdition;
  loading?: boolean;
  onChange: (runtime: RuntimeChoice) => void;
  t: MemberText;
}) {
  const choose = (id: string) => {
    const next = tools.find((item) => item.id === id);
    if (
      next?.kind === 'tool' &&
      next.harnessId &&
      !current?.acp?.agentProvider &&
      next.harnessId === current?.harnessId
    )
      return;
    if (next && next.id !== selected?.id && next.discoveryStatus !== 'acp_profile_invalid') onChange(next);
  };
  if (!edition)
    return (
      <SelectField
        label={t('使用工具', 'Tool')}
        value="pending"
        disabled
        options={[
          {
            value: 'pending',
            label: loading
              ? t('正在读取工具 · 当前配置已保留', 'Reading tools · Current configuration preserved')
              : t('工具目录暂不可读取 · 当前配置已保留', 'Tool catalog unavailable · Current configuration preserved'),
          },
        ]}
        onChange={() => {}}
      />
    );
  if (edition !== 'intranet') {
    const choices = memberRuntimeOptions(tools, t);
    if (!selected)
      choices.unshift({
        value: 'current',
        disabled: false,
        label: `${tool} · ${t('当前配置', 'Current configuration')}`,
      });
    return (
      <SelectField
        label={t('使用工具', 'Tool')}
        value={selected?.id ?? 'current'}
        options={choices}
        onChange={choose}
      />
    );
  }
  const harness = tools.find((item) => item.kind === 'tool' && item.harnessId === current?.harnessId);
  const choices = memberRuntimeOptions(tools, t, 'tools');
  if (!harness)
    choices.unshift({ value: '', disabled: true, label: t('使用已有接入配置', 'Using an existing configuration') });
  const bindings = memberRuntimeOptions(tools, t, 'bindings');
  const currentBinding = selected?.kind === 'binding' ? selected.id : '';
  bindings.unshift({ value: '', disabled: false, label: t('保留当前配置', 'Keep current configuration') });
  if (!selected)
    bindings.splice(1, 0, {
      value: 'current',
      disabled: false,
      label: t('当前已保存的配置', 'Current saved configuration'),
    });
  return (
    <div className="space-y-2">
      <SelectField label={t('使用工具', 'Tool')} value={harness?.id ?? ''} options={choices} onChange={choose} />
      {selected?.kind === 'binding' && (
        <p className="text-sm text-cafe-secondary">
          {t(
            '当前接入参数已保留，选择同一工具不会重置配置。',
            'Current launch settings are preserved. Selecting the same tool keeps them.',
          )}
        </p>
      )}
      <details className="text-sm text-cafe-secondary">
        <summary className="min-h-10 cursor-pointer py-2">
          {t('插件与已有接入配置', 'Plugins and existing configurations')}
        </summary>
        <SelectField
          label={t('接入配置', 'Connection configuration')}
          value={selected ? currentBinding : 'current'}
          options={bindings}
          onChange={choose}
        />
      </details>
    </div>
  );
}
