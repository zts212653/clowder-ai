'use strict';

const { randomBytes } = require('node:crypto');

/**
 * F335 交付三：桌面投递（Host 侧）。什么时候带：人在、且 API 说可能有新东西 → 问「人在」那份；人刚回来 → 问「回来」那份。
 * 桌面隐藏或停用时不投、不丢（东西在 API 那边还是待投递）。渲染器只拿到合同里的有界形状和引用，处置由这里按
 * 每条的 revision 转回「给人的东西」。缩略图这一版不提供（`thumbnail: false`，渲染器画中性小块）。
 */
const ref = () => randomBytes(12).toString('base64url');

function toContractItem(item) {
  return {
    itemRef: item.ref,
    kind: item.kind,
    title: item.title,
    ...(item.sentence ? { sentence: item.sentence } : {}),
    source: item.threadTitle ? { conversationTitle: item.threadTitle } : {},
    action: item.action,
    thumbnail: false,
  };
}

function sender(items) {
  const [first] = items;
  if (!first || items.some((item) => item.catId !== first.catId || item.byline !== first.byline)) return null;
  return {
    catId: first.catId,
    displayName: first.catName,
    ...(first.byline === 'watcher' ? { role: 'watcher' } : {}),
  };
}

function createDeskDeliveryHost({ owner, activity, onChange = () => {}, newRef = ref }) {
  const scopeRef = newRef();
  let revision = 0;
  let visible = false;
  let closed = false;
  let current = null; // { deliveryRef, delivery, lines: Map(itemRef → { ref, revision, done }) }
  let asking = null;
  let nudged = false;
  let queue = Promise.resolve();

  const status = () => (closed ? 'off' : visible ? 'ready' : 'suspended');
  function publish() {
    revision += 1;
    onChange();
  }
  function snapshot() {
    return { scopeRef, revision, status: status(), delivery: visible && current ? current.delivery : null };
  }

  async function ask(returning) {
    if (closed || !visible || current) return;
    if (asking) {
      nudged = true;
      return asking;
    }
    asking = (async () => {
      try {
        const delivery = await owner.next(returning);
        if (closed || !visible || current || !delivery || !Array.isArray(delivery.items) || !delivery.items.length)
          return;
        const deliveryRef = newRef();
        current = {
          deliveryRef,
          lines: new Map(
            delivery.items.map((item) => [item.ref, { ref: item.ref, revision: item.revision, done: false }]),
          ),
          delivery: {
            deliveryRef,
            mode: delivery.mode === 'single' && delivery.items.length === 1 ? 'single' : 'bundle',
            from: sender(delivery.items),
            items: delivery.items.map(toContractItem),
            more: Number.isInteger(delivery.more) && delivery.more > 0 ? delivery.more : 0,
          },
        };
        publish();
      } catch {
        // The owner is unavailable: nothing is lost, the API still holds every pending line.
      } finally {
        asking = null;
      }
    })();
    return asking;
  }

  function finish() {
    current = null;
    publish();
    if (nudged) {
      nudged = false;
      if (activity.presence() === 'present') void ask(false);
    }
  }

  async function settle(command) {
    const reply = (outcome, extra = {}) => ({
      kind: 'desk-settlement',
      scopeRef,
      revision,
      deliveryRef: command.deliveryRef,
      action: command.action,
      ...(command.itemRef ? { itemRef: command.itemRef } : {}),
      outcome,
      ...extra,
    });
    if (command.scopeRef !== scopeRef || !current || command.deliveryRef !== current.deliveryRef)
      return reply('stale_delivery');
    const single = command.action === 'open' || command.action === 'add';
    const lines = single
      ? [current.lines.get(command.itemRef)].filter((line) => line && !line.done)
      : [...current.lines.values()].filter((line) => !line.done);
    if (!lines.length) return reply('stale_delivery');
    let result;
    try {
      result = await owner.settle({
        action: command.action,
        items: lines.map((line) => ({ ref: line.ref, revision: line.revision })),
      });
    } catch {
      return reply('failed');
    }
    const byRef = new Map((result?.items ?? []).map((item) => [item.ref, item]));
    let settled = 0;
    let failed = 0;
    for (const line of lines) {
      const outcome = byRef.get(line.ref);
      if (!outcome || outcome.outcome === 'failed') {
        failed += 1;
        continue;
      }
      line.revision = outcome.revision;
      if (outcome.outcome === 'stale' || command.action !== 'shown') line.done = true;
      if (outcome.outcome === 'settled') settled += 1;
    }
    const saved = command.action === 'timeout' && result?.saved === true;
    if (
      command.action === 'dismiss' ||
      command.action === 'timeout' ||
      [...current.lines.values()].every((l) => l.done)
    )
      finish();
    return reply(settled ? 'settled' : failed ? 'failed' : 'stale_delivery', saved ? { saved: true } : {});
  }

  /** The bringer's avatar for the delivery that is up; never for another cat or an old delivery. */
  async function readAvatar(command) {
    const reply = (image) => ({ kind: 'desk-avatar', scopeRef, deliveryRef: command.deliveryRef, image });
    const from = current?.delivery.from;
    if (command.scopeRef !== scopeRef || !current || command.deliveryRef !== current.deliveryRef || !from)
      return reply(null);
    try {
      return reply((await owner.avatar(from.catId)) ?? null);
    } catch {
      return reply(null);
    }
  }

  return {
    snapshot,
    /** Window shown / hidden by the person (or disabled). */
    setVisible(next) {
      if (closed || visible === next) return;
      visible = next;
      publish();
      if (visible && activity.presence() === 'present') void ask(false);
    },
    /** API: something may be ready. Only brings it now when the person is at the desk. */
    changed() {
      if (closed) return;
      if (current) nudged = true;
      else if (activity.presence() === 'present') void ask(false);
    },
    /** From the user-activity signal. */
    presenceChanged({ returned }) {
      if (returned) void ask(true);
    },
    /** Renderer commands for the desk; anything else is not ours. */
    request(command) {
      if (command?.kind === 'desk.avatar.read') return readAvatar(command);
      if (command?.kind === 'desk.thumbnail.read') {
        return Promise.resolve({
          kind: 'desk-thumbnail',
          scopeRef,
          deliveryRef: command.deliveryRef,
          itemRef: command.itemRef,
          image: null,
        });
      }
      const run = queue.then(() => settle(command));
      queue = run.catch(() => {});
      return run;
    },
    close() {
      closed = true;
      current = null;
      publish();
    },
  };
}

module.exports = { createDeskDeliveryHost };
