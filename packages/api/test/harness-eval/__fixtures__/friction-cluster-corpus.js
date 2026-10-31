/**
 * F245 Phase B Task 9 — 误聚合 corpus（AC-B2 gate ground truth）
 *
 * 每条 signal 标注 ground-truth `group`（应归属的 cluster）。gate 断言：
 *   ① 同类噪音 ×N → 聚成 1 cluster   ② 不同问题 → 不互聚
 *   ③ 跨通道同问题 → 1 cluster 多 channel ④ 元引用 → intent filter 剔除，不产 cluster
 *   误聚合率=0：任一输出 cluster 的成员不得跨 group。
 *
 * 注：跨通道条目用相同 tool+symptom（合成）以触发 rule 层 channel 合并——测的是 clusterer 的
 * 通道折叠机制，各 adapter 真实格式在其单测覆盖。`__dropped__` group 期望被 aggregator 剔除。
 */

const BASE = { timestamp: '2026-06-19T10:00:00.000Z', severity: 'medium' };

/** @type {Array<{ group: string, signal: object }>} */
export const FRICTION_CLUSTER_CORPUS = [
  // ① 同类噪音 ×N + ③ 跨通道 → 1 cluster（count 4，channels 多值）
  {
    group: 'rg-noise',
    signal: { ...BASE, id: 'pf:rg1', channel: 'paw-feel', tool: 'rg', symptom: '噪音大', rawRef: 'm1#0' },
  },
  {
    group: 'rg-noise',
    signal: { ...BASE, id: 'pf:rg2', channel: 'paw-feel', tool: 'rg', symptom: '噪音大', rawRef: 'm2#0' },
  },
  {
    group: 'rg-noise',
    signal: { ...BASE, id: 'cx:rg3', channel: 'cancel', tool: 'rg', symptom: '噪音大', rawRef: '301' },
  },
  {
    group: 'rg-noise',
    signal: { ...BASE, id: 'uf:rg4', channel: 'user-feedback', tool: 'rg', symptom: '噪音大', rawRef: 'fi_x' },
  },

  // ② 不同问题 → 独立 cluster（count 2）
  {
    group: 'disk-full',
    signal: { ...BASE, id: 'ed:df1', channel: 'eval-domain', tool: 'df', symptom: 'disk full', rawRef: 'v#C#df' },
  },
  {
    group: 'disk-full',
    signal: { ...BASE, id: 'pf:df2', channel: 'paw-feel', tool: 'df', symptom: 'disk full', rawRef: 'm9#0' },
  },

  // ② 另一独立问题（singleton）
  {
    group: 'hold-ball',
    signal: { ...BASE, id: 'pf:hb1', channel: 'paw-feel', tool: 'hold_ball', symptom: '重复唤醒', rawRef: 'm7#0' },
  },

  // ④ 元引用（引 lessons 文件）→ aggregator intent filter 剔除，不产 cluster
  {
    group: '__dropped__',
    signal: {
      ...BASE,
      id: 'pf:meta',
      channel: 'paw-feel',
      symptom: 'feedback_workflow_preferences 的例子',
      rawRef: 'm8#0',
    },
  },
];

/** ground-truth group lookup by signalId。 */
export function groupOfSignal(signalId) {
  const entry = FRICTION_CLUSTER_CORPUS.find((e) => e.signal.id === signalId);
  return entry ? entry.group : undefined;
}

/** corpus 中应被剔除（非真摩擦）的 signalId 集合。 */
export const DROPPED_SIGNAL_IDS = FRICTION_CLUSTER_CORPUS.filter((e) => e.group === '__dropped__').map(
  (e) => e.signal.id,
);

/** 取某通道的 corpus signals（喂对应 stub source）。 */
export function corpusSignalsForChannel(channel) {
  return FRICTION_CLUSTER_CORPUS.filter((e) => e.signal.channel === channel).map((e) => e.signal);
}

/** corpus 涉及的全部通道。 */
export const CORPUS_CHANNELS = [...new Set(FRICTION_CLUSTER_CORPUS.map((e) => e.signal.channel))];
