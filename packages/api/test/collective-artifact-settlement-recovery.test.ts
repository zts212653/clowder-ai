import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readArtifactJsonPages } from '../../collective-client/src/collective-artifact-client.js';
import { sharedProposal } from './collective-artifact-proposal.fixture.js';
import { custodyHttpFixture } from './collective-custody-http.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

for (const disposition of ['accepted', 'pending', 'escaped-body'])
  test(`a current read-only member recovers ${disposition} owner adoption after the adopter is revoked and both stores reopen`, async (t) => {
    const f = await custodyHttpFixture(
      t,
      undefined,
      disposition === 'escaped-body'
        ? {
            text: `# shared\n真实正文\n${'\u0001'.repeat(54000)}`,
          }
        : {},
    );
    const selection = await sharedProposal(f);
    if (disposition === 'pending')
      f.modifications.acceptances.collective.complete = () => {
        throw new Error('simulated crash between owner receipt and disposition completion');
      };
    const settle = f.contentOwner.settle.bind(f.contentOwner);
    f.contentOwner.settle = async (input) => {
      const receipt = await settle(input);
      await f.store.updateArtifactAccess(f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: f.artifact.artifactId,
        humanId: f.owner.human.humanId,
        expectedAccessRevision: 1,
        access: 'revoked',
        requestId: 'revoke-adopter-after-real-effect',
      });
      return receipt;
    };
    const lost = await f.invoke(f.owner.sessionToken, 'apply', selection, 'original-adoption');
    assert.equal(lost.status, 403);
    assert.equal((await f.contentOwner.describe(f.artifact.contentRef)).currentOwnerRevision, 2);
    assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0].versions.length, 1);
    await f.restartSource();
    await f.restartService();
    assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0].canApply, false);
    const execute = f.sourceRoot.execute.bind(f.sourceRoot);
    type Recovery = {
      receipt: { operationContext: { scopeRef: string; actorHumanId: string } };
      lineage: { sourceEventId: string; requestId: string };
    };
    const corruptions: Record<string, (first: Recovery) => void> = {
      scope: (first) => {
        first.receipt.operationContext.scopeRef = 'another-private-scope';
      },
      actor: (first) => {
        first.receipt.operationContext.actorHumanId = f.member.human.humanId;
      },
      source: (first) => {
        first.lineage.sourceEventId = 'another-public-source';
      },
      request: (first) => {
        first.lineage.requestId = 'another-owner-request';
      },
    };
    for (const [corrupt, tamper] of Object.entries(corruptions)) {
      f.connector.setArtifactOwner({
        execute: async (operation, authority) => {
          const result = await execute(operation, authority);
          if (result.status === 'ok') {
            const forged = structuredClone(result);
            const batch = forged.value.settlementRecovery as { settlements: Recovery[] };
            tamper(batch.settlements[0]);
            return forged;
          }
          return result;
        },
      });
      assert.equal((await f.invoke(f.member.sessionToken, 'read', {}, `corrupt-${corrupt}`)).status, 403);
      assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0].versions.length, 1);
    }
    f.connector.setArtifactOwner({
      execute: async (operation, authority) => {
        const result = await execute(operation, authority);
        await f.store.updateArtifactAccess(f.owner.sessionToken, {
          ...f.coordinates,
          artifactId: f.artifact.artifactId,
          humanId: f.member.human.humanId,
          expectedAccessRevision: 1,
          access: 'revoked',
          requestId: 'revoke-recovery-reader-before-disclosure',
        });
        return result;
      },
    });
    assert.equal((await f.invoke(f.member.sessionToken, 'read', {}, 'revoked-during-recovery')).status, 403);
    assert.equal(f.store.listArtifacts(f.member.sessionToken, f.coordinates).length, 0);
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: f.member.human.humanId,
      expectedAccessRevision: 2,
      access: 'read',
      requestId: 'restore-reader-with-fresh-revision',
    });
    f.connector.setArtifactOwner(f.sourceRoot);
    const recovered = await f.invoke(f.member.sessionToken, 'read', {}, 'reader-reconciles');
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    assert.equal(recovered.value.value.catalogueReconciled, true);
    const catalogue = f.store.listArtifacts(f.member.sessionToken, f.coordinates);
    assert.equal(
      catalogue[0].versionCount,
      2,
      'read authority can recover historical effect without new apply authority',
    );
    const receipt = (await f.contentOwner.listOutbox(f.artifact.contentRef))[1];
    assert.equal(catalogue[0].versions.length, 1);
    assert.equal(catalogue[0].versions[0].receiptRef, receipt.receiptId);
    assert.equal(catalogue[0].versions[0].adoptedByHumanId, f.owner.human.humanId);
    assert.equal(catalogue[0].versions[0].lineage?.requestId, selection.requestId);
    const history = await f.post('history', f.member.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      sourceEventId: f.source.eventId,
      offset: 0,
      limit: 30,
    });
    assert.equal(history.status, 200, JSON.stringify(history));
    assert.equal(history.value.total, 2);
    assert.deepEqual(
      history.value.versions.map((version: { ownerRevision: number }) => version.ownerRevision),
      [2, 1],
    );
    assert.equal(history.value.versions[0].receiptRef, receipt.receiptId);
    assert.equal(
      JSON.stringify(recovered.value).includes('operationContext'),
      false,
      'private recovery envelope is stripped',
    );
    assert.equal((await f.invoke(f.member.sessionToken, 'apply', selection, 'reader-cannot-adopt')).status, 403);
    assert.equal((await f.invoke(f.owner.sessionToken, 'read', {}, 'revoked-reader')).status, 403);
    const latest = (await readArtifactJsonPages(async (page) => {
      const result = await f.invoke(f.member.sessionToken, 'read', page, 'read-recovered');
      assert.equal(result.status, 200, JSON.stringify(result));
      return result.value.value;
    })) as { text: string };
    assert.equal(latest.text, f.text.replace('真实正文', '共享正文'));
    const historical = (await readArtifactJsonPages(async (page) => {
      let done = false;
      const pending = f
        .post('owner/request', f.member.sessionToken, {
          ...f.coordinates,
          artifactId: f.artifact.artifactId,
          sourceEventId: f.source.eventId,
          action: 'read',
          ownerRevision: 1,
          payload: page,
          requestId: 'explicit-history-after-reconciliation',
        })
        .finally(() => {
          done = true;
        });
      await f.drive(() => done);
      const response = await pending;
      assert.equal(response.status, 200, JSON.stringify(response));
      return response.value.value;
    })) as { text: string; view: { historyReadOnly: boolean }; catalogueReconciled?: boolean };
    assert.equal(historical.text, f.text);
    assert.equal(historical.view.historyReadOnly, true);
    assert.equal(historical.catalogueReconciled, undefined);
    await f.restartService();
    const reopened = f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0];
    assert.equal(reopened.versionCount, 2);
    assert.equal(reopened.versions.length, 1);
    assert.equal(reopened.versions[0].receiptRef, receipt.receiptId);
    await f.invoke(f.member.sessionToken, 'history', {}, 'replay-recovered');
    assert.equal((await f.contentOwner.listOutbox(f.artifact.contentRef)).length, 2);
    const state = await readFile(join(f.root, 'service', 'collective-service.json'), 'utf8');
    assert.equal(state.includes('replacement'), false);
    assert.equal(state.includes(f.text), false);
  });
