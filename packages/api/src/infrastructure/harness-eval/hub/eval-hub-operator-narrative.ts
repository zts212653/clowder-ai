export type EvalHubVerdictValue = 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
export type EvalEvidenceQuality = 'insufficient' | 'usable';

interface NarrativeComponent {
  confidence: string;
  activationCounts: Record<string, number | null>;
  frictionCounts: Record<string, number | null>;
}

interface NarrativeFinding {
  frictionSignal?: {
    type: string;
    severity: string;
    confidence: number;
  };
}

interface NarrativeGlossaryEntry {
  label: string;
  means: string;
  goodDirection: 'higher' | 'lower' | 'neutral';
}

export interface EvalHubOperatorNarrativeInput {
  verdict: EvalHubVerdictValue;
  domainDescription: string;
  featureId: string;
  snapshot: {
    window: { durationHours: number };
    components: NarrativeComponent[];
  };
  attribution: {
    findings: NarrativeFinding[];
    noFindingRecord?: { reason: string; evidence: string };
  };
  metricGlossary?: Record<string, NarrativeGlossaryEntry>;
  stale: boolean;
}

export interface EvalHubOperatorNarrative {
  headline: string;
  summary: string;
  action: string;
  nextCheck: string;
  evidenceQuality: EvalEvidenceQuality;
}

export function synthesizeEvalHubOperatorNarrative(input: EvalHubOperatorNarrativeInput): EvalHubOperatorNarrative {
  const evidenceQuality = deriveEvidenceQuality(input);
  const findingCount = input.attribution.findings.length;
  return {
    headline: buildHeadline(input.verdict, findingCount, evidenceQuality),
    summary: buildSummary(input, evidenceQuality),
    action: buildAction(input.verdict, input.featureId, evidenceQuality, findingCount),
    nextCheck: synthesizeEvalHubNextCheck(input.verdict, input.stale, evidenceQuality),
    evidenceQuality,
  };
}

function deriveEvidenceQuality(input: EvalHubOperatorNarrativeInput): EvalEvidenceQuality {
  if (input.attribution.findings.length > 0) return 'usable';
  if (!input.attribution.noFindingRecord) return 'insufficient';
  if (input.snapshot.components.length === 0) return 'insufficient';
  const hasUsableComponent = input.snapshot.components.some(
    (component) =>
      (component.confidence === 'medium' || component.confidence === 'high') && hasObservedCount(component),
  );
  return hasUsableComponent ? 'usable' : 'insufficient';
}

function hasObservedCount(component: NarrativeComponent): boolean {
  return [...Object.values(component.activationCounts), ...Object.values(component.frictionCounts)].some(
    (count) => count !== null && Number.isFinite(count) && count > 0,
  );
}

function buildHeadline(
  verdict: EvalHubVerdictValue,
  findingCount: number,
  evidenceQuality: EvalEvidenceQuality,
): string {
  if (verdict === 'delete_sunset') return '这项评估可能可以停用';
  if (verdict === 'build') return '现有能力不够，需要补一项能力';
  if (verdict === 'fix') return findingCount > 0 ? `发现 ${findingCount} 个需要修复的问题` : '发现需要修复的问题';
  if (evidenceQuality === 'insufficient') return '这轮数据还不够，先别下结论';
  if (findingCount > 0) return `发现 ${findingCount} 个线索，但证据还不够定案`;
  return '这轮没有发现要处理的问题';
}

function buildSummary(input: EvalHubOperatorNarrativeInput, evidenceQuality: EvalEvidenceQuality): string {
  const subject = stripTrailingPunctuation(input.domainDescription);
  if (evidenceQuality === 'insufficient') {
    return `这次检查的是「${subject}」。采样了 ${formatHours(input.snapshot.window.durationHours)}，但只有低置信度或没有有效事件，所以现在还判断不了好坏。`;
  }
  const findingCount = input.attribution.findings.length;
  if (findingCount === 0) {
    return `这次检查的是「${subject}」。本轮数据可用，没有发现达到处理门槛的问题。`;
  }
  const metricLabel = resolvePrimaryMetricLabel(input);
  const focus = metricLabel ? `，主要是「${metricLabel}」` : '';
  if (input.verdict === 'keep_observe') {
    return `这次检查的是「${subject}」。发现 ${findingCount} 个线索${focus}，但当前证据只够继续观察。`;
  }
  return `这次检查的是「${subject}」。发现 ${findingCount} 个需要处理的线索${focus}。`;
}

function buildAction(
  verdict: EvalHubVerdictValue,
  featureId: string,
  evidenceQuality: EvalEvidenceQuality,
  findingCount: number,
): string {
  if (verdict === 'delete_sunset') return '需要 You 决定是否停用这项评估。';
  if (verdict === 'build') return `请负责 ${featureId} 的猫补上缺失能力；完成后再复评。`;
  if (verdict === 'fix') return `请负责 ${featureId} 的猫修复现有问题；修完后再复评。`;
  if (evidenceQuality === 'insufficient') return '现在不用改代码；先补足样本。';
  if (findingCount > 0) return '现在不用立刻改代码；先确认这些线索是否持续出现。';
  return '现在不用处理；保持观察即可。';
}

export function synthesizeEvalHubNextCheck(
  verdict: EvalHubVerdictValue,
  stale: boolean,
  evidenceQuality: EvalEvidenceQuality,
): string {
  if (stale) return '已经超过原定复评时间，需要补跑一次评估。';
  if (verdict === 'delete_sunset') return 'You 拍板后，再决定停用或继续保留。';
  if (verdict === 'fix' || verdict === 'build') return '改动完成后，用同一组指标确认问题是否消失。';
  if (evidenceQuality === 'insufficient') return '等下一轮积累到足够样本，再判断是否需要改动。';
  return '按现有频率继续观察；下一轮确认同类信号是否再次出现。';
}

function resolvePrimaryMetricLabel(input: EvalHubOperatorNarrativeInput): string | undefined {
  const metricType = input.attribution.findings[0]?.frictionSignal?.type;
  return metricType ? input.metricGlossary?.[metricType]?.label : undefined;
}

function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)} 小时`;
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[。.!！?？]+$/, '');
}
