import { createHash } from 'node:crypto';
import {
  HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_COUNT,
  HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_LENGTH,
  unsafeMarkdownUrls,
} from '@cat-cafe/shared';
import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const machineId = nonempty.max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sourceIdList = z.array(machineId).min(1).max(16);
const markdown = nonempty.max(20_000);

const sourceSchema = z
  .object({
    id: machineId,
    label: nonempty.max(240),
    path: z
      .string()
      .regex(/^(docs|cat-cafe-skills)\/[A-Za-z0-9_./#-]+$/)
      .refine((value) => !value.split('/').includes('..')),
  })
  .strip();

const stepSchema = z
  .object({
    stepId: machineId,
    date: nonempty.max(80),
    title: nonempty.max(240),
    parentEdges: z
      .array(
        z
          .object({
            parentStepId: machineId,
            sourceId: machineId,
            reason: nonempty.max(2_000),
          })
          .strip(),
      )
      .max(16),
    sourceIds: sourceIdList,
    bodyMarkdown: markdown,
  })
  .strip();

const caseNarrativeSchema = z
  .object({
    caseId: machineId,
    stepId: machineId,
    title: nonempty.max(240),
    sourceIds: sourceIdList,
    bodyMarkdown: markdown,
  })
  .strip();

export const requestReviewHarnessStoryV3Schema = z
  .object({
    updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    overviewMarkdown: markdown,
    sources: z.array(sourceSchema).min(1).max(128),
    steps: z.array(stepSchema).min(1).max(64),
    cases: z.array(caseNarrativeSchema).min(1).max(128),
  })
  .strip();

export type RequestReviewHarnessStoryV3 = z.infer<typeof requestReviewHarnessStoryV3Schema>;

const duplicates = (values: readonly string[]) => new Set(values).size !== values.length;

export function validateRequestReviewHarnessStoryV3(
  story: RequestReviewHarnessStoryV3,
  archiveCases: ReadonlyArray<{ readonly caseId?: string }>,
  ctx: z.RefinementCtx,
): void {
  const sourceIds = story.sources.map((source) => source.id);
  const stepIds = story.steps.map((step) => step.stepId);
  const caseIds = story.cases.map((entry) => entry.caseId);
  const sources = new Set(sourceIds);
  const steps = new Map(story.steps.map((step) => [step.stepId, step]));
  const issue = (path: Array<string | number>, message: string) => ctx.addIssue({ code: 'custom', path, message });

  if (duplicates(sourceIds)) issue(['story', 'sources'], 'duplicate story source identity');
  if (duplicates(stepIds)) issue(['story', 'steps'], 'duplicate story step identity');
  if (duplicates(caseIds)) issue(['story', 'cases'], 'duplicate story case identity');

  const archived = archiveCases.map((entry) => entry.caseId);
  if (
    archived.some((id) => !id) ||
    duplicates(archived as string[]) ||
    archived.length !== caseIds.length ||
    archived.some((id) => !caseIds.includes(id as string))
  )
    issue(['story', 'cases'], 'every archived case must have exactly one narrative');

  const markdownFields: Array<{ path: Array<string | number>; value: string }> = [
    { path: ['story', 'overviewMarkdown'], value: story.overviewMarkdown },
  ];
  story.steps.forEach((step, index) => {
    markdownFields.push({ path: ['story', 'steps', index, 'bodyMarkdown'], value: step.bodyMarkdown });
    if (duplicates(step.sourceIds)) issue(['story', 'steps', index, 'sourceIds'], 'step sources must be unique');
    if (step.sourceIds.some((id) => !sources.has(id)))
      issue(['story', 'steps', index, 'sourceIds'], 'step source missing');
    const parents = step.parentEdges.map((edge) => edge.parentStepId);
    if (duplicates(parents)) issue(['story', 'steps', index, 'parentEdges'], 'step parents must be unique');
    step.parentEdges.forEach((edge, edgeIndex) => {
      if (!steps.has(edge.parentStepId))
        issue(['story', 'steps', index, 'parentEdges', edgeIndex, 'parentStepId'], 'story parent missing');
      if (!sources.has(edge.sourceId))
        issue(['story', 'steps', index, 'parentEdges', edgeIndex, 'sourceId'], 'relationship source missing');
    });
  });
  story.cases.forEach((entry, index) => {
    markdownFields.push({ path: ['story', 'cases', index, 'bodyMarkdown'], value: entry.bodyMarkdown });
    if (!steps.has(entry.stepId)) issue(['story', 'cases', index, 'stepId'], 'case story step missing');
    if (duplicates(entry.sourceIds)) issue(['story', 'cases', index, 'sourceIds'], 'case sources must be unique');
    if (entry.sourceIds.some((id) => !sources.has(id)))
      issue(['story', 'cases', index, 'sourceIds'], 'case story source missing');
  });

  const totalMarkdown = markdownFields.reduce((total, field) => total + field.value.length, 0);
  if (totalMarkdown > 500_000) issue(['story'], 'story Markdown exceeds the publication limit');
  for (const field of markdownFields) {
    const unsafe = unsafeMarkdownUrls(field.value);
    if (unsafe.length) issue(field.path, `unsafe Markdown URL: ${unsafe[0]}`);
  }

  const completed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (stepId: string) => {
    if (completed.has(stepId)) return;
    if (visiting.has(stepId)) {
      issue(['story', 'steps'], 'story relationships form a cycle');
      return;
    }
    const step = steps.get(stepId);
    if (!step) return;
    visiting.add(stepId);
    for (const edge of step.parentEdges) visit(edge.parentStepId);
    visiting.delete(stepId);
    completed.add(stepId);
  };
  for (const step of story.steps) visit(step.stepId);
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
const pointer = (path: ReadonlyArray<string | number>) =>
  `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
const boundIgnoredFieldPath = (path: string) => {
  if (path.length <= HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_LENGTH) return path;
  const suffix = `…[sha256:${createHash('sha256').update(path).digest('hex')}]`;
  return `${path.slice(0, HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_LENGTH - suffix.length)}${suffix}`;
};

/** The source collector and publication journal share one bounded diagnostic representation. */
export function normalizeRequestReviewHarnessV3UnknownFieldPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(boundIgnoredFieldPath))].sort().slice(0, HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_COUNT);
}
const unknownAt = (
  value: unknown,
  path: ReadonlyArray<string | number>,
  allowed: ReadonlySet<string>,
  found: string[],
) => {
  const candidate = object(value);
  if (!candidate) return;
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) found.push(pointer([...path, key]));
};

/** Publication receipt diagnostics for stripped v3 extension fields. */
export function collectRequestReviewHarnessV3UnknownFieldPaths(raw: unknown): string[] {
  const found: string[] = [];
  const root = object(raw);
  if (!root || root.schemaVersion !== 3) return found;
  unknownAt(
    root,
    [],
    new Set([
      'schemaVersion',
      'status',
      'snapshotCommit',
      'ownerReviewCommit',
      'ownerReviewRef',
      'since',
      'members',
      'releases',
      'cases',
      'story',
    ]),
    found,
  );
  const releases = Array.isArray(root.releases) ? root.releases : [];
  releases.forEach((release, index) => {
    unknownAt(release, ['releases', index], new Set(['id', 'date', 'parent', 'version', 'members', 'commits']), found);
    const commits = object(release)?.commits;
    if (Array.isArray(commits))
      commits.forEach((commit, commitIndex) => {
        unknownAt(
          commit,
          ['releases', index, 'commits', commitIndex],
          new Set(['sha', 'authoredAt', 'subject', 'members']),
          found,
        );
      });
  });
  const archiveCases = Array.isArray(root.cases) ? root.cases : [];
  archiveCases.forEach((entry, index) => {
    unknownAt(
      entry,
      ['cases', index],
      new Set([
        'caseId',
        'documentedOn',
        'occurredOn',
        'occurredWindow',
        'kind',
        'summary',
        'link',
        'browsingBucket',
        'actualUseStatus',
        'sourceTextSha256',
        'citedMemberCommits',
      ]),
      found,
    );
    unknownAt(object(entry)?.occurredWindow, ['cases', index, 'occurredWindow'], new Set(['start', 'end']), found);
    const commits = object(entry)?.citedMemberCommits;
    if (Array.isArray(commits))
      commits.forEach((commit, commitIndex) => {
        unknownAt(
          commit,
          ['cases', index, 'citedMemberCommits', commitIndex],
          new Set(['sha', 'fullSha', 'authoredAt', 'subject', 'members', 'relation']),
          found,
        );
      });
  });
  const story = object(root.story);
  unknownAt(story, ['story'], new Set(['updated', 'overviewMarkdown', 'sources', 'steps', 'cases']), found);
  const sources = Array.isArray(story?.sources) ? story.sources : [];
  sources.forEach((source, index) => {
    unknownAt(source, ['story', 'sources', index], new Set(['id', 'label', 'path']), found);
  });
  const steps = Array.isArray(story?.steps) ? story.steps : [];
  steps.forEach((step, index) => {
    unknownAt(
      step,
      ['story', 'steps', index],
      new Set(['stepId', 'date', 'title', 'parentEdges', 'sourceIds', 'bodyMarkdown']),
      found,
    );
    const edges = object(step)?.parentEdges;
    if (Array.isArray(edges))
      edges.forEach((edge, edgeIndex) => {
        unknownAt(
          edge,
          ['story', 'steps', index, 'parentEdges', edgeIndex],
          new Set(['parentStepId', 'sourceId', 'reason']),
          found,
        );
      });
  });
  const cases = Array.isArray(story?.cases) ? story.cases : [];
  cases.forEach((entry, index) => {
    unknownAt(
      entry,
      ['story', 'cases', index],
      new Set(['caseId', 'stepId', 'title', 'sourceIds', 'bodyMarkdown']),
      found,
    );
  });
  return normalizeRequestReviewHarnessV3UnknownFieldPaths(found);
}
