'use client';

import { formatCatName, useCatData } from '@/hooks/useCatData';
import { catColorMix, catColorVar } from '@/lib/cat-slug';

interface CatSelectorProps {
  selectedCats: string[];
  onSelectionChange: (ids: string[]) => void;
}

/**
 * F32-b Phase 3: Breed-grouped cat chip selector.
 * Used in thread creation (DirectoryPickerModal) and thread settings.
 */
export function CatSelector({ selectedCats, onSelectionChange }: CatSelectorProps) {
  const { getCatsByBreed } = useCatData();
  const groups = getCatsByBreed();

  const toggleCat = (catId: string) => {
    if (selectedCats.includes(catId)) {
      onSelectionChange(selectedCats.filter((id) => id !== catId));
    } else {
      onSelectionChange([...selectedCats, catId]);
    }
  };

  // Client display name mapping
  const clientIdLabel = (clientId: string) => {
    const map: Record<string, string> = {
      anthropic: 'Anthropic',
      openai: 'OpenAI',
      google: 'Google',
    };
    return map[clientId] ?? clientId;
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-cafe-secondary font-medium">默认猫猫 (可选)</div>
      {[...groups.entries()].map(([breedId, cats]) => {
        const breedName = cats[0].breedDisplayName ?? cats[0].displayName;
        return (
          <div key={breedId}>
            <div className="text-micro text-cafe-muted mb-1">
              {breedName}家族 · {clientIdLabel(cats[0].clientId)}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cats.map((cat) => {
                const isSelected = selectedCats.includes(cat.id);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => toggleCat(cat.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors border ${
                      isSelected
                        ? 'font-medium border-current'
                        : 'border-cafe text-cafe-secondary hover:border-[var(--console-border-strong)]'
                    }`}
                    style={
                      isSelected
                        ? {
                            color: catColorVar(cat.id, 'primary'),
                            backgroundColor: catColorMix(cat.id, 0.1, 'primary'),
                            borderColor: catColorVar(cat.id, 'primary'),
                          }
                        : undefined
                    }
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: catColorVar(cat.id, 'primary') }}
                    />
                    {formatCatName(cat)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
