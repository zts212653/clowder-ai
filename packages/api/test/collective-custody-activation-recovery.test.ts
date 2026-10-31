import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  custodyAuthority,
  custodyModification,
  custodyTransfer,
  emptyCustodyOwner,
} from './collective-custody-transfer.fixture.js';
import { baseConstraint, fixture } from './collective-markdown.fixture.js';

for (const crashAt of ['review', 'modification', 'activation']) {
  test(`a target crash at ${crashAt} leaves the whole scope unavailable and resumes one committed activation`, async (t) => {
    const f = await fixture(t);
    await custodyModification(f, 'request-in-activation-cut');
    const target = await emptyCustodyOwner(t);
    let transfer = await custodyTransfer(f.owner);
    const sourceAuthority = custodyAuthority(() => transfer, 'source');
    const targetAuthority = custodyAuthority(() => transfer, 'target');
    assert.ok(f.port.custody);
    const prepared = await f.port.custody.prepareSource(transfer, sourceAuthority);
    transfer = { ...transfer, state: 'source_prepared', prepared };
    assert.ok(target.current.root.custody);
    for (let index = 0; index < prepared.manifest.pageCount; index++)
      await target.current.root.custody.stageTarget(
        transfer,
        await f.port.custody.readPage(transfer, index, sourceAuthority),
        targetAuthority,
      );
    const ready = await target.current.root.custody.attestReady(transfer, targetAuthority);
    transfer = { ...transfer, state: 'committed', ready };
    const broken = () => {
      throw new Error('simulated process loss between durable owner stores');
    };
    if (crashAt === 'review') target.current.reviews.collectiveCustody.installSnapshot = broken;
    else if (crashAt === 'modification') target.current.modifications.collectiveCustody.installSnapshot = broken;
    else {
      const activate = target.current.owner.collectiveCustody.fence.activateTarget.bind(
        target.current.owner.collectiveCustody.fence,
      );
      target.current.owner.collectiveCustody.fence.activateTarget = async (...args) => {
        await activate(...args);
        broken();
      };
    }
    await assert.rejects(target.current.root.custody.finalize(transfer, targetAuthority), /simulated process loss/);
    const constraint = { ...baseConstraint, custodyRevision: 2 };
    const read = () =>
      target.current.root.execute(
        {
          relayRef: 'recovery-read',
          requestId: 'recovery-read',
          constraint,
          payload: {},
          expiresAt: Date.now() + 10000,
        },
        { reauthorize: async () => constraint },
      );
    // Activation is published only after all three stores install. Earlier crashes cannot reveal partial history.
    if (crashAt !== 'activation')
      assert.deepEqual(await read(), { status: 'error', error: { code: 'owner_unavailable' } });
    target.reopen();
    assert.ok(target.current.root.custody);
    await target.current.root.custody.finalize(transfer, targetAuthority);
    assert.equal((await read()).status, 'ok');
    await target.current.root.custody.finalize(transfer, targetAuthority);
    assert.equal((await target.current.owner.listOutbox(baseConstraint.contentRef)).length, 1);
  });
}
