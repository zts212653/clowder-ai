import type { A2ARoutingProjection, CatConfig, CatId } from '@cat-cafe/shared';

type HandoffCatConfig = Pick<CatConfig, 'displayName' | 'variantLabel'>;

export function formatA2AHandoffCatLabel(catId: CatId | string, config?: HandoffCatConfig): string {
  const displayName = config?.displayName?.trim() || catId;
  const qualifier = config?.variantLabel?.trim() || (displayName !== catId ? catId : '');
  return qualifier ? `${displayName}(${qualifier})` : displayName;
}

/**
 * F086/F216: the arrow glyph IS part of the honesty contract.
 * `→` reads as "the ball moved here"; drawing it twice at the same millisecond for a
 * sequential worklist is what made #1291's two-target dispatch look like a fan-out.
 * A queued serial leg uses `⇢` (dashed = not started yet); parallel legs use `⇉`.
 */
function handoffArrow(projection: A2ARoutingProjection | undefined): string {
  if (!projection || projection.total <= 1) return '→';
  if (projection.mode === 'parallel') return '⇉';
  return projection.index <= 1 ? '→' : '⇢';
}

function handoffSuffix(projection: A2ARoutingProjection | undefined): string {
  if (!projection || projection.total <= 1) return '';
  if (projection.mode === 'parallel') return `（并行 ${projection.index}/${projection.total}）`;
  return projection.index <= 1
    ? `（串行 ${projection.index}/${projection.total}）`
    : `（串行 ${projection.index}/${projection.total}·排队中）`;
}

export function formatA2AHandoffContent(
  fromCatId: CatId | string,
  toCatId: CatId | string,
  fromConfig?: HandoffCatConfig,
  toConfig?: HandoffCatConfig,
  projection?: A2ARoutingProjection,
): string {
  const from = formatA2AHandoffCatLabel(fromCatId, fromConfig);
  const to = formatA2AHandoffCatLabel(toCatId, toConfig);
  return `${from} ${handoffArrow(projection)} ${to}${handoffSuffix(projection)}`;
}

/**
 * Non-silent diagnostic for the legacy "several plain line-start @" shape.
 *
 * Requirement 4 of the field report: legacy multi-@ must not keep silently impersonating
 * parallel. We do NOT reject it (the @-chain relay convention depends on it) and we do NOT
 * read the prose for the word "并行" — we normalize it to the semantics the runtime already
 * executes (serial) and say so out loud, with the structured escape hatch named.
 */
export function formatSerialMultiTargetNotice(
  order: Array<{ catId: CatId | string; config?: HandoffCatConfig }>,
): string {
  const legs = order.map((t, i) => `第 ${i + 1} 棒 ${formatA2AHandoffCatLabel(t.catId, t.config)}`).join(' → ');
  return [
    `本回合有 ${order.length} 个行首 @ 目标，已按 **串行（serial）** 调度：${legs}。`,
    '行首 @mention 在 runtime 里是一条有序 worklist —— 第 2 棒要等第 1 棒整个回合结束才会拿到 invocation，正文写"并行"不会改变调度。',
    '需要真正的并行 fan-out（每个目标各自拿到 invocation/Queue custody、互不阻塞）请显式调用 `cat_cafe_multi_mention(mode="parallel", parallelIntent=...)`。',
  ].join('\n');
}
