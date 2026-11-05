import { messageMediaItemSelectorSchema, type ThreadArtifactDTO, type ThreadArtifactType } from '@cat-cafe/shared';

function encodedId(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

/**
 * HTML widget 的稳定身份：源消息 + 块 id。
 *
 * 不能沿用 legacy tuple：它把 `createdAt` / `name` 编进身份，两条同名 HTML 在同一消息里
 * 会得到同一个 key，卡片、打开位置和返回位置都撞在一起。坐标形态只含定位，不含正文。
 */
export function widgetArtifactObjectId(
  artifact: Pick<ThreadArtifactDTO, 'sourceMessageId' | 'widgetBlockId'>,
): string | null {
  if (!artifact.sourceMessageId || !artifact.widgetBlockId) return null;
  return encodedId(['widget', artifact.sourceMessageId, artifact.widgetBlockId]);
}

export function artifactObjectId(artifact: ThreadArtifactDTO): string {
  const widgetId = widgetArtifactObjectId(artifact);
  if (widgetId) return widgetId;
  if (artifact.publicationItem) return encodedId([legacyArtifactObjectId(artifact), artifact.publicationItem]);
  return legacyArtifactObjectId(artifact);
}

/** Old persisted F232 targets did not include the selector. Resolve only when uniquely matched. */
export function legacyArtifactObjectId(artifact: ThreadArtifactDTO): string {
  return encodedId([
    artifact.type,
    artifact.ref ?? null,
    artifact.url ?? null,
    artifact.sourceMessageId,
    artifact.createdAt,
    artifact.name,
  ]);
}

const ARTIFACT_TYPES = new Set<ThreadArtifactType>(['image', 'file', 'code', 'pr', 'audio', 'video', 'widget']);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

function parseLegacyTuple(value: unknown): ThreadArtifactDTO | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [type, ref, url, sourceMessageId, createdAt, name] = value;
  if (
    typeof type !== 'string' ||
    !ARTIFACT_TYPES.has(type as ThreadArtifactType) ||
    !nullableString(ref) ||
    !nullableString(url) ||
    !nullableString(sourceMessageId) ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof name !== 'string'
  )
    return null;
  return {
    type: type as ThreadArtifactType,
    name,
    createdAt,
    sourceMessageId,
    catId: null,
    ...(ref !== null ? { ref } : {}),
    ...(url !== null ? { url } : {}),
  };
}

/** 同一件 widget 的稳定坐标；用于旧 objectId（legacy tuple 形态）按坐标回落。 */
export function sameWidgetCoordinate(
  artifact: ThreadArtifactDTO,
  coordinate: { sourceMessageId: string; blockId: string },
): boolean {
  return (
    artifact.type === 'widget' &&
    artifact.sourceMessageId === coordinate.sourceMessageId &&
    artifact.widgetBlockId === coordinate.blockId
  );
}

function parseWidgetTuple(value: unknown): ThreadArtifactDTO | null {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'widget') return null;
  const [, sourceMessageId, widgetBlockId] = value;
  if (typeof sourceMessageId !== 'string' || !sourceMessageId) return null;
  if (typeof widgetBlockId !== 'string' || !widgetBlockId) return null;
  return {
    type: 'widget',
    // 身份只由坐标决定；名字与时间不参与，这里也不假装知道它们。
    name: '',
    catId: null,
    createdAt: 0,
    sourceMessageId,
    widgetBlockId,
  };
}

/** Shape/codec admission only: the owner catalogue still proves which actual card or content exists. */
export function parseArtifactObjectId(key: unknown): ThreadArtifactDTO | null {
  if (typeof key !== 'string') return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(key));
    let artifact = parseWidgetTuple(value) ?? parseLegacyTuple(value);
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
      const legacy = parseLegacyTuple(JSON.parse(decodeURIComponent(value[0])));
      const item = messageMediaItemSelectorSchema.safeParse(value[1]);
      if (!legacy || !item.success) return null;
      artifact = { ...legacy, publicationItem: value[1] as typeof item.data };
    }
    return artifact && artifactObjectId(artifact) === key ? artifact : null;
  } catch {
    return null;
  }
}
