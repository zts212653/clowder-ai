import { createHash } from 'node:crypto';

import {
  type DecisionProcedureComponent,
  type MeasurementBundleCertificate,
  MeasurementBundleCertificateSchema,
  type MeasurementBundleResult,
  MeasurementBundleResultSchema,
} from './measurement-bundle-schema.js';

const REQUIRED_COMPONENT_KINDS = ['judge', 'rubric', 'classifier', 'prompt', 'model', 'code'] as const;
const INTERVENTION_ACTIONS = ['fix', 'build', 'delete_sunset'] as const;

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique values`);
  }
}

function assertSameSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  const missing = expected.filter((item) => !actualSet.has(item));
  const extra = actual.filter((item) => !expected.includes(item));
  if (missing.length > 0 || extra.length > 0 || actual.length !== expected.length) {
    throw new Error(
      `${label} mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }
}

export function computeDecisionProcedureVersionSetHash(components: readonly DecisionProcedureComponent[]): string {
  const stableComponents = components
    .map(({ kind, name, version, artifactRef, artifactSha256 }) => ({
      kind,
      name,
      version,
      artifactRef,
      artifactSha256,
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind));

  return createHash('sha256')
    .update(JSON.stringify({ contract: 'f267-decision-procedure-v1', components: stableComponents }))
    .digest('hex');
}

export function parseMeasurementBundleCertificate(input: unknown): MeasurementBundleCertificate {
  const certificate = MeasurementBundleCertificateSchema.parse(input);
  const componentKinds = certificate.decisionProcedure.components.map((component) => component.kind);
  assertUnique(componentKinds, 'decision procedure component kinds');
  assertSameSet(componentKinds, REQUIRED_COMPONENT_KINDS, 'decision procedure components');

  const expectedHash = computeDecisionProcedureVersionSetHash(certificate.decisionProcedure.components);
  if (certificate.decisionProcedure.versionSetHash !== expectedHash) {
    throw new Error('decisionProcedure.versionSetHash does not match the readable component version set');
  }

  const metricIds = certificate.metrics.map((metric) => metric.id);
  assertUnique(metricIds, 'certificate metric ids');
  assertUnique(certificate.decision.allowedActions, 'allowed actions');
  assertSameSet(certificate.interventionPolicy.requiredFor, INTERVENTION_ACTIONS, 'intervention policy requiredFor');

  return certificate;
}

function assertResultIdentity(certificate: MeasurementBundleCertificate, result: MeasurementBundleResult): void {
  if (
    result.certificateId !== certificate.certificateId ||
    result.bundleId !== certificate.bundleId ||
    result.domainId !== certificate.domainId
  ) {
    throw new Error('result identity does not match its measurement certificate');
  }
  if (result.decisionProcedureVersionSetHash !== certificate.decisionProcedure.versionSetHash) {
    throw new Error('result decision procedure version set does not match its measurement certificate');
  }
  if (result.cohort.window.startMs >= result.cohort.window.endMs) {
    throw new Error('result cohort window must be a non-empty half-open window');
  }
}

function assertResultMetrics(certificate: MeasurementBundleCertificate, result: MeasurementBundleResult): void {
  const decisionMetrics = certificate.metrics.filter(
    (metric) => metric.role === 'primary_loss' || metric.role === 'guardrail',
  );
  const expectedIds = decisionMetrics.map((metric) => metric.id);
  const actualIds = result.metrics.map((metric) => metric.metricId);
  assertUnique(actualIds, 'result metric ids');
  assertSameSet(actualIds, expectedIds, 'result metric set');

  const metricById = new Map(decisionMetrics.map((metric) => [metric.id, metric]));
  for (const metric of result.metrics) {
    const certificateMetric = metricById.get(metric.metricId);
    if (certificateMetric?.role !== metric.role) {
      throw new Error(`result metric role mismatch for ${metric.metricId}`);
    }
    if (
      metric.evidenceStatus === 'sufficient' &&
      (metric.n === 0 || metric.pointEstimate === null || metric.uncertainty.kind === 'not_estimable')
    ) {
      throw new Error(
        `metric ${metric.metricId} cannot be sufficient with zero n, a null point estimate, or not_estimable uncertainty`,
      );
    }
  }

  const insufficientMetrics = result.metrics.filter((metric) => metric.evidenceStatus === 'insufficient');
  if (insufficientMetrics.length > 0 && result.decision.status !== 'insufficient') {
    throw new Error('overall decision must be insufficient when any decision metric is insufficient');
  }
  if (result.decision.status === 'usable') {
    const unusable = result.metrics.find(
      (metric) =>
        metric.evidenceStatus !== 'sufficient' ||
        metric.n === 0 ||
        metric.pointEstimate === null ||
        metric.uncertainty.kind === 'not_estimable',
    );
    if (unusable) {
      throw new Error(`usable decision requires sufficient interval-or-power evidence for ${unusable.metricId}`);
    }
  }
}

function assertActionProposal(certificate: MeasurementBundleCertificate, result: MeasurementBundleResult): void {
  const proposal = result.actionProposal;
  if (!certificate.decision.allowedActions.includes(proposal.action)) {
    throw new Error(`action ${proposal.action} is not allowed by the measurement certificate`);
  }

  const requiresCard = INTERVENTION_ACTIONS.includes(proposal.action as (typeof INTERVENTION_ACTIONS)[number]);
  if (requiresCard && !proposal.interventionCard) {
    throw new Error(`intervention card is required before action ${proposal.action}`);
  }
  if (!proposal.interventionCard) return;

  const roleByMetric = new Map(certificate.metrics.map((metric) => [metric.id, metric.role]));
  for (const metricId of proposal.interventionCard.targetMetricIds) {
    if (roleByMetric.get(metricId) !== 'primary_loss') {
      throw new Error(`intervention card target metric ${metricId} is not a primary loss`);
    }
  }
  for (const metricId of proposal.interventionCard.guardrailMetricIds) {
    if (roleByMetric.get(metricId) !== 'guardrail') {
      throw new Error(`intervention card guardrail metric ${metricId} is not a guardrail`);
    }
  }
}

export function validateMeasurementBundleResult(
  certificateInput: unknown,
  resultInput: unknown,
): MeasurementBundleResult {
  const certificate = parseMeasurementBundleCertificate(certificateInput);
  const result = MeasurementBundleResultSchema.parse(resultInput);
  assertResultIdentity(certificate, result);
  assertResultMetrics(certificate, result);
  assertActionProposal(certificate, result);
  return result;
}
