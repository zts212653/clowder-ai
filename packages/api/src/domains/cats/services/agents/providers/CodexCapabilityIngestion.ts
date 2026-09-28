export type JsonRecord = Record<string, unknown>;

export interface IngestionBudget {
  remaining: number;
}

export const MAX_ARTIFACTS = 400;
const MAX_ISSUES = 20;
const MAX_ISSUE = 200;

export function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

export function requiredArray(value: unknown, issues: string[], label: string): unknown[] {
  if (Array.isArray(value)) return value;
  pushIssue(issues, `${label} returned a malformed collection`);
  return [];
}

export function optionalArray(value: unknown, issues: string[], label: string): unknown[] {
  return value === undefined ? [] : requiredArray(value, issues, label);
}

export function takeArray(value: unknown, max: number, issues: string[], label: string): unknown[] {
  const values = requiredArray(value, issues, label);
  if (values.length > max) pushIssue(issues, `${label} truncated at ${max} entries`);
  return values.slice(0, max);
}

export function takeArtifacts(value: unknown, budget: IngestionBudget, issues: string[], label: string): unknown[] {
  const values = requiredArray(value, issues, label);
  const count = Math.min(values.length, budget.remaining);
  if (values.length > count) pushIssue(issues, `${label} truncated by ${MAX_ARTIFACTS}-entry capability budget`);
  budget.remaining -= count;
  return values.slice(0, count);
}

export function boundedArrayCount(value: unknown, max: number, issues: string[], label: string): number {
  const values = requiredArray(value, issues, label);
  if (values.length > max) pushIssue(issues, `${label} truncated at ${max} entries`);
  return Math.min(values.length, max);
}

export function boundedRecordKeyCount(value: unknown, max: number, issues: string[], label: string): number {
  const source = record(value);
  if (!source) {
    pushIssue(issues, `${label} returned a malformed container`);
    return 0;
  }
  let count = 0;
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    if (count >= max) {
      pushIssue(issues, `${label} truncated at ${max} entries`);
      break;
    }
    count += 1;
  }
  return count;
}

export function pushIssue(issues: string[], message: string): void {
  if (issues.length >= MAX_ISSUES) return;
  issues.push(message.slice(0, MAX_ISSUE));
}
