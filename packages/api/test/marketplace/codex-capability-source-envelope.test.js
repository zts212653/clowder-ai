// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function emptyCapabilityResponses() {
  return new Map([
    ['skills/list', { data: [] }],
    ['app/list', { data: [] }],
    ['app/installed', { apps: [] }],
    ['plugin/list', { marketplaces: [] }],
    ['plugin/installed', { marketplaces: [] }],
    ['mcpServerStatus/list', { data: [] }],
  ]);
}

describe('Codex capability collection envelopes', () => {
  it('degrades partial inventory when any required provider collection envelope is malformed', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const normalSkills = {
      data: [
        {
          cwd: '/workspace',
          errors: [],
          skills: [{ name: 'still-visible', description: 'Healthy evidence survives', enabled: true, scope: 'repo' }],
        },
      ],
    };
    const malformed = new Map([
      ['skills/list', { data: { secret: 'must-not-leak' } }],
      ['app/list', { data: { secret: 'must-not-leak' } }],
      ['app/installed', { apps: null }],
      ['plugin/list', { marketplaces: 'not-an-array' }],
      ['plugin/installed', {}],
      ['mcpServerStatus/list', { data: false }],
    ]);

    for (const [method, response] of malformed) {
      const responses = emptyCapabilityResponses();
      responses.set('skills/list', normalSkills);
      responses.set(method, response);
      const snapshot = await collectCodexCapabilitySource({
        cwd: '/workspace',
        providerVersion: '0.153.4',
        request: async (requestedMethod) => responses.get(requestedMethod),
      });

      assert.equal(snapshot.availability, 'degraded', method);
      assert.ok(snapshot.issues.length <= 20, method);
      assert.ok(
        snapshot.issues.some((issue) => issue.includes(method)),
        method,
      );
      assert.ok(
        snapshot.issues.every((issue) => issue.length <= 200),
        method,
      );
      assert.ok(
        snapshot.issues.every((issue) => !issue.includes('must-not-leak')),
        method,
      );
      if (method !== 'skills/list') {
        assert.ok(
          snapshot.artifacts.some((artifact) => artifact.name === 'still-visible'),
          method,
        );
      }
    }
  });

  it('degrades malformed nested collections and count containers without hiding healthy artifacts', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const responses = emptyCapabilityResponses();
    responses.set('skills/list', {
      data: [
        {
          cwd: '/workspace',
          errors: [],
          skills: [{ name: 'healthy-skill', description: 'Visible', enabled: true, scope: 'repo' }],
        },
        { cwd: '/workspace', errors: {}, skills: {} },
      ],
    });
    responses.set('plugin/list', {
      marketplaceLoadErrors: {},
      marketplaces: [{ name: 'broken', plugins: {} }],
    });
    responses.set('plugin/installed', {
      marketplaceLoadErrors: 'not-an-array',
      marketplaces: [{ name: 'broken', plugins: null }],
    });
    responses.set('mcpServerStatus/list', {
      data: [
        {
          name: 'malformed-counts',
          authStatus: 'notAuthenticated',
          runtimeStatus: 'notStarted',
          tools: [],
          resources: {},
          resourceTemplates: null,
        },
      ],
    });

    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.153.4',
      request: async (method) => responses.get(method),
    });

    assert.equal(snapshot.availability, 'degraded');
    assert.ok(snapshot.artifacts.some((artifact) => artifact.name === 'healthy-skill'));
    assert.ok(snapshot.issues.some((issue) => /errors.*collection/i.test(issue)));
    assert.ok(snapshot.issues.some((issue) => /skills.*collection/i.test(issue)));
    assert.ok(snapshot.issues.some((issue) => /plugins.*collection/i.test(issue)));
    assert.ok(snapshot.issues.some((issue) => /marketplaceLoadErrors.*collection/i.test(issue)));
    assert.ok(snapshot.issues.some((issue) => /MCP tools.*container/i.test(issue)));
    assert.ok(snapshot.issues.some((issue) => /MCP resources.*collection/i.test(issue)));
    assert.ok(snapshot.issues.some((issue) => /MCP resource templates.*collection/i.test(issue)));
  });

  it('keeps valid empty provider collections live and issue-free', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const responses = emptyCapabilityResponses();
    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.153.4',
      request: async (method) => responses.get(method),
    });

    assert.equal(snapshot.availability, 'live');
    assert.deepEqual(snapshot.artifacts, []);
    assert.deepEqual(snapshot.issues, []);
  });
});
