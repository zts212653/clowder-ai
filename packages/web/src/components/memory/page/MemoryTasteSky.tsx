import Image from 'next/image';

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
}: {
  expanded: boolean;
  countText: string;
  toggle: () => void;
}) {
  return (
    <section
      className={`relative -mx-4 -mt-4 bg-cover bg-center md:-mx-8 md:-mt-8 ${expanded ? 'h-72' : 'h-16'}`}
      style={{ backgroundImage: `url('/memory-sky/${expanded ? 'dome-hero.jpg' : 'dome-strip.jpg'}')` }}
      data-testid="taste-dome"
      data-expanded={expanded}
      aria-label="主星书房"
    >
      <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 p-4 text-neutral-50 md:px-8">
        <h1 className="text-display-sm font-serif">主星书房</h1>
        <button type="button" onClick={toggle} className="rounded-lg border border-neutral-50 px-3 py-1 text-compact">
          {expanded ? '收起穹顶' : '展开穹顶'}
        </button>
      </div>
      {expanded && (
        <div className="absolute inset-x-4 top-16 grid grid-cols-6 gap-2 text-center text-neutral-50 md:inset-x-32 md:gap-6">
          {TYPES.map((type) => (
            <div key={type.id} className={type.id === 'taste' ? '' : 'opacity-70'}>
              <Image
                src={`/memory-sky/constellations/${type.id}.png`}
                alt=""
                width={80}
                height={80}
                className={`mx-auto object-contain ${type.id === 'taste' ? 'h-16 w-16' : 'h-12 w-12'}`}
              />
              <p className="mt-1 text-compact">{type.label}</p>
              <p className="text-xs">{type.id === 'taste' ? countText : '还没接进来'}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
