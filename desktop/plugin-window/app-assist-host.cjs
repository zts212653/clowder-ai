const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createAppAssistOffer } = require('./app-assist-offer.cjs');
const { validApplication } = require('./app-assist-validation.cjs');

// Internal trusted interface: owner never receives names/bundleIds; renderer never calls observe/read/claim.
function createAppAssistHost({
  owner,
  sourceFactory,
  selfBundleIds,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange,
  validateReply,
}) {
  const offer = createAppAssistOffer({ now, setTimer, clearTimer, onChange });
  const self = new Set(selfBundleIds);
  let source;
  let stopping = Promise.resolve();
  let unconfirmed = false;
  let visible = false;
  let closed = false;
  let pending;
  let starting;
  let lifecycle = 0;
  function pause(status) {
    lifecycle++;
    offer.status(status); // Fence pending work before awaiting native cleanup or saved settings.
    const previous = source;
    source = undefined;
    pending = undefined;
    if (previous)
      stopping = stopping
        .then(() => previous.close())
        .catch(() => {
          offer.status('source_unavailable');
        });
    return stopping;
  }
  async function observe(value, epoch, keyScope) {
    if (
      closed ||
      !visible ||
      unconfirmed ||
      epoch !== lifecycle ||
      !validApplication(value) ||
      self.has(value.bundleId) ||
      pending ||
      offer.snapshot().status !== 'ready' ||
      offer.snapshot().offer
    )
      return;
    const token = {};
    const offerEpoch = offer.generation;
    pending = token;
    const appKey = createHash('sha256')
      .update(JSON.stringify(['cat-cafe.app-assist.v1', keyScope, value.bundleId]))
      .digest('hex');
    try {
      const result = await owner.claim(appKey);
      if (epoch !== lifecycle || offerEpoch !== offer.generation || closed || !visible || unconfirmed) return;
      if (result === 'claimed') offer.publish(value.name);
      else if (result === 'disabled') await pause('off');
      else if (!['already_claimed', 'clock_rollback', 'capacity'].includes(result)) await pause('source_unavailable');
    } catch {
      if (epoch === lifecycle) await pause('source_unavailable');
    } finally {
      if (pending === token) pending = undefined;
    }
  }
  async function resume() {
    visible = true;
    if (closed || unconfirmed) {
      await pause('suspended');
      return offer.snapshot();
    }
    if (starting) {
      const previous = starting;
      await previous;
      if (starting === previous) starting = undefined;
      return resume();
    }
    if (source && offer.snapshot().status === 'ready') return offer.snapshot();
    starting = (async () => {
      await stopping;
      const epoch = lifecycle;
      try {
        const policy = await owner.read();
        if (closed || !visible || unconfirmed || epoch !== lifecycle) return offer.snapshot();
        if (policy.status !== 'ready' || typeof policy.keyScope !== 'string') {
          offer.status(
            ['off', 'timezone_required', 'unsupported', 'identity_unavailable'].includes(policy.status)
              ? policy.status
              : 'source_unavailable',
          );
          return offer.snapshot();
        }
        offer.status('ready');
        const activeEpoch = lifecycle;
        const opened = await sourceFactory(
          (value) => observe(value, activeEpoch, policy.keyScope),
          () => {
            if (activeEpoch === lifecycle) void pause('source_unavailable');
          },
        );
        if (closed || !visible || unconfirmed || activeEpoch !== lifecycle) await opened.close();
        else source = opened;
      } catch (error) {
        if (!closed && visible && epoch === lifecycle)
          offer.status(
            error?.code === 'permission_required'
              ? 'permission_required'
              : error?.code === 'unsupported'
                ? 'unsupported'
                : 'source_unavailable',
          );
        else if (!source && offer.snapshot().status === 'ready') offer.status('source_unavailable');
      }
      return offer.snapshot();
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }
  async function checked(reply) {
    if (!validateReply || validateReply(reply)) return reply;
    await pause('source_unavailable');
    return { kind: 'error', code: 'unavailable' };
  }
  return {
    resume,
    snapshot: () => offer.snapshot(),
    settle: (command) => offer.settle(command),
    async request(command, forward) {
      if (command.kind === 'app-assist.settle') return checked(offer.settle(command));
      const setting = command.kind === 'settings.update' && command.field === 'appAssistEnabled';
      if (!setting) return checked(await forward(command));
      unconfirmed = true;
      await pause('suspended');
      const reply = await forward(command);
      if (reply.kind === 'settings-update' && reply.outcome === 'saved') {
        unconfirmed = false;
        if (visible) await resume();
      }
      return checked(reply);
    },
    policyChanged(allowed) {
      if (unconfirmed) return pause('suspended');
      if (allowed !== true) return pause(allowed === false ? 'off' : 'source_unavailable');
      if (visible && !unconfirmed && !closed) return resume();
      return Promise.resolve();
    },
    suspend() {
      visible = false;
      return pause('suspended');
    },
    reset() {
      visible = false;
      offer.reset();
      return pause('suspended');
    },
    close() {
      closed = true;
      visible = false;
      return pause('suspended');
    },
  };
}
module.exports = { createAppAssistHost };
