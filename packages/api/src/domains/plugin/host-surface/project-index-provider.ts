import { memoryProjectIndexResponses } from '@clowder-ai/plugin-memory-contract/maintenance';
import type { ProjectIndexStatePort } from '../../memory/IndexStateManager.js';
import { type MemoryPluginHost, callMemoryOwner } from './memory-plugin-host.js';

export function createProjectIndexProvider(provider: MemoryPluginHost): ProjectIndexStatePort {
  return {
    getState: (projectPath, fingerprint, owner) =>
      callMemoryOwner(
        provider,
        { operation: 'index.project.read', input: { projectPath, fingerprint } },
        memoryProjectIndexResponses['index.project.read'],
        owner,
      ),
    claim: (projectPath, fingerprint, owner) =>
      callMemoryOwner(
        provider,
        { operation: 'index.project.claim', input: { projectPath, fingerprint } },
        memoryProjectIndexResponses['index.project.claim'],
        owner,
      ),
    async markReady(projectPath, docsIndexed, summaryJson, owner) {
      await callMemoryOwner(
        provider,
        { operation: 'index.project.settle', input: { projectPath, status: 'ready', docsIndexed, summaryJson } },
        memoryProjectIndexResponses['index.project.settle'],
        owner,
      );
    },
    async markFailed(projectPath, error, owner) {
      await callMemoryOwner(
        provider,
        { operation: 'index.project.settle', input: { projectPath, status: 'failed', error } },
        memoryProjectIndexResponses['index.project.settle'],
        owner,
      );
    },
    snoozeForOwner: (projectPath, owner) =>
      callMemoryOwner(
        provider,
        { operation: 'index.project.snooze', input: { projectPath } },
        memoryProjectIndexResponses['index.project.snooze'],
        owner,
      ),
  };
}
