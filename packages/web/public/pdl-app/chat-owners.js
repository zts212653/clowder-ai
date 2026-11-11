/* Conversation owners: raw host pushes, held by the console, projected here. */
'use strict';
function chatOwnerData() {
  return chatDataSnapshot.project && chatDataSnapshot.project.chatOwners;
}
function chatOwnerMessageVM(x) {
  const message = chatMessageIndex.get(x.mid);
  if (!message || !message.extra) return x;
  const data = chatOwnerData(),
    extra = message.extra,
    blocks = extra.rich ? extra.rich.blocks : [],
    // which owner card this message carries is decided once, with the message's other cards (message-cards.ts)
    ownerBlock = x.ownerCard
      ? blocks.find(function (b) {
          return b.id === x.ownerCard.blockId;
        })
      : null,
    frustration = x.ownerCard && x.ownerCard.type === 'frustration' ? ownerBlock : null;
  if (frustration || (x.ownerCard && x.ownerCard.type === 'custody')) {
    const read = data && data.proposals[x.mid],
      r = read && read.value,
      kind = frustration ? 'frustration' : 'custody',
      status = r && (frustration ? r.issue.status : r.offer && r.offer.disposition),
      pending = status === (frustration ? 'draft' : 'pending'),
      coordinates = frustration
        ? { mid: x.mid }
        : r && r.offer
          ? { mid: x.mid, offerId: r.offer.offerId, sourceMessageRevision: r.sourceMessageRevision }
          : { mid: x.mid };
    const card = {
      ownerKind: kind,
      title: frustration ? frustration.title : message.content,
      offer: r && r.offer,
      first: frustration ? frustration.bodyMarkdown : '',
      firstKey: x.mid + ':owner',
      decisions: pending
        ? (frustration ? ['confirm', 'false-positive', 'skip'] : ['accept', 'refuse']).map(function (v) {
            return Object.assign({}, coordinates, { v: v, id: v === 'confirm' ? 'frustration-' + x.mid : '' });
          })
        : [],
      noticeText: (data && data.proposalErrors[x.mid]) || (read && read.error) || '',
      result:
        status && !pending
          ? {
              status:
                status === 'confirmed' || status === 'accepted'
                  ? 'approved'
                  : status === 'declined'
                    ? 'rejected'
                    : 'closed',
              reason: status,
              key: x.mid + ':owner-result',
            }
          : null,
    };
    x = Object.assign({}, x, { kind: 'proposal', card: card });
  }
  const cb = x.ownerCard && x.ownerCard.type === 'cbauth' ? ownerBlock : null;
  if (cb) {
    const m = cb.meta;
    x = Object.assign({}, x, {
      kind: 'cbauth',
      card: {
        markdown: cb.bodyMarkdown,
        reason: m.reason,
        member: chatRead('memberCatalog').find(function (c) {
          return c.id === m.catId;
        }) || { id: m.catId, name: m.catId, handle: '' },
        failedAt: m.failedAt,
        fallbackOk: m.fallbackOk,
      },
    });
  }
  if (extra.messageBundle) {
    const open = !!CS.messageBundles[x.mid],
      read = data && data.bundles[x.mid];
    x = Object.assign({}, x, {
      embeds: x.embeds.concat([
        {
          bundle: {
            id: x.mid,
            open: open,
            load: open ? (read ? read.load : 'loading') : '',
            items: open && read && read.value ? read.value.items : [],
          },
        },
      ]),
    });
  }
  return x;
}
let chatOnboardingSnapshot;
function syncChatOwners() {
  const data = chatOwnerData(),
    onboarding = data && data.onboarding;
  if (data && data.queue) {
    if (data.queue.error) dataError('queue', data.queue.error);
    else dataOk('queue');
  }
  if (!onboarding || chatDataEqual(onboarding, chatOnboardingSnapshot)) return;
  chatOnboardingSnapshot = onboarding;
  S.popOn.guide = !!onboarding.demo.autoEligible && onboarding.demo.status === 'not_started';
  S.popOn.nativeSetup = !S.popOn.guide && onboarding.entry.status === 'pending';
}
function bindChatOwners() {
  A.cafeVoteEnd = function () {
    return chatAction('cafeVoteEnd');
  };
  CS.messageBundles = {};
  A.messageBundleOpen = function (d) {
    const open = d.reload || !CS.messageBundles[d.id];
    CS.messageBundles[d.id] = open;
    render(true);
    return open ? chatAction('messageBundleOpen', { id: d.id }) : true;
  };
  A.cafeCandUndo = async function (d) {
    const ok = await chatAction('cafeCandUndo', d);
    if (ok !== false) CS.m.lib = 'pending';
    render(true);
    return ok;
  };
  A.cafeQueueOrder = function (d) {
    return chatAction('cafeQueueOrder', { keys: JSON.stringify(d.keys) });
  };
  const composer = VM.chatComposer;
  VM.chatComposer = function () {
    const vm = composer(),
      ids = chatDataSnapshot.chat.queue
        .filter(function (entry) {
          return entry.status === 'queued';
        })
        .map(function (entry) {
          return entry.id;
        });
    if (vm.queue)
      vm.queue.items.forEach(function (row) {
        row.orderable = ids.includes(row.key);
      });
    return vm;
  };
  A.cafeReveal = function (d) {
    dialog({
      kind: 'threadReveal',
      on: function () {
        return chatPort.action('cafeReveal', d);
      },
    });
  };

  A.cbAuthHideSimilar = function (d) {
    return chatAction('cbAuthHideSimilar', d);
  };
  const cbAuth = A.cbAuthOpen;
  A.cbAuthOpen = function (d, el) {
    settleHold(chatAction('cbAuthViewed'));
    return cbAuth(d, el);
  };
  const obsAfter = SET_AFTER['ws.obsV'];
  delete SET_AFTER['ws.obsV'];
  SET_AFTER['ws.obsV'] = function (v) {
    if (v === 'auth') settleHold(chatAction('cbAuthViewed'));
    return obsAfter(v);
  };
  A.proposalOwnerDecide = async function (d) {
    const r = await chatAction('proposalOwnerDecide', d);
    return r !== false && r.ok;
  };
  A.proposalOwnerRefresh = function (d) {
    return chatAction('proposalOwnerRefresh', d);
  };

  A.queueTargets = async function (d) {
    CS.queueTargets = { threadId: S.thread, entryId: d.entryId, selected: [], strategies: {} };
    dialog({ kind: 'queueTargets' });
    return A.queueTargetsRead();
  };
  function queueRead() {
    const s = CS.queueTargets,
      data = chatOwnerData();
    return s && data && data.queueTargets[JSON.stringify([s.threadId, s.entryId])];
  }
  A.queueTargetsRead = async function () {
    const s = CS.queueTargets,
      r = await chatAction('queueTargetsRead', { threadId: s.threadId, entryId: s.entryId });
    if (r !== false && r.value) {
      s.selected = r.value.source.targets
        .filter(function (t) {
          return t.actionable;
        })
        .map(function (t) {
          return t.targetCatId;
        });
      s.strategies = {};
      s.error = '';
      render(true);
    }
    return r;
  };
  VM.queueTargets = function () {
    const s = CS.queueTargets,
      r = queueRead();
    if (!s) return null;
    if (!r || r.load) return { load: r ? r.load : 'loading' };
    if (s.error) return { load: 'error' };
    const source = r.value.source,
      cats = r.value.cats,
      done = source.targets
        .filter(function (t) {
          return !t.actionable;
        })
        .map(function (t) {
          return t.targetCatId;
        });
    return {
      load: '',
      selected: s.selected,
      pool: cats.routableNow
        .concat(cats.routableNotJoined)
        .map(function (c) {
          return c.catId;
        })
        .filter(function (id) {
          return !done.includes(id);
        }),
      canSave: !!s.selected.length,
      targets: s.selected.map(function (id) {
        return { id: id, strategy: s.strategies[id] || 'guide_reply' };
      }),
      dispatched: source.targets
        .filter(function (t) {
          return !t.actionable;
        })
        .map(function (t) {
          return { id: t.targetCatId, state: t.status };
        }),
    };
  };
  A.queueTargetsSave = async function () {
    const s = CS.queueTargets,
      value = queueRead().value;
    try {
      await chatPort.action('queueTargetsSave', {
        threadId: s.threadId,
        entryId: s.entryId,
        value: JSON.stringify({
          sourceRecordId: value.source.sourceRecordId,
          observedPendingTargetIds: value.source.targets
            .filter(function (t) {
              return t.actionable;
            })
            .map(function (t) {
              return t.targetCatId;
            }),
          targets: s.selected.map(function (id) {
            return {
              targetCatId: id,
              strategy: s.strategies[id] || 'guide_reply',
              membershipAtOpen: value.cats.participants.some(function (p) {
                return p.catId === id;
              })
                ? 'member'
                : 'admit',
            };
          }),
        }),
      });
      S.dialog = null;
      render(true);
      return true;
    } catch (error) {
      s.error = error.message;
      render(true);
      return false;
    }
  };
  A.cafeDelivery = function (d, el) {
    const open = function (at) {
      CS.pop = { kind: 'delivery', threadId: d.threadId, sourceMessageId: d.sourceMessageId, up: false, span: 5 };
      popAnchor('chat.pop', at);
      settleHold(A.cafeDeliveryRead());
    };
    const host = el && el.closest('.chat, [data-grid], [data-c]');
    if (host) spotOpen('point', host, el.getBoundingClientRect(), open);
    else open(el);
  };
  A.cafeDeliveryRead = function () {
    const p = CS.pop,
      message = chatRead('chatStream').items.find(function (x) {
        return x.mid === p.sourceMessageId;
      });
    return chatAction('cafeDeliveryRead', {
      threadId: p.threadId,
      sourceMessageId: p.sourceMessageId,
      targets: JSON.stringify(
        message.delivery
          .filter(function (d) {
            return !d.cloud;
          })
          .map(function (d) {
            return d.who;
          }),
      ),
    });
  };
  A.cafeDeliveryRecover = async function (d) {
    const r = await chatAction('cafeDeliveryRecover', d);
    await A.cafeDeliveryRead();
    return r !== false && r.ok;
  };
  const pop = VM.chatPop;
  VM.chatPop = function () {
    const p = CS.pop;
    if (!p || p.kind !== 'delivery') return pop();
    const data = chatOwnerData(),
      key = JSON.stringify([p.threadId, p.sourceMessageId]),
      reads = data && data.delivery[key],
      message = chatRead('chatStream').items.find(function (x) {
        return x.mid === p.sourceMessageId;
      }),
      targets = message.delivery.map(function (d) {
        const r = d.cloud ? { value: { status: d.state } } : reads && reads[d.who];
        return Object.assign({}, d, {
          state: r && r.value ? r.value.status : 'unavailable',
          error: (r && r.error) || '',
          load: !d.cloud && !r,
        });
      });
    return {
      kind: 'delivery',
      typed: false,
      pos: { up: p.up, span: p.span, fit: false },
      page: 'delivery/',
      delivery: {
        load: targets.some(function (r) {
          return r.load;
        })
          ? 'loading'
          : targets.every(function (r) {
                return r.error;
              })
            ? 'error'
            : '',
        partial: targets.some(function (r) {
          return r.error;
        }),
        items: targets.map(function (r) {
          const unknown = r.canRepeat && ['unavailable', 'failed'].includes(r.state),
            state = unknown ? 'unknown' : r.state,
            error = data && data.deliveryErrors[key] && data.deliveryErrors[key][r.who],
            receipt = data && data.repeatReceipts[key] && data.repeatReceipts[key][r.who];
          return {
            who: r.who,
            state: state,
            transportError: error || r.error,
            detail: r.detail,
            threadId: p.threadId,
            sourceMessageId: p.sourceMessageId,
            canRetry: !r.cloud && !r.error && state === 'failed' && !r.canRepeat,
            canRepeat: !r.cloud && !r.error && unknown,
            reply: r.mid,
            noReply: !r.mid,
            repeated: !!receipt,
          };
        }),
      },
    };
  };
  A.guideAdmission = function () {
    return chatAction('guideAdmission');
  };
  ['guideDismiss', 'guideEntryDismiss'].forEach(function (name) {
    A[name] = function () {
      return chatAction(name);
    };
  });
  A.guideNext = async function () {
    const entry = await chatAction('guideNext');
    if (entry === false) return false;
    S.popOn.guide = false;
    S.popOn.nativeSetup = entry.status === 'pending';
    render(true);
    return true;
  };
  A.guideEntryComplete = async function () {
    if ((await chatAction('guideEntryComplete')) === false) return false;
    S.popOn.nativeSetup = false;
    render(true);
    return true;
  };
  onStart('late', function () {
    if (chatPort.exportMids === undefined) return A.guideAdmission();
  });
  syncChatOwners();
  A.msgDisposition = async function (d) {
    const r = await chatAction('msgDisposition', d);
    if (r === false) return false;
    S.ws.pawSource = r;
    S.ws.evalView = 'events';
    S.ws.pawF = 'all';
    S.folds['row:paw'] = !r.page.error && r.page.bundles.length === 1 ? r.page.bundles[0].bundleKey : null;
    ENGINE_PARTS.openTab('panel', 'eval');
    render(true);
    return true;
  };
  A.pawSourceClear = function () {
    S.ws.pawSource = null;
    render(true);
  };
}
