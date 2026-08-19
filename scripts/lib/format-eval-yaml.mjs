export function formatSnapshotYaml(snapshot, dateStr) {
  const lines = [
    '---',
    'doc_kind: harness-feedback',
    'feedback_type: eval-snapshot',
    `feature_id: ${snapshot.featureId}`,
    `generated_at: "${snapshot.generatedAt}"`,
    `generated_by: "${snapshot.generatedBy}"`,
    '---',
    '',
    `# ${snapshot.featureId} Runtime Eval Snapshot — ${dateStr}`,
    '',
    `data_source: "${snapshot.dataSource}"`,
    `overall_confidence: ${snapshot.overallConfidence}`,
    '',
    'window:',
    `  start_ms: ${snapshot.window.startMs}`,
    `  end_ms: ${snapshot.window.endMs}`,
    `  duration_hours: ${snapshot.window.durationHours.toFixed(2)}`,
    '',
  ];

  // F167 sibling-PR (P1 gpt52 review fix): persist counter_window so the
  // YAML artifact carries the counter-domain denominator. Without this block
  // the bundle reader (eval-a2a-live-verdict / eval-a2a-artifact-resolver)
  // sees only `window` (trace window) and eval cats silently divide fresh
  // counters by hydrated 24h trace windows after restart. Omitted when the
  // in-memory snapshot has no counterWindow (older runner without
  // /api/telemetry/process-info).
  if (snapshot.counterWindow) {
    // R2 cloud P2: toFixed(2) rounds counterWindow durations under ~18s to
    // "0.00", which the DOMAIN_INSTRUCTIONS counter-rate denominator would
    // divide by → division-by-zero / false-infinite rate. toFixed(6) keeps
    // microsecond precision (smallest representable: 3.6 ms) so even a brand-
    // new process produces a non-zero denominator on the very next eval run.
    lines.push(
      'counter_window:',
      `  start_ms: ${snapshot.counterWindow.startMs}`,
      `  end_ms: ${snapshot.counterWindow.endMs}`,
      `  duration_hours: ${snapshot.counterWindow.durationHours.toFixed(6)}`,
      '',
    );
  }

  lines.push(
    'trace_store_stats:',
    `  span_count: ${snapshot.traceStoreStats.spanCount}`,
    `  max_spans: ${snapshot.traceStoreStats.maxSpans}`,
    `  max_age_ms: ${snapshot.traceStoreStats.maxAgeMs}`,
    '',
    `summary: "${snapshot.summary}"`,
    '',
    'components:',
  );

  for (const c of snapshot.components) {
    lines.push(`  - id: ${c.componentId}`);
    lines.push(`    name: "${c.componentName}"`);
    lines.push(`    confidence: ${c.confidence}`);
    lines.push('    activation_counts:');
    for (const [k, v] of Object.entries(c.activationCounts)) {
      lines.push(`      ${k}: ${v ?? 'null'}`);
    }
    if (Object.keys(c.activationCounts).length === 0) {
      lines.push('      {}');
    }
    lines.push('    friction_counts:');
    for (const [k, v] of Object.entries(c.frictionCounts)) {
      lines.push(`      ${k}: ${v ?? 'null'}`);
    }
    if (Object.keys(c.frictionCounts).length === 0) {
      lines.push('      {}');
    }
    if (c.telemetryGaps.length > 0) {
      lines.push('    telemetry_gaps:');
      for (const gap of c.telemetryGaps) {
        lines.push(`      - metric: ${gap.metric}`);
        lines.push(`        reason: ${gap.reason}`);
        lines.push(`        impact: "${gap.impact}"`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatAttributionYaml(report, dateStr, fingerprintFn) {
  const lines = [
    '---',
    'doc_kind: harness-feedback',
    'feedback_type: attribution',
    `feature_id: ${report.featureId}`,
    `eval_snapshot_id: "${report.evalSnapshotId}"`,
    `generated_at: "${report.generatedAt}"`,
    '---',
    '',
    `# ${report.featureId} Attribution Report — ${dateStr}`,
    '',
  ];

  if (report.findings.length === 0 && report.noFindingRecord) {
    lines.push('no_finding_record:');
    lines.push(`  reason: "${report.noFindingRecord.reason}"`);
    lines.push(`  evidence: "${report.noFindingRecord.evidence}"`);
    lines.push('');
    lines.push('findings: []');
  } else {
    lines.push(`finding_count: ${report.findings.length}`);
    lines.push('');
    lines.push('findings:');
    for (const f of report.findings) {
      lines.push(`  - id: ${f.id}`);
      lines.push(`    related_feature: ${f.relatedFeature}`);
      lines.push('    friction_signal:');
      lines.push(`      type: ${f.frictionSignal.type}`);
      lines.push(`      severity: ${f.frictionSignal.severity}`);
      lines.push(`      confidence: ${f.frictionSignal.confidence}`);
      lines.push('    attribution:');
      lines.push(`      primary_layer: ${f.attribution.primaryLayer}`);
      lines.push(`      pipeline_or_human: ${f.attribution.pipelineOrHuman}`);
      lines.push('      evidence:');
      for (const e of f.attribution.evidence) {
        lines.push(`        - type: ${e.type}`);
        lines.push(`          anchor: "${e.anchor}"`);
        lines.push(`          excerpt: "${e.excerpt}"`);
        // F192 Phase D — local R1 P1-2 fix: serialize per-fire sample sub-fields so
        // the on-disk YAML artifact carries the drilldown anchors. Without this the
        // in-memory AttributionRecord has samples but the next eval cycle (reads the
        // YAML) sees nothing — verdict can't close.
        if (e.sample) {
          lines.push('          sample:');
          lines.push(`            trace_id: "${e.sample.traceId}"`);
          lines.push(`            span_id: "${e.sample.spanId}"`);
          lines.push(`            message_id_hash: "${e.sample.messageIdHash}"`);
          lines.push(`            invocation_id_hash: "${e.sample.invocationIdHash}"`);
          lines.push(`            thread_id_hash: "${e.sample.threadIdHash}"`);
          lines.push(`            agent_id: "${e.sample.agentId}"`);
          lines.push(`            thread_system_kind: "${e.sample.threadSystemKind}"`);
          lines.push(`            trigger: "${e.sample.trigger}"`);
          lines.push(`            fired_at: "${e.sample.firedAt}"`);
          // F192 Phase D R1 P1-1 fix (砚砚): render per-metric extra hashed attrs
          // (e.g. C1 priorTaskIdHash / newTaskIdHash). Keys are camelCase as emitted
          // by the route handler — converted to snake_case for YAML consistency with
          // the other sample fields. Iteration is deterministic via Object.keys order
          // (extractor inserts in extraAttrKeys order — allowlist iteration order).
          if (e.sample.extras) {
            lines.push('            extras:');
            for (const [key, value] of Object.entries(e.sample.extras)) {
              const snakeKey = key
                .replace(/([A-Z])/g, '_$1')
                .toLowerCase()
                .replace(/^_/, '');
              lines.push(`              ${snakeKey}: "${value}"`);
            }
          }
        }
      }
      // F192 Phase D — sampleCoverage (sampled-metric findings only). Honest accounting
      // of how many fires we captured per-fire-sample evidence for vs counter says.
      if (f.sampleCoverage) {
        lines.push('    sample_coverage:');
        lines.push(`      sample_count: ${f.sampleCoverage.sampleCount}`);
        lines.push(`      metric_count: ${f.sampleCoverage.metricCount}`);
        lines.push(`      complete: ${f.sampleCoverage.complete}`);
      }
      lines.push('    proposed_action:');
      for (const a of f.proposedAction) {
        lines.push(`      - action: ${a.action}`);
        lines.push(`        target: "${a.target}"`);
        lines.push(`        rationale: "${a.rationale}"`);
      }
      lines.push(`    fingerprint: "${fingerprintFn(f)}"`);
      lines.push(`    status: ${f.status}`);
      lines.push('');
    }
  }

  if (report.actionRate) {
    lines.push('');
    lines.push('action_rate:');
    lines.push(`  total: ${report.actionRate.total}`);
    lines.push(`  acted_on: ${report.actionRate.actedOn}`);
    lines.push(`  rate: ${report.actionRate.rate}`);
    lines.push(`  sunset_candidate: ${report.actionRate.sunsetCandidate}`);
  }

  return lines.join('\n');
}
