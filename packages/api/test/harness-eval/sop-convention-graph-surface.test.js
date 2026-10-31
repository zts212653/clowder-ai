import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conventionGraphDomainsForPaths } from '../../dist/infrastructure/harness-eval/convention-graph-surfaces.js';
import { evaluatePredicate } from '../../dist/infrastructure/harness-eval/sop/sop-predicate-evaluator.js';

const baseTrace = {
  sessionId: 'session-test',
  sopDefinitionId: 'development',
  observedStage: 'implementation',
  commands: [],
  changedFiles: [],
  envSnapshot: {},
  gitState: { branch: 'feat/test', ahead: 0, behind: 0, clean: true },
  handles: { author: 'codex', reviewer: 'sonnet' },
  shaContext: {},
};

const predicate = {
  type: 'changed_files_require_command',
  includeGlobs: [
    'packages/mcp-server/src/tools/*.ts',
    'packages/mcp-server/src/server-toolsets.ts',
    'cat-cafe-skills/*/SKILL.md',
  ],
  excludeGlobs: ['**/*.test.ts', '**/*.test.js'],
  mustMatch: 'pnpm convention-graph:code-consumers|cat-cafe-convention-graph code-consumers',
};

function freshCodeConsumersStdout(filePath, domainId = 'mcp-tool') {
  return freshCodeConsumersStdoutForTargets([filePath], domainId);
}

function freshCodeConsumersStdoutForTargets(filePaths, domainId = 'mcp-tool') {
  return JSON.stringify({
    targets: filePaths.map((filePath) => ({ id: `${domainId}:${filePath}`, domainId, filePath })),
    freshness: { stale: false },
  });
}

const freshCodeConsumersWithoutTargetsStdout = JSON.stringify({ targets: [], freshness: { stale: false } });
const staleCodeConsumersStdout = JSON.stringify({
  freshness: { stale: true, pendingChanges: ['packages/mcp-server/src/tools/callback-tools.ts'] },
});

function evaluate(trace) {
  return evaluatePredicate(
    'impl-convention-graph-before-convention-edit',
    'implementation',
    'pitfall',
    'blocker',
    predicate,
    trace,
  );
}

