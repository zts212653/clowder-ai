// F200 Phase C: Graph edge-level weights for traversal scoring

export interface EdgeWeight {
  typeBase: number;
  traversalBoost: number;
  recencyDecay: number;
  total: number;
}

const TYPE_BASE: Record<string, number> = {
  wikilink: 1.0,
  doc_link: 0.9,
  feature_ref: 1.1,
  related_to: 0.8,
  evolved_from: 1.0,
  blocked_by: 0.7,
};

const LAMBDA_EDGE = 0.05;
const EDGE_DECAY_T = 30;

export function computeEdgeWeight(
  relation: string,
  traversalCount30d: number,
  daysSinceLastTraversal: number | null,
): EdgeWeight {
  const typeBase = TYPE_BASE[relation] ?? 1.0;
  const recencyDecay = daysSinceLastTraversal == null ? 0 : EDGE_DECAY_T / (EDGE_DECAY_T + daysSinceLastTraversal);
  const traversalBoost = LAMBDA_EDGE * traversalCount30d * recencyDecay;
  return { typeBase, traversalBoost, recencyDecay, total: typeBase + traversalBoost };
}
