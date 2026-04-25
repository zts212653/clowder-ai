'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

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
    return <p className="py-8 text-center text-sm text-gray-400">加载角色模板中...</p>;
  }

  if (templates.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-400">暂无可用角色模板</p>;
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-gray-700">选择一个角色模板</h4>
      <p className="mb-4 text-xs text-gray-500">每只猫猫都有自己的性格和特长，选一只你喜欢的！</p>
      <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setSelected(t.id);
              onSelect(t);
            }}
            className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${
              selected === t.id
                ? 'border-amber-400 bg-amber-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-amber-200 hover:bg-amber-50/30'
            }`}
          >
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
              style={{ backgroundColor: t.color.secondary, color: t.color.primary }}
            >
              {t.nickname?.charAt(0) ?? t.name.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-900">{t.name}</span>
                {t.nickname && <span className="text-xs text-gray-400">{t.nickname}</span>}
              </div>
              <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{t.roleDescription}</p>
              <p className="mt-0.5 line-clamp-1 text-xs text-gray-400">{t.personality}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
