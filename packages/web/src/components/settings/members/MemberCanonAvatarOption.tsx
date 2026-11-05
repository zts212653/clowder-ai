import type { AssetCanonItem } from '@cat-cafe/shared';
import { canonAssetUrl } from '@/components/workbench/content-review/asset-canon-client';
import { canonActor } from '@/components/workbench/content-review/asset-canon-presentation';

export function MemberCanonAvatarOption({
  item,
  name,
  selected,
  current,
  onSelect,
}: {
  item: AssetCanonItem;
  name: string;
  selected: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  const record = item.record;
  const stem = record.name
    .split('/')
    .at(-1)!
    .replace(/\.(png|jpe?g|webp|avif|gif)$/i, '');
  const title = /[\u3400-\u9fff\s]/.test(stem)
    ? stem
    : /[/\\]|\.(png|jpe?g|webp|avif|gif)$/i.test(record.name)
      ? `${name}的头像`
      : record.name;
  const origin = record.version.origin;
  const uploaded = record.evidenceRefs?.some((ref) => ref.startsWith('human-upload:'));
  const source = uploaded
    ? `${canonActor(record.creator)}上传`
    : origin.actor
      ? `${canonActor(origin.actor)}${origin.kind === 'created' ? '创作' : '导入'}`
      : `${canonActor(record.creator)}收录`;
  const sourceAt = uploaded || !origin.actor ? record.createdAt : origin.at;
  return (
    <button type="button" aria-pressed={selected} className="w-28 space-y-1 text-center text-xs" onClick={onSelect}>
      {/* biome-ignore lint/performance/noImgElement: permission-checked API bytes are not public optimizer inputs. */}
      <img
        src={canonAssetUrl(item, '')}
        alt=""
        className={`mx-auto h-20 w-20 rounded-full border object-cover ${selected ? 'outline outline-2 outline-cafe-accent' : ''}`}
      />
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        {selected ? (
          <span className="shrink-0 text-cafe-accent" aria-hidden="true">
            ✓
          </span>
        ) : null}
      </span>
      <span className="block text-cafe-muted">
        {source} · {sourceAt.slice(5, 10)}
      </span>
      {current ? <span className="block text-cafe-accent">现在用的</span> : null}
    </button>
  );
}
