#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCatId } from '@cat-cafe/shared';
import { GeminiAgentService } from '../domains/cats/services/agents/providers/GeminiAgentService.js';
import type { AgentMessage } from '../domains/cats/services/types.js';

const SCHEMA_VERSION = 1;
const PROFILE_MODEL_SUFFIX = ' (antigravity-cli profile)';

export interface AgyProfileSmokeTarget {
  readonly profileId: string;
  readonly catId: string;
  readonly modelLabel: string;
  readonly marker: string;
}

export interface AgyProfileSmokeArgs {
  readonly runLive: boolean;
  readonly homeRoot?: string;
  readonly workingDirectory?: string;
  readonly outputJson?: string;
}

export interface AgyProfileSmokeResult {
  readonly profileId: string;
  readonly catId: string;
  readonly expectedModel: string;
  readonly ok: boolean;
  readonly stage: string;
  readonly observedModel?: string;
  readonly modelVerified: boolean;
  readonly markerMatched: boolean;
  readonly errors: readonly string[];
}

export function buildDefaultAgyProfileSmokeTargets(): readonly AgyProfileSmokeTarget[] {
  return [
    target('f210-opus46-thinking', 'f210-agy-opus46', 'Claude Opus 4.6 (Thinking)'),
    target('f210-gemini31-pro-high', 'f210-agy-gemini31', 'Gemini 3.1 Pro (High)'),
    target('f210-gemini35-flash-high', 'f210-agy-gemini35', 'Gemini 3.5 Flash (High)'),
  ];
}

function target(profileId: string, catId: string, modelLabel: string): AgyProfileSmokeTarget {
  return {
    profileId,
    catId,
    modelLabel,
    marker: `CAT_CAFE_AGY_PROFILE_SMOKE_OK_${profileId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`,
  };
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  return path;
}

function defaultHomeRoot(): string {
  return join(homedir(), '.cat-cafe', 'agy-profiles');
}

function defaultWorkingDirectory(): string {
  return process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
}

function assignValueArg(args: Record<string, string | undefined>, argv: readonly string[], index: number) {
  const arg = argv[index];
  for (const key of ['--home-root', '--working-directory', '--output-json']) {
    if (arg === key) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${key}`);
      args[key] = value;
      return { nextIndex: index + 1 };
    }
    if (arg.startsWith(`${key}=`)) {
      args[key] = arg.slice(key.length + 1);
      return { nextIndex: index };
    }
  }
  return undefined;
}

export function parseAgyProfileSmokeArgs(argv: readonly string[]): AgyProfileSmokeArgs {
  const values: Record<string, string | undefined> = {};
  let runLive = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--run-live') {
      runLive = true;
      continue;
    }
    const matched = assignValueArg(values, argv, i);
    if (matched) {
      i = matched.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    runLive,
    homeRoot: values['--home-root'],
    workingDirectory: values['--working-directory'],
    outputJson: values['--output-json'],
  };
}

function latestMetadata(events: readonly AgentMessage[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].metadata) return events[i].metadata;
  }
  return undefined;
}

function normalizeObservedModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.endsWith(PROFILE_MODEL_SUFFIX) ? model.slice(0, -PROFILE_MODEL_SUFFIX.length) : model;
}

function sanitizeError(error: string): string {
  return error.replace(/https:\/\/accounts\.google\.com\/\S+/gi, '[REDACTED_OAUTH_URL]');
}

function classifySmokeStage(input: {
  readonly target: AgyProfileSmokeTarget;
  readonly errors: readonly string[];
  readonly observedModel: string | undefined;
  readonly modelVerified: boolean;
  readonly markerMatched: boolean;
}): string {
  const rules: readonly (readonly [boolean, string])[] = [
    [input.errors.some((error) => /not authenticated|complete login|auth/i.test(error)), 'auth_required'],
    [input.errors.length > 0, 'provider_error'],
    [Boolean(input.observedModel && input.observedModel !== input.target.modelLabel), 'model_mismatch'],
    [!input.modelVerified, 'model_unverified'],
    [!input.markerMatched, 'marker_missing'],
  ];
  for (const [failed, stage] of rules) {
    if (failed) return stage;
  }
  return 'passed';
}

export function summarizeAgyProfileSmokeEvents(
  target: AgyProfileSmokeTarget,
  events: readonly AgentMessage[],
): AgyProfileSmokeResult {
  const metadata = latestMetadata(events);
  const observedModel = normalizeObservedModel(metadata?.model);
  const modelVerified = metadata?.modelVerified === true;
  const markerMatched = events.some((event) => event.type === 'text' && event.content?.trim() === target.marker);
  const errors = events.flatMap((event) => (event.type === 'error' && event.error ? [sanitizeError(event.error)] : []));
  const stage = classifySmokeStage({ target, errors, observedModel, modelVerified, markerMatched });

  return {
    profileId: target.profileId,
    catId: target.catId,
    expectedModel: target.modelLabel,
    ok: stage === 'passed',
    stage,
    ...(observedModel ? { observedModel } : {}),
    modelVerified,
    markerMatched,
    errors,
  };
}

async function runTarget(target: AgyProfileSmokeTarget, homeRoot: string, workingDirectory: string) {
  const service = new GeminiAgentService({
    catId: createCatId(target.catId),
    model: target.modelLabel,
    adapter: 'antigravity-cli',
    agyProfile: {
      enabled: true,
      profileId: target.profileId,
      homeRoot,
      model: target.modelLabel,
      autoApprove: true,
      trustedWorkspaces: [workingDirectory],
    },
  });
  const prompt = [
    `Reply with exactly ${target.marker}.`,
    'Do not add markdown, explanation, punctuation, or any other text.',
  ].join(' ');
  const events: AgentMessage[] = [];
  for await (const event of service.invoke(prompt, {
    workingDirectory,
    invocationId: `f210-agy-profile-smoke-${target.profileId}-${randomUUID()}`,
  })) {
    events.push(event);
  }
  return summarizeAgyProfileSmokeEvents(target, events);
}

export async function runAgyProfileSmokeSuite(args: AgyProfileSmokeArgs) {
  const targets = buildDefaultAgyProfileSmokeTargets();
  const homeRoot = resolve(expandHome(args.homeRoot ? args.homeRoot : defaultHomeRoot()));
  const workingDirectory = resolve(args.workingDirectory ? args.workingDirectory : defaultWorkingDirectory());

  if (!args.runLive) {
    return {
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      stage: 'dry_run',
      homeRoot,
      workingDirectory,
      targets,
      note: 'Pass --run-live to invoke AGY. Each target profile HOME must already be authenticated/onboarded.',
    };
  }

  const results: AgyProfileSmokeResult[] = [];
  for (const smokeTarget of targets) {
    results.push(await runTarget(smokeTarget, homeRoot, workingDirectory));
  }
  const ok = results.every((result) => result.ok);
  return {
    schemaVersion: SCHEMA_VERSION,
    ok,
    stage: ok ? 'passed' : 'failed',
    homeRoot,
    workingDirectory,
    targets: results,
  };
}

function writeReport(path: string | undefined, report: unknown): void {
  if (!path) return;
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseAgyProfileSmokeArgs(argv);
  const report = await runAgyProfileSmokeSuite(args);
  writeReport(args.outputJson, report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(currentFile).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
