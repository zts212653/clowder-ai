import { resolve } from 'node:path';

/** Route-only fixtures; the real capture and resumed provider journey are tested separately. */
export const importExecutionBoundary =
  (projectPath, clientId = 'openai') =>
  async () => {
    const project = resolve(projectPath);
    const root = process.platform === 'win32' ? project.toLowerCase() : project;
    return {
      v: 1,
      clientId,
      carrier: 'fixture',
      implementationKey: 'builtin:fixture',
      implementationGeneration: 'fixture-v1',
      accountRef: null,
      workspaceRoot: root,
      projectRoot: root,
    };
  };
