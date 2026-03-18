import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RemoteLimbNode } from '../dist/domains/limb/RemoteLimbNode.js';

const BASE_CONFIG = {
  nodeId: 'win-server-1',
  displayName: 'Windows Dev Server',
  platform: 'windows',
  capabilities: [{ cap: 'exec', commands: ['exec.run'], authLevel: 'leased' }],
  endpointUrl: 'http://192.168.1.100:8080',
};

describe('RemoteLimbNode', () => {
  it('invoke forwards to remote endpoint', async () => {
    let capturedUrl, capturedBody;
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      fetchFn: async (url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ success: true, data: 'build output' }) };
      },
    });

    const result = await node.invoke('exec.run', { script: 'dotnet build' });
    assert.equal(result.success, true);
    assert.equal(result.data, 'build output');
    assert.equal(capturedUrl, 'http://192.168.1.100:8080/invoke');
    assert.equal(capturedBody.command, 'exec.run');
    assert.deepEqual(capturedBody.params, { script: 'dotnet build' });
  });

  it('invoke returns error on network failure', async () => {
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const result = await node.invoke('exec.run', {});
    assert.equal(result.success, false);
    assert.ok(result.error.includes('ECONNREFUSED'));
  });

  it('invoke returns error on HTTP failure', async () => {
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      fetchFn: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) }),
    });

    const result = await node.invoke('exec.run', {});
    assert.equal(result.success, false);
    assert.ok(result.error.includes('503'));
  });

  it('healthCheck returns status from remote', async () => {
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      fetchFn: async () => ({ ok: true, json: async () => ({ status: 'busy' }) }),
    });

    assert.equal(await node.healthCheck(), 'busy');
  });

  it('healthCheck returns offline on network failure', async () => {
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      fetchFn: async () => {
        throw new Error('ETIMEDOUT');
      },
    });

    assert.equal(await node.healthCheck(), 'offline');
  });

  it('healthCheck returns online for unknown status', async () => {
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      fetchFn: async () => ({ ok: true, json: async () => ({ status: 'unknown_value' }) }),
    });

    assert.equal(await node.healthCheck(), 'online');
  });

  it('sends auth header when apiKey configured', async () => {
    let capturedHeaders;
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      apiKey: 'secret-token',
      fetchFn: async (_url, init) => {
        capturedHeaders = init.headers;
        return { ok: true, json: async () => ({ success: true }) };
      },
    });

    await node.invoke('exec.run', {});
    assert.equal(capturedHeaders['Authorization'], 'Bearer secret-token');
  });

  it('strips trailing slash from endpointUrl', async () => {
    let capturedUrl;
    const node = new RemoteLimbNode({
      ...BASE_CONFIG,
      endpointUrl: 'http://192.168.1.100:8080/',
      fetchFn: async (url) => {
        capturedUrl = url;
        return { ok: true, json: async () => ({ success: true }) };
      },
    });

    await node.invoke('exec.run', {});
    assert.equal(capturedUrl, 'http://192.168.1.100:8080/invoke');
  });

  it('register and deregister are no-ops', async () => {
    const node = new RemoteLimbNode(BASE_CONFIG);
    await node.register(); // should not throw
    await node.deregister(); // should not throw
  });
});
