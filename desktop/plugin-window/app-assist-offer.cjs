const { randomUUID } = require('node:crypto');

// One transient hint belongs to this trusted Host page scope, never the API or renderer.
function createAppAssistOffer({ now, setTimer, clearTimer, onChange = () => {} }) {
  let scopeRef = randomUUID();
  let revision = 0;
  let status = 'off';
  let offer = null;
  let deadline = 0;
  let timer;
  let generation = 0;
  function clear() {
    generation++;
    clearTimer(timer);
    timer = undefined;
    offer = null;
    revision++;
    onChange();
  }
  function expire() {
    if (offer && now() >= deadline) clear();
  }
  return {
    get generation() {
      return generation;
    },
    snapshot() {
      expire();
      return { scopeRef, revision, status, offer: offer && { ...offer } };
    },
    status(value) {
      status = value;
      clear();
    },
    reset() {
      scopeRef = randomUUID();
      revision = 0;
      status = 'suspended';
      clear();
    },
    publish(appName) {
      expire();
      if (status !== 'ready' || offer) return false;
      offer = { offerRef: randomUUID(), appName };
      deadline = now() + 15000;
      revision++;
      timer = setTimer(expire, 15000);
      timer?.unref?.();
      onChange();
      return true;
    },
    settle(command) {
      expire();
      const matched =
        command.scopeRef === scopeRef &&
        command.offerRef === offer?.offerRef &&
        ['dismiss', 'timeout', 'accept'].includes(command.action) &&
        status === 'ready';
      if (matched) clear();
      return {
        kind: 'app-assist-settlement',
        scopeRef,
        revision,
        offerRef: command.offerRef,
        action: command.action,
        outcome: matched ? 'settled' : 'stale_offer',
      };
    },
  };
}
module.exports = { createAppAssistOffer };
