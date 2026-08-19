'use client';

import { useEffect, useState } from 'react';
import { ExpandableProse } from '@/components/content-overflow';
import { apiFetch } from '@/utils/api-client';
import { isRowPrimaryActionTarget } from '@/utils/row-primary-action';

export interface TemplateCard {
  id: string;
  name: string;
  nickname?: string;
  avatar: string;
  color: { primary: string; secondary: string };
  roleDescription: string;
  personality: string;
  teamStrengths?: string;
}

interface TemplateStepProps {
  onSelect: (template: TemplateCard) => void;
}

export function TemplateStep({ onSelect }: TemplateStepProps) {
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/cat-templates')
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load templates');
        return (await res.json()) as { templates?: TemplateCard[] };
      })
      .then((body) => {
        if (!cancelled) setTemplates(body.templates ?? []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="py-8 text-center text-sm text-cafe-muted">加载角色模板中...</p>;
  }

  if (templates.length === 0) {
    return <p className="py-8 text-center text-sm text-cafe-muted">暂无可用角色模板</p>;
  }

  const selectTemplate = (template: TemplateCard) => {
    setSelected(template.id);
    onSelect(template);
  };

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-cafe-secondary">选择一个角色模板</h4>
      <p className="mb-4 text-xs text-cafe-muted">每只猫猫都有自己的性格和特长，选一只你喜欢的！</p>
      <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
        {templates.map((t) => (
          // biome-ignore lint/a11y: the nested native button owns keyboard/screen-reader semantics; the wrapper restores the surrounding pointer hit area
          <div
            key={t.id}
            onClick={(event) => {
              if (isRowPrimaryActionTarget(event.target, event.currentTarget)) selectTemplate(t);
            }}
            className={`cursor-pointer rounded-xl border p-3 transition ${
              selected === t.id
                ? 'border-[var(--semantic-warning)] bg-conn-amber-bg shadow-sm'
                : 'border-[var(--console-border-soft)] bg-cafe-surface-canvas hover:border-conn-amber-ring hover:bg-conn-amber-bg/30'
            }`}
          >
            <button
              type="button"
              onClick={() => selectTemplate(t)}
              aria-pressed={selected === t.id}
              className="flex w-full items-start gap-3 text-left"
            >
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
                style={{ backgroundColor: t.color.secondary, color: t.color.primary }}
              >
                {t.nickname?.charAt(0) ?? t.name.charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-cafe">{t.name}</span>
                  {t.nickname && <span className="text-xs text-cafe-muted">{t.nickname}</span>}
                </div>
              </div>
              <span
                data-selection-indicator
                aria-hidden="true"
                className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  selected === t.id
                    ? 'border-[var(--semantic-warning)] bg-[var(--semantic-warning)] text-cafe-surface'
                    : 'border-cafe text-transparent'
                }`}
              >
                {selected === t.id && (
                  <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </span>
            </button>
            <div className="ml-[52px] mt-1 space-y-1">
              <ExpandableProse
                text={t.roleDescription}
                lines={2}
                contentClassName="text-xs leading-4 text-cafe-muted"
              />
              <ExpandableProse text={t.personality} lines={2} contentClassName="text-xs leading-4 text-cafe-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
