export const WORKSPACE_MODES = [
  'dev',
  'recall',
  'schedule',
  'tasks',
  'community',
  'artifacts',
  'approval',
  'trajectory',
  'eval',
] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && (WORKSPACE_MODES as readonly string[]).includes(value);
}
