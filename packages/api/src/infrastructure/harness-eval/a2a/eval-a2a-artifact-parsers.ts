/**
 * YAML artifact parsers for eval:a2a live verdict generation.
 *
 * Extracted from eval-a2a-live-verdict.ts to keep the verdict generator file
 * under the 350-line hard limit (AGENTS.md redline `文件 200 警告/350 硬上限`).
 * No behavior change — pure structural split (R3 cloud P1 fix on PR #2466).
 *
 * Responsibilities:
 *   - parseSnapshot: read a F167 eval-snapshot YAML markdown into a typed
 *     shape, including the optional counter_window block (F167 sibling-PR P1)
 *   - parseAttribution: read an F167 attribution YAML markdown
 *   - parseMarkdownYaml: low-level frontmatter+body splitter
 *   - YAML scalar/object helpers (countRecord, stringValue, numberValue, ...)
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export type RawRecord = Record<string, unknown>;

export interface ParsedMarkdownYaml {
  frontmatter: Record<string, unknown>;
  body: Record<string, unknown>;
}

export function parseSnapshot(path: string) {
  const parsed = parseMarkdownYaml(path);
  const featureId = stringValue(parsed.frontmatter.feature_id, 'snapshot feature_id');
  const generatedAt = stringValue(parsed.frontmatter.generated_at, 'snapshot generated_at');
  const components = arrayOfRecords(parsed.body.components).map((component) => ({
    id: stringValue(component.id, 'snapshot component id'),
    name: stringValue(component.name, 'snapshot component name'),
    confidence: stringValue(component.confidence ?? 'medium', 'snapshot component confidence'),
    activationCounts: countRecord(component.activation_counts),
    frictionCounts: countRecord(component.friction_counts),
  }));
  // F167 sibling-PR (P1 gpt52 review fix): parse optional counter_window block
  // when present, so the counter-domain denominator survives YAML → bundle
  // round-trip and reaches eval cats. Older artifacts (pre-sibling-PR) won't
  // have the block; absence is fine and counterWindow stays undefined.
  const counterWindowRaw = parsed.body.counter_window;
  const counterWindow =
    counterWindowRaw != null
      ? {
          startMs: optionalNumber(recordValue(counterWindowRaw).start_ms),
          endMs: optionalNumber(recordValue(counterWindowRaw).end_ms),
          durationHours: numberValue(
            recordValue(counterWindowRaw).duration_hours,
            'snapshot counter_window duration_hours',
          ),
        }
      : undefined;

  return {
    featureId,
    evalSnapshotId:
      optionalStringValue(parsed.frontmatter.eval_snapshot_id, 'snapshot eval_snapshot_id') ??
      evalSnapshotIdFromGeneratedAt(featureId, generatedAt),
    generatedAt,
    window: {
      startMs: optionalNumber(recordValue(parsed.body.window).start_ms),
      endMs: optionalNumber(recordValue(parsed.body.window).end_ms),
      durationHours: numberValue(recordValue(parsed.body.window).duration_hours, 'snapshot window duration_hours'),
    },
    ...(counterWindow ? { counterWindow } : {}),
    components,
  };
}

export function parseAttribution(path: string) {
  const parsed = parseMarkdownYaml(path);
  const findings = arrayOfRecords(parsed.body.findings).map((finding) => {
    const relatedFeature = optionalStringValue(finding.related_feature, 'attribution related_feature');
    const attribution = recordValue(finding.attribution);
    const pipelineOrHuman = optionalStringValue(attribution.pipeline_or_human, 'attribution pipeline_or_human');
    return {
      id: stringValue(finding.id, 'attribution finding id'),
      ...(relatedFeature ? { relatedFeature } : {}),
      frictionSignal: {
        type: stringValue(recordValue(finding.friction_signal).type, 'attribution friction signal type'),
        severity: severityValue(recordValue(finding.friction_signal).severity),
        confidence: numberValue(recordValue(finding.friction_signal).confidence, 'attribution confidence'),
      },
      attribution: {
        primaryLayer: stringValue(attribution.primary_layer, 'attribution primary_layer'),
        ...(pipelineOrHuman ? { pipelineOrHuman } : {}),
        evidence: arrayOfRecords(attribution.evidence).map((evidence) => ({
          type: stringValue(evidence.type, 'attribution evidence type'),
          anchor: stringValue(evidence.anchor, 'attribution evidence anchor'),
          excerpt: stringValue(evidence.excerpt, 'attribution evidence excerpt'),
        })),
      },
      proposedAction: arrayOfRecords(finding.proposed_action).map((action) => ({
        action: stringValue(action.action, 'attribution proposed_action action'),
        target: stringValue(action.target, 'attribution proposed_action target'),
        rationale: stringValue(action.rationale, 'attribution proposed_action rationale'),
      })),
      status: stringValue(finding.status ?? 'open', 'attribution status'),
    };
  });
  const noFinding = parsed.body.no_finding_record ? recordValue(parsed.body.no_finding_record) : undefined;
  return {
    featureId: stringValue(parsed.frontmatter.feature_id, 'attribution feature_id'),
    evalSnapshotId: stringValue(parsed.frontmatter.eval_snapshot_id, 'attribution eval_snapshot_id'),
    generatedAt: stringValue(parsed.frontmatter.generated_at, 'attribution generated_at'),
    findings,
    ...(noFinding
      ? {
          noFindingRecord: {
            reason: stringValue(noFinding.reason, 'attribution no_finding_record reason'),
            evidence: stringValue(noFinding.evidence, 'attribution no_finding_record evidence'),
          },
        }
      : {}),
  };
}

export function parseMarkdownYaml(path: string): ParsedMarkdownYaml {
  const raw = readFileSync(path, 'utf8');
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) throw new Error(`missing YAML frontmatter: ${path}`);
  const body = raw.slice(frontmatterMatch[0].length);
  const bodyYaml = body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return {
    frontmatter: asRecord(parseYaml(frontmatterMatch[1] ?? '')),
    body: asRecord(parseYaml(bodyYaml) ?? {}),
  };
}

function evalSnapshotIdFromGeneratedAt(featureId: string, generatedAt: string): string {
  const date = generatedAt.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) throw new Error('snapshot generated_at must start with YYYY-MM-DD');
  return `eval-${featureId}-${date}`;
}

function countRecord(value: unknown): Record<string, number | null> {
  const record = recordValue(value, false);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).map(([key, count]) => [key, count == null ? null : numberValue(count, key)]),
  );
}

function severityValue(value: unknown): 'low' | 'medium' | 'high' {
  const severity = stringValue(value, 'attribution severity');
  if (severity === 'low' || severity === 'medium' || severity === 'high') return severity;
  throw new Error(`invalid attribution severity: ${severity}`);
}

function numberValue(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`${name} must be a finite number`);
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  return numberValue(value, 'optional number');
}

function stringValue(value: unknown, name: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`${name} must be a non-empty string`);
}

function optionalStringValue(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  return stringValue(value, name);
}

function arrayOfRecords(value: unknown): RawRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asRecord(item));
}

function recordValue(value: unknown, required = true): RawRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RawRecord;
  if (!required) return {};
  throw new Error('expected YAML object');
}

function asRecord(value: unknown): RawRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RawRecord;
  return {};
}