describe('SOP convention graph surface coverage', () => {
  it('does not map unindexed convention-looking files to graph domains', () => {
    assert.deepEqual(conventionGraphDomainsForPaths(['cat-cafe-skills/manifest.yaml']), []);
    assert.deepEqual(conventionGraphDomainsForPaths(['cat-cafe-skills/nested/example/SKILL.md']), []);
    assert.deepEqual(conventionGraphDomainsForPaths(['packages/mcp-server/src/tools/README.md']), []);
    assert.deepEqual(conventionGraphDomainsForPaths(['packages/mcp-server/src/tools/nested/helper.ts']), []);
    assert.deepEqual(conventionGraphDomainsForPaths(['packages/api/src/routes/threads.ts']), []);
    assert.deepEqual(
      conventionGraphDomainsForPaths(['packages/api/src/domains/cats/services/agents/routing/route.ts']),
      [],
    );
  });

  it('requires graph evidence for each touched convention surface domain', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: [
        'packages/mcp-server/src/tools/callback-tools.ts',
        'cat-cafe-skills/convention-graph-discovery/SKILL.md',
      ],
      changedFileEvents: [
        { path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 },
        { path: 'cat-cafe-skills/convention-graph-discovery/SKILL.md', eventNo: 11 },
      ],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain skill-manifest --kind skill',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('cat-cafe-skills/convention-graph-discovery/SKILL.md', 'skill-manifest'),
          eventNo: 5,
        },
      ],
    });

    assert.equal(result.status, 'violation');
    assert.ok(result.violation);
    assert.match(result.violation.message, /mcp-tool/);
  });

  it('passes when every touched convention surface domain has graph evidence', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: [
        'packages/mcp-server/src/tools/callback-tools.ts',
        'cat-cafe-skills/convention-graph-discovery/SKILL.md',
      ],
      changedFileEvents: [
        { path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 },
        { path: 'cat-cafe-skills/convention-graph-discovery/SKILL.md', eventNo: 11 },
      ],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          eventNo: 5,
        },
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain skill-manifest --kind skill',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('cat-cafe-skills/convention-graph-discovery/SKILL.md', 'skill-manifest'),
          eventNo: 6,
        },
      ],
    });

    assert.equal(result.status, 'pass');
  });

  it('requires graph evidence for every touched convention surface within the same domain', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: [
        'packages/mcp-server/src/tools/callback-tools.ts',
        'packages/mcp-server/src/tools/scheduler-tools.ts',
      ],
      changedFileEvents: [
        { path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 },
        { path: 'packages/mcp-server/src/tools/scheduler-tools.ts', eventNo: 11 },
      ],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          eventNo: 5,
        },
      ],
    });

    assert.equal(result.status, 'violation');
    assert.ok(result.violation);
    assert.match(result.violation.message, /mcp-tool/);
  });

  it('passes when same-domain convention surface coverage is split across pre-edit commands', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: [
        'packages/mcp-server/src/tools/callback-tools.ts',
        'packages/mcp-server/src/tools/scheduler-tools.ts',
      ],
      changedFileEvents: [
        { path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 },
        { path: 'packages/mcp-server/src/tools/scheduler-tools.ts', eventNo: 11 },
      ],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          eventNo: 5,
        },
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/scheduler-tools.ts'),
          eventNo: 6,
        },
      ],
    });

    assert.equal(result.status, 'pass');
  });

  it('requires ordering evidence for every touched convention surface file', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: [
        'packages/mcp-server/src/tools/callback-tools.ts',
        'packages/mcp-server/src/tools/scheduler-tools.ts',
      ],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/scheduler-tools.ts', eventNo: 11 }],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          exitCode: 0,
          stdout: freshCodeConsumersStdoutForTargets([
            'packages/mcp-server/src/tools/callback-tools.ts',
            'packages/mcp-server/src/tools/scheduler-tools.ts',
          ]),
          eventNo: 5,
        },
      ],
    });

    assert.equal(result.status, 'violation');
    assert.ok(result.violation);
    assert.match(result.violation.traceAnchor, /callback-tools\.ts/);
  });

  it('accepts a graph target that covers the changed MCP convention surface without being the same file', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: ['packages/mcp-server/src/tools/publish-verdict-sop-source-refs.ts'],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/publish-verdict-sop-source-refs.ts', eventNo: 10 }],
      commands: [
        {
          command:
            'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name cat_cafe_publish_verdict',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/publish-verdict-tool.ts'),
          eventNo: 5,
        },
      ],
    });

    assert.equal(result.status, 'pass');
  });

  it('rejects stale convention graph results even when the command exited successfully', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: ['packages/mcp-server/src/tools/callback-tools.ts'],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 }],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          exitCode: 0,
          stdout: staleCodeConsumersStdout,
          eventNo: 5,
        },
      ],
    });

    assert.equal(result.status, 'violation');
    assert.ok(result.violation);
    assert.match(result.violation.message, /fresh/i);
  });

  it('rejects fresh graph results collected after the convention surface edit', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: ['packages/mcp-server/src/tools/callback-tools.ts'],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 }],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          eventNo: 20,
        },
      ],
    });

    assert.equal(result.status, 'violation');
    assert.ok(result.violation);
    assert.match(result.violation.message, /before|pre-edit/i);
  });

  it('rejects fresh graph results with no matched targets', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: ['packages/mcp-server/src/tools/callback-tools.ts'],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 }],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name typo',
          exitCode: 0,
          stdout: freshCodeConsumersWithoutTargetsStdout,
          eventNo: 5,
        },
      ],
    });

    assert.equal(result.status, 'violation');
    assert.ok(result.violation);
    assert.match(result.violation.message, /target|domain|fresh/i);
  });

  it('rejects fresh graph results whose targets do not match the changed convention surface', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: ['packages/mcp-server/src/tools/callback-tools.ts'],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 10 }],
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name other',
          exitCode: 0,
          stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/scheduler-tools.ts'),
          eventNo: 5,
        },
      ],
    });

    assert.equal(result.status, 'violation');
    assert.ok(result.violation);
    assert.match(result.violation.message, /target|domain|fresh/i);
  });
});
