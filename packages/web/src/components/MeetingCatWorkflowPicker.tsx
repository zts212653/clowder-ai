'use client';

import { formatCatName, useCatData } from '@/hooks/useCatData';
import { catColorMix, catColorVar } from '@/lib/cat-slug';

interface MeetingCatWorkflowPickerProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (catId: string) => void;
}

export function MeetingCatWorkflowPicker({ value, disabled, onChange }: MeetingCatWorkflowPickerProps) {
  const { cats, isLoading } = useCatData();
  const availableCats = cats.filter((cat) => cat.roster?.available !== false);

  return (
    <div className="space-y-1.5" data-testid="meeting-workflow-cat-picker">
      <p className="text-micro font-medium">由哪只猫负责整理</p>
      {isLoading && availableCats.length === 0 ? (
        <p className="text-micro text-cafe-secondary">正在读取可用猫猫…</p>
      ) : availableCats.length === 0 ? (
        <p className="text-micro text-[var(--semantic-error)]">当前没有可用猫猫，稍后可在这里继续。</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="负责整理的猫猫">
          {availableCats.map((cat) => {
            const selected = cat.id === value;
            return (
              <button
                key={cat.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onChange(cat.id)}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-micro transition-colors disabled:opacity-50"
                style={
                  selected
                    ? {
                        color: catColorVar(cat.id, 'primary'),
                        backgroundColor: catColorMix(cat.id, 0.1, 'primary'),
                        borderColor: catColorVar(cat.id, 'primary'),
                      }
                    : undefined
                }
                data-testid={`meeting-workflow-cat-${cat.id}`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: catColorVar(cat.id, 'primary') }}
                />
                {formatCatName(cat)}
              </button>
            );
          })}
        </div>
      )}
      <p className="text-micro text-cafe-secondary">会把这只猫写入保存位置，不会替你猜。</p>
    </div>
  );
}
