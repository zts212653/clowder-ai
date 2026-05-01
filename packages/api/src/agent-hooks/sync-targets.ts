import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SyncTargetContentKind = 'text' | 'json';

export interface SyncTarget {
  name: string;
  render: () => string;
  targetPath: string;
  contentKind?: SyncTargetContentKind;
  executable?: boolean;
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

export const AGENT_HOOK_TARGET_NAMES = ['hooks/session-start', 'hooks/session-stop', 'codex-hooks'] as const;

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

  const current = readFileSync(target.targetPath, 'utf-8');
  const drifted = !contentMatches(target, current, rendered);

  return {
    name: target.name,
    drifted,
    targetPath: target.targetPath,
    reason: drifted ? 'content differs from rendered shards' : undefined,
  };
}

export function applySync(target: SyncTarget, dryRun: boolean): void {
  const rendered = target.render();

  if (dryRun) {
    console.log(`\n=== ${target.name} -> ${target.targetPath} (dry-run) ===\n`);
    console.log(rendered);
    return;
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
}

function readUserHook(projectRoot: string, name: string): string {
  const path = join(projectRoot, '.claude', 'hooks', 'user-level', name);
  return readFileSync(path, 'utf-8');
}

export function renderCodexHooksJson(targetRoot: string): string {
  const config = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'),
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh'),
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
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
    },
  ];
}

export function selectAgentHookTargets(targets: SyncTarget[]): SyncTarget[] {
  const names = new Set<string>(AGENT_HOOK_TARGET_NAMES);
  return targets.filter((target) => names.has(target.name));
}
