/**
 * F245 Phase B Task 5 — Eval 域采集器 EvalDomainAdapter
 *
 * 扫 <feedbackRoot>/bundles/<verdictId>/snapshot.json，把每个 component 的 frictionCounts 中
 * 非零非 null 的 metric 列成 FrictionSignal（聚合 proxy，severity='low'，非单事件）。
 * 只读文件系统（KD-4），纯 pull 无持久状态。幂等靠 deterministic id
 * （`eval-domain:${verdictId}#${componentId}#${metric}`）。窗口按 snapshot.generatedAt 半开过滤。
 *
 * snapshot.json 真实 schema 对齐 eval-a2a-artifact-resolver 的 bundleSnapshotSchema：
 * { verdictId, generatedAt(ISO+offset), components: [{ componentId|id, componentName|name,
 *   frictionCounts: Record<string, number|null>, ... }] }。component 支持 id/name 别名（同 resolver transform）。
 * 防御性提取（不 throw）：read-model 跨历史 bundle，单个畸形 snapshot 跳过不整体失败。
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrictionSignal } from '@cat-cafe/shared';
import type { IFrictionSignalSource } from './friction-signal-source.js';

interface RawSnapshot {
  verdictId: string;
  featureId?: string;
  generatedAt: string;
  components: unknown[];
}

export class EvalDomainAdapter implements IFrictionSignalSource {
  readonly channelId = 'eval-domain' as const;

  private readonly excludeFeatureIds: ReadonlySet<string>;

  constructor(
    private readonly feedbackRoot: string,
    opts?: { readonly excludeFeatureIds?: ReadonlySet<string> },
  ) {
    this.excludeFeatureIds = opts?.excludeFeatureIds ?? new Set<string>();
  }

  async pull(sinceMs: number, untilMs: number): Promise<FrictionSignal[]> {
    const bundlesDir = join(this.feedbackRoot, 'bundles');
    if (!existsSync(bundlesDir)) return [];
    const signals: FrictionSignal[] = [];
    for (const entry of safeReaddir(bundlesDir)) {
      if (!entry.isDirectory()) continue;
      const snapshot = readSnapshot(join(bundlesDir, entry.name, 'snapshot.json'));
      if (!snapshot) continue;
      // F245 PR1b R1 (self-exclusion @gpt52): skip bundles produced by an excluded feature.
      // friction 的 eval-domain channel 不吃自己 domain 产出的 bundle，否则 enabled:true 后
      // friction bundle 的 frictionCounts 会被下一轮当新 signal 吃回，跨 run 自放大。
      if (snapshot.featureId && this.excludeFeatureIds.has(snapshot.featureId)) continue;
      const genMs = Date.parse(snapshot.generatedAt);
      if (!Number.isFinite(genMs) || genMs < sinceMs || genMs >= untilMs) continue;
      collectSnapshotSignals(snapshot, signals);
    }
    return signals;
  }
}

// ---- 文件系统读取（防御性） ----

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readSnapshot(path: string): RawSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const verdictId = asStr(parsed.verdictId);
  const generatedAt = asStr(parsed.generatedAt);
  if (!verdictId || !generatedAt) return null;
  const featureId = asStr(parsed.featureId);
  return { verdictId, featureId, generatedAt, components: Array.isArray(parsed.components) ? parsed.components : [] };
}

// ---- snapshot → FrictionSignal 映射 ----

function collectSnapshotSignals(snapshot: RawSnapshot, out: FrictionSignal[]): void {
  for (const raw of snapshot.components) {
    if (!isRecord(raw)) continue;
    const componentId = asStr(raw.componentId) ?? asStr(raw.id);
    if (!componentId) continue;
    const componentName = asStr(raw.componentName) ?? asStr(raw.name) ?? componentId;
    const frictionCounts = isRecord(raw.frictionCounts) ? raw.frictionCounts : {};
    for (const [metric, value] of Object.entries(frictionCounts)) {
      if (typeof value !== 'number' || value === 0) continue; // 非零非 null
      out.push(buildSignal(snapshot, componentId, componentName, metric, value));
    }
  }
}

function buildSignal(
  snapshot: RawSnapshot,
  componentId: string,
  componentName: string,
  metric: string,
  count: number,
): FrictionSignal {
  const ref = `${snapshot.verdictId}#${componentId}#${metric}`;
  return {
    id: `eval-domain:${ref}`,
    channel: 'eval-domain',
    timestamp: snapshot.generatedAt,
    tool: componentId,
    symptom: `${metric}=${count}`,
    rawRef: ref,
    severity: 'low',
    sourceEvidence: `${componentName}: ${metric}=${count}`,
  };
}

// ---- helpers ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
