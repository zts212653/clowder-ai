import Image from 'next/image';
import { MEMORY_FAMILIES, type MemoryFamily } from './memory-family';

const TYPES = [
  { id: 'event', label: '事件' },
  { id: 'meeting', label: '会议' },
  { id: 'profile', label: '画像' },
  { id: 'taste', label: '品味' },
  { id: 'person', label: '人物' },
  { id: 'entity', label: '实体' },
];
export function MemoryTasteSky({
  expanded,
  countText,
  toggle,
  peopleSummary = '可查看',
  onSelect,
  summaries = {},
}: {
  expanded: boolean;
  countText: string;
  toggle: () => void;
  peopleSummary?: string;
  onSelect?: (type: MemoryFamily) => void;
  summaries?: Partial<Record<string, string>>;
}) {
  return (
    <section
      className={`relative -mx-4 -mt-4 bg-cover bg-center md:-mx-8 md:-mt-8 ${expanded ? 'h-72' : 'h-16'}`}
      style={{ backgroundImage: `url('/memory-sky/${expanded ? 'dome-hero.jpg' : 'dome-strip.jpg'}')` }}
      data-testid="taste-dome"
      data-expanded={expanded}
      aria-label="主星书房"
    >
      <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 p-4 text-[var(--cafe-image-foreground)] md:px-8">
        <h1 className="text-display-sm font-serif">主星书房</h1>
        <button
          type="button"
          onClick={toggle}
          className="rounded-lg border border-[var(--cafe-image-foreground)] px-3 py-1 text-compact"
        >
          {expanded ? '收起穹顶' : '展开穹顶'}
        </button>
      </div>
      {expanded && (
        <div className="absolute inset-x-4 top-16 grid grid-cols-6 gap-2 text-center text-[var(--cafe-image-foreground)] md:inset-x-32 md:gap-6">
          {TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              aria-label={`${type.label}记忆`}
              disabled={type.id === 'meeting'}
              onClick={() => {
                const family = MEMORY_FAMILIES.find((item) => item.sky === type.id);
                if (family) onSelect?.(family.id);
              }}
              className={type.id === 'meeting' ? 'opacity-70' : ''}
            >
              <Image
                src={`/memory-sky/constellations/${type.id}.png`}
                alt=""
                width={80}
                height={80}
                className={`mx-auto object-contain ${type.id === 'taste' ? 'h-16 w-16' : 'h-12 w-12'}`}
              />
              <p className="mt-1 text-compact">{type.label}</p>
              <p className="text-xs">
                {type.id === 'taste'
                  ? countText
                  : type.id === 'person'
                    ? peopleSummary
                    : type.id === 'meeting'
                      ? '还没接进来'
                      : summaries[type.id] || '可查看'}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
