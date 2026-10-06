import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOOK_LOAD_CONTRACTS } from './hook-load-contracts.js';
import {
  MANAGED_EVENT_SCRIPTS,
  type ManagedHookCommands,
  type ManagedHookEvent,
  type ManagedHookScope,
  managedHookFileHealth,
  mergeManagedHooks,
  readHookDocument,
  renderManagedHooksDocument,
} from './managed-hook-entries.js';

export type SyncTargetContentKind = 'text' | 'json';

export interface SyncTarget {
  name: string;
  render: () => string;
  targetPath: string;
  contentKind?: SyncTargetContentKind;
  executable?: boolean;
  /**
   * Set for hook configs shared with users and other tools: an existing file is merged so that
   * only Clowder-managed entries change, never rewritten wholesale (#1566).
   */
  managedHooks?: ManagedHookScope;
}

export interface SyncOutcome {
  name: string;
  targetPath: string;
  action: 'written' | 'unchanged' | 'refused' | 'dry-run';
  reason?: string;
}

export interface DriftResult {
  name: string;
  drifted: boolean;
  targetPath: string;
  reason?: string;
}

export interface BuildAgentHookTargetsOptions {
  projectRoot: string;
  targetRoot: string;
}

export const AGENT_HOOK_TARGET_NAMES = [
  'hooks/session-start',
  'hooks/session-stop',
  'codex-hooks',
  'gemini-hooks',
] as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJsonString(content: string): string {
  return JSON.stringify(canonicalize(JSON.parse(content)));
}

function contentMatches(target: SyncTarget, current: string, rendered: string): boolean {
  if (target.contentKind !== 'json') return current === rendered;
  return canonicalJsonString(current) === canonicalJsonString(rendered);
}

export function checkDrift(target: SyncTarget): DriftResult {
  const rendered = target.render();

  if (!existsSync(target.targetPath)) {
    return {
      name: target.name,
      drifted: true,
      targetPath: target.targetPath,
      reason: 'target file does not exist',
    };
  }

  if (target.managedHooks) {
    const health = managedHookFileHealth(target.name, target.targetPath, target.managedHooks);
    const drifted = health.status !== 'configured';
    return { name: target.name, drifted, targetPath: target.targetPath, reason: drifted ? health.reason : undefined };
  }

  const current = readFileSync(target.targetPath, 'utf-8');
  const drifted = !contentMatches(target, current, rendered);

  return {
    name: target.name,
    drifted,
    targetPath: target.targetPath,
    reason: drifted ? 'content differs from rendered shards' : undefined,
  };
}

function mergeSync(target: SyncTarget, scope: ManagedHookScope, dryRun: boolean): SyncOutcome {
  const outcome = (action: SyncOutcome['action'], reason?: string): SyncOutcome => ({
    name: target.name,
    targetPath: target.targetPath,
    action,
    ...(reason ? { reason } : {}),
  });
  const read = readHookDocument(target.targetPath);
  const result = read.ok
    ? mergeManagedHooks(read.source, { ...scope, removeDuplicates: false })
    : ({ kind: 'refused', reason: read.reason } as const);
  if (result.kind === 'refused') {
    console.warn(`skipped ${target.name}: ${result.reason} (${target.targetPath} left unchanged)`);
    return outcome('refused', result.reason);
  }
  if (result.kind === 'unchanged') return outcome('unchanged');

  const merged = result.text;
  if (dryRun) {
    console.log(`\n=== ${target.name} -> ${target.targetPath} (dry-run merge) ===\n`);
    console.log(merged);
    return outcome('dry-run');
  }
  // writeFileSync follows symlinks, so dotfile-managed links stay links.
  writeFileSync(target.targetPath, merged, 'utf-8');
  console.log(`merged ${target.name} -> ${target.targetPath}`);
  return outcome('written');
}

export function applySync(target: SyncTarget, dryRun: boolean): SyncOutcome {
  if (target.managedHooks && existsSync(target.targetPath)) return mergeSync(target, target.managedHooks, dryRun);
  const rendered = target.render();

  if (dryRun) {
    console.log(`\n=== ${target.name} -> ${target.targetPath} (dry-run) ===\n`);
    console.log(rendered);
    return { name: target.name, targetPath: target.targetPath, action: 'dry-run' };
  }

  const dir = dirname(target.targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(target.targetPath, rendered, 'utf-8');
  if (target.executable || target.targetPath.endsWith('.sh')) {
    chmodSync(target.targetPath, 0o755);
  }
  console.log(`synced ${target.name} -> ${target.targetPath}`);
  return { name: target.name, targetPath: target.targetPath, action: 'written' };
}

function readUserHook(projectRoot: string, name: string): string {
  const path = join(projectRoot, '.claude', 'hooks', 'user-level', name);
  return readFileSync(path, 'utf-8');
}

function bashCommand(scriptPath: string): string {
  return `bash "${scriptPath.replace(/\\/g, '/')}"`;
}

function codexStopCommand(scriptPath: string): string {
  return `${bashCommand(scriptPath)} --codex-json`;
}

export type ManagedHookConsumer = 'claude' | 'codex' | 'gemini';

/** The exact commands Clowder renders for each consumer of the shared hook scripts. */
export function managedHookCommands(consumer: ManagedHookConsumer, targetRoot: string): ManagedHookCommands {
  const script = (event: ManagedHookEvent) => join(targetRoot, '.claude', 'hooks', MANAGED_EVENT_SCRIPTS[event]);
  return {
    SessionStart: bashCommand(script('SessionStart')),
    Stop: consumer === 'codex' ? codexStopCommand(script('Stop')) : bashCommand(script('Stop')),
  };
}

export function renderCodexHooksJson(targetRoot: string): string {
  return renderManagedHooksDocument(managedHookCommands('codex', targetRoot));
}

export function renderGeminiHooksJson(targetRoot: string): string {
  return renderManagedHooksDocument(managedHookCommands('gemini', targetRoot));
}

export function buildAgentHookTargets({ projectRoot, targetRoot }: BuildAgentHookTargetsOptions): SyncTarget[] {
  return [
    {
      name: 'hooks/session-start',
      render: () => readUserHook(projectRoot, 'session-start-recall.sh'),
      targetPath: join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'),
      executable: true,
    },
    {
      name: 'hooks/session-stop',
      render: () => readUserHook(projectRoot, 'session-stop-check.sh'),
      targetPath: join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh'),
      executable: true,
    },
    {
      name: 'codex-hooks',
      render: () => renderCodexHooksJson(targetRoot),
      targetPath: join(targetRoot, '.codex', 'hooks.json'),
      contentKind: 'json',
      managedHooks: {
        targetRoot,
        commands: managedHookCommands('codex', targetRoot),
        contract: HOOK_LOAD_CONTRACTS.codex,
      },
    },
    {
      name: 'gemini-hooks',
      render: () => renderGeminiHooksJson(targetRoot),
      targetPath: join(targetRoot, '.gemini', 'hooks.json'),
      contentKind: 'json',
      managedHooks: {
        targetRoot,
        commands: managedHookCommands('gemini', targetRoot),
        contract: HOOK_LOAD_CONTRACTS.gemini,
      },
    },
  ];
}

export function selectAgentHookTargets(targets: SyncTarget[]): SyncTarget[] {
  const names = new Set<string>(AGENT_HOOK_TARGET_NAMES);
  return targets.filter((target) => names.has(target.name));
}
