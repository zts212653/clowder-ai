'use client';

export interface EvidenceFlag {
  name: string;
  defaultValue: string;
  description: string;
  currentValue: string | null;
  allowedValues?: string[];
  /** Hub writes are opt-in; absence says nothing about the effective config owner. */
  runtimeEditable?: boolean;
  restartRequired?: boolean;
}

function readOnlyFlagGuidance(name: string): string {
  if (name === 'EMBED_MODE') {
    return '向量检索由本页“语义搜索服务”管理；off 不会停用已启用的服务。';
  }
  if (name === 'F102_ABSTRACTIVE') {
    return '这里只显示启动初始值；实际状态以本页“记忆整理”的持久开关为准。';
  }
  return '只读配置，请在对应功能的设置或启动配置中管理。';
}

export function EvidenceFeatureFlag({
  flag,
  updating,
  onCycle,
}: {
  flag: EvidenceFlag;
  updating: boolean;
  onCycle: (name: string, value: string | null, allowedValues?: string[]) => void;
}) {
  const isEditable = flag.runtimeEditable === true;
  const isOn = flag.currentValue === 'on';
  const hasMultiValues = flag.allowedValues && flag.allowedValues.length > 2;
  const isUpdating = updating;
  const current = flag.currentValue ?? flag.defaultValue;
  return (
    <div className="flex items-center justify-between rounded-lg px-2 py-2">
      <div className="min-w-0 flex-1 pr-3">
        <div className="break-words text-xs font-medium text-cafe-black">{flag.name}</div>
        <div className="text-micro text-cafe-secondary">{flag.description}</div>
        {!isEditable && <p className="text-micro text-cafe-secondary">{readOnlyFlagGuidance(flag.name)}</p>}
        {flag.restartRequired && <p className="text-micro text-cafe-secondary">修改后需重启</p>}
      </div>
      {!isEditable ? (
        <span
          data-testid={`feature-readonly-${flag.name}`}
          className="shrink-0 rounded bg-[var(--console-field-bg)] px-2 py-0.5 text-micro font-medium text-cafe-secondary"
        >
          {current} · 只读
        </span>
      ) : hasMultiValues ? (
        <button
          type="button"
          aria-label={`${flag.name}: ${current}`}
          data-testid={`feature-cycle-${flag.name}`}
          disabled={isUpdating}
          onClick={() => onCycle(flag.name, flag.currentValue, flag.allowedValues)}
          className={`rounded px-2 py-0.5 text-micro font-medium transition-colors ${
            current === 'on' || current === 'apply'
              ? 'bg-cafe-accent text-[var(--cafe-surface)] hover:bg-cafe-accent-hover'
              : current === 'off'
                ? 'bg-[var(--console-field-bg)] text-cafe-secondary hover:bg-[var(--console-hover-bg)]'
                : 'bg-conn-amber-bg text-conn-amber-text hover:opacity-80'
          } ${isUpdating ? 'opacity-50' : ''}`}
          title={`点击切换: ${flag.allowedValues?.join(' → ')}`}
        >
          {current}
        </button>
      ) : (
        <button
          type="button"
          aria-label={flag.name}
          aria-pressed={isOn}
          data-testid={`feature-toggle-${flag.name}`}
          disabled={isUpdating}
          onClick={() => onCycle(flag.name, flag.currentValue)}
          className={`relative h-5 w-9 rounded-full transition-colors ${isOn ? 'bg-cafe-accent' : 'bg-[var(--console-field-bg)]'} ${isUpdating ? 'opacity-50' : ''}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-[var(--cafe-surface)] shadow transition-transform ${isOn ? 'translate-x-4' : ''}`}
          />
        </button>
      )}
    </div>
  );
}
