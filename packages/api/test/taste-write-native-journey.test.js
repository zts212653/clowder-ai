import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { F221ApprovalAdapter } from '../dist/domains/approval-hub/adapters/F221ApprovalAdapter.js';
import { createVignetteWriter } from '../dist/domains/taste/services/writeVignette.js';
import { memoryProposalNativeClient } from './helpers/memory-proposal-native-client.js';
import { tasteAdmissionFixture, tasteDraft } from './helpers/taste-admission-fixture.js';
import { createRemoteFixture, remoteFile, remoteHead } from './taste-publication-fixtures.js';

test(
  'real MCP proposal → original browser approval → isolated Git publication → same-request recovery',
  { timeout: 30_000 },
  async () => {
    const repository = createRemoteFixture();
    let fixture;
    let client;
    try {
      fixture = await tasteAdmissionFixture({ writeVignette: createVignetteWriter(repository.runtime) });
      const source = await fixture.source();
      const auth = await fixture.auth(source);
      const api = await fixture.app.listen({ port: 0, host: '127.0.0.1' });
      client = await memoryProposalNativeClient(api, auth, repository.root);
      const initialHead = remoteHead(repository);
      const input = {
        ...tasteDraft,
        privacy: 'public',
        scene: 'First approved line\nSecond approved line',
        clientRequestId: 'm3-native-taste-request',
        sourceMessageId: source.id,
      };
      const response = await client.callTool({ name: 'cat_cafe_propose_taste', arguments: input });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const proposed = JSON.parse(response.content.find((part) => part.type === 'text').text);
      assert.equal(proposed.status, 'pending');
      assert.equal(remoteHead(repository), initialHead, 'proposing must not write the public repository');
      const [item] = await new F221ApprovalAdapter(fixture.store).listPending('alice');
      assert.equal(item.proposalId, proposed.proposalId);
      assert.equal(item.detail.scene, input.scene);
      const origin = 'http://localhost:3003';
      const session = await fixture.app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
      const approved = await fixture.app.inject({
        method: 'POST',
        url: `/api/taste-proposals/${proposed.proposalId}/approve`,
        headers: {
          origin,
          cookie: session.headers['set-cookie'].split(';', 1)[0],
          'x-csrf-token': session.json().csrfToken,
        },
        payload: { decisionDigest: item.detail.decisionDigest },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      const path = approved.json().vignettePath;
      assert.match(path, /^docs\/taste\/vignettes\//);
      const document = remoteFile(repository, path);
      const fields = parseYaml(document.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)[1]);
      assert.deepEqual(
        { scene: fields.scene, quote: fields.quotes[0], takeaway: fields.takeaway, tags: fields.tags },
        { scene: input.scene, quote: input.quote, takeaway: input.takeaway, tags: input.tags },
      );
      assert.equal(
        document.includes(source.id),
        false,
        'private message provenance must not be projected to the repository',
      );
      const publishedHead = remoteHead(repository);
      assert.notEqual(publishedHead, initialHead);
      await client.close();
      const later = await fixture.source({ content: 'Recover that exact earlier request' });
      client = await memoryProposalNativeClient(api, await fixture.auth(later), repository.root);
      const replay = await client.callTool({ name: 'cat_cafe_propose_taste', arguments: input });
      assert.notEqual(replay.isError, true, JSON.stringify(replay));
      const recovered = JSON.parse(replay.content.find((part) => part.type === 'text').text);
      assert.equal(recovered.proposalId, proposed.proposalId);
      assert.equal(recovered.status, 'approved');
      assert.equal(remoteHead(repository), publishedHead);
      const replacedSource = await client.callTool({
        name: 'cat_cafe_propose_taste',
        arguments: { ...input, sourceMessageId: later.id },
      });
      assert.equal(replacedSource.isError, true, JSON.stringify(replacedSource));
      assert.ok(JSON.stringify(replacedSource).includes('client_request_conflict'));
      const conflict = await client.callTool({
        name: 'cat_cafe_propose_taste',
        arguments: { ...input, scene: 'Changed under the same key' },
      });
      assert.equal(conflict.isError, true);
      assert.ok(JSON.stringify(conflict).includes('client_request_conflict'));
      assert.equal(remoteHead(repository), publishedHead);
    } finally {
      await client?.close();
      await fixture?.app.close();
      rmSync(repository.root, { recursive: true, force: true });
    }
  },
);
