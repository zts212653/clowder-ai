/* Real owner inbox; the floating shell and row declarations are unchanged. */
'use strict';
const MODAL_INIT = {};
const MODALS = {};
function bindInbox() {
  CS.ib = {
    view: 'main',
    time: 'week',
    ignTime: 'week',
    open: null,
    page: 1,
    apTab: 'pending',
    apType: 'all',
    apRes: 'all',
    apPick: {},
  };
  let read = null,
    handled = null,
    confirmations = [],
    conciergeThread = null,
    failure = null,
    lastHandling = null;
  async function load() {
    failure = null;
    try {
      const values = await Promise.all([
        api.get('/api/concierge/work/decisions', {
          view: 'unified',
          includeUserMentions: 'true',
          mentionPeriod: CS.ib.time,
          limit: 20,
          offset: (CS.ib.page - 1) * 20,
        }),
        api.get('/api/concierge/work/decisions', {
          view: 'unified',
          includeUserMentions: 'true',
          mentionPeriod: 'handled',
          limit: 20,
        }),
        api.get('/api/concierge/confirmations'),
        api.get('/api/concierge/thread'),
        api.get('/api/concierge/work/mentions/last-handling'),
      ]);
      const diff = { added: [], changed: [], removed: [], orderChanged: false, fields: [] };
      read = receiveProjectValue(read, values[0], 'inbox', diff);
      handled = receiveProjectValue(handled, values[1], 'inbox', diff);
      confirmations = receiveProjectValue(confirmations, values[2].confirmations, 'inbox.confirmations', diff);
      conciergeThread = values[3].threadId;
      lastHandling = values[4].receipt;
      dataOk('inbox');
    } catch (error) {
      read = handled = null;
      confirmations = [];
      lastHandling = null;
      failure = error;
      dataError('inbox', error);
    }
    await chatDataRender();
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('inbox') >= 0) settleHold(load());
  });
  [
    'cat-cafe:entrusted-work-projection-invalidated',
    'cat-cafe:ignored-item-preferences-updated',
    'cat-cafe:collective-attention-invalidated',
    'cat-cafe:proposal-created',
    'cat-cafe:proposal-updated',
    'cat-cafe:runtime-interaction-updated',
    'cat-cafe:custody-offer-updated',
    'cat-cafe:user-mention-updated',
  ].forEach(function (event) {
    api.on(event, function () {
      if (heldNeeded.has('inbox')) return load();
    });
  });
  function mentions(page) {
    return page
      ? page.items
          .filter(function (r) {
            return r.userMention;
          })
          .map(function (r) {
            return r.userMention;
          })
      : [];
  }
  function mention(id) {
    return mentions(read)
      .concat(mentions(handled))
      .find(function (r) {
        return r.messageId === id;
      });
  }
  function coordinate(m) {
    return { threadId: m.threadId, messageId: m.messageId, expectedRevision: m.expectedRevision };
  }
  async function restore(m) {
    await api.post('/api/concierge/work/mentions/restore', {}, coordinate(m));
    await load();
  }
  async function ignore(m) {
    const receipt = await api.post('/api/concierge/work/mentions/handle', {}, { requests: [coordinate(m)] });
    await load();
    return async function () {
      return A.cafeIbUndo({ undoId: receipt.undoId });
    };
  }
  A.inboxToggle = function (d, el) {
    S.inboxOpen = !S.inboxOpen;
    if (S.inboxOpen) {
      popAnchor('inbox', el);
    }
    render(true);
  };
  BADGES.inbox = function () {
    if (projectionNeeded) projectionNeeded.add('inbox');
    return read && typeof read.attentionCount === 'number' ? read.attentionCount : '';
  };
  ['time', 'page'].forEach(function (k) {
    SET_AFTER['cs.ib.' + k] = load;
  });
  const selected = CHANGES.cafeSel,
    refreshed = A.refresh;
  CHANGES.cafeSel = function (e) {
    if (e.target.id === 'ib-aptype' || e.target.id === 'ib-apres') {
      CS.ib[e.target.id === 'ib-aptype' ? 'apType' : 'apRes'] = e.target.value;
      render(true);
      return;
    }
    return selected(e);
  };
  A.refresh = function (d, el) {
    return d.k === 'ib-approvals' ? load() : refreshed(d, el);
  };

  ENT.ibAt = {
    get: mention,
    undo: ['remove'],
    undoText: function () {
      return tc('inbox.ignore.text');
    },
    remove: ignore,
  };
  ENT.ibIgnored = { get: mention, remove: restore };
  ENT.ibBack = { get: mention, remove: restore };
  A.cafeIbUndo = async function (d) {
    await api.post('/api/concierge/work/mentions/undo', {}, { undoId: d.undoId });
    await load();
    return true;
  };
  MODAL_INIT.ibIgnore = async function (m) {
    m.preview = null;
    m.error = '';
    render(true);
    try {
      m.preview = await api.get('/api/concierge/work/mentions/handling-preview', {
        period: CS.ib.time,
        personalView: 'visible',
      });
    } catch (error) {
      m.error = error.message;
    }
    render(true);
  };
  MODALS.ibIgnore = function (m) {
    const p = m.preview,
      ready = p && p.coverage.state === 'complete' && p.consistency.state === 'verified';
    return {
      error: m.error,
      vm: { ready: ready, count: p ? p.requests.length : 0, ignoredCount: p ? p.personalView.ignoredCount : 0 },
      submitDisabled: !ready || !p.requests.length,
      submit: async function () {
        const fresh = await api.get('/api/concierge/work/mentions/handling-preview', {
          period: p.period,
          personalView: 'visible',
        });
        if (
          fresh.coverage.state !== 'complete' ||
          fresh.consistency.state !== 'verified' ||
          fresh.personalView.preferenceRevision !== p.personalView.preferenceRevision ||
          !chatDataEqual(fresh.requests, p.requests)
        ) {
          m.error = tc('mediaReview.conflict');
          m.preview = fresh;
          render(true);
          return false;
        }
        await chatPort.action('inboxIgnore', {
          value: JSON.stringify({
            expectedOwnerUserId: p.ownerUserId,
            expectedRevision: p.personalView.preferenceRevision,
            ignore: p.requests.map(function (r) {
              return r.preferenceCoordinate;
            }),
            restore: [],
          }),
        });
        await load();
        return true;
      },
    };
  };
  A.cafeIbDone = async function (d) {
    const row =
      read &&
      read.items.find(function (r) {
        const ref = r.originalApprovalCard
          ? r.originalApprovalCard.cardRef
          : r.approval && r.approval.navigation.state === 'anchored'
            ? r.approval.navigation.approvalCardRef
            : null;
        return d.id === (ref ? ref.messageId : r.decisionRef);
      });
    if (d.kind === 'mention')
      await api.post(
        '/api/concierge/work/mentions/' + encodeURIComponent(d.t) + '/resolve',
        {},
        { expectedMessageId: d.mid, expectedRevision: d.revision === undefined ? undefined : Number(d.revision) },
      );
    else if (row && row.approval) {
      const ok = await chatAction('inboxDecide', {
        id: row.approval.proposalId,
        owner: read.identity.ownerUserId,
        res: d.res,
      });
      if (ok === false) return false;
    } else await chatPort.action('cardDecide', { mid: d.id, v: d.res === 'accept' ? 'ok' : 'no' });
    await load();
  };
  A.cafeIbBatch = async function (d) {
    const ids = Object.keys(CS.ib.apPick).filter(function (id) {
      return CS.ib.apPick[id];
    });
    for (const id of ids) {
      if ((await A.cafeIbDone({ id: id, res: d.res })) === false) return false;
      delete CS.ib.apPick[id];
    }
    render(true);
  };
  function mentionRow(m) {
    const c = chatRead('memberCatalog').find(function (c) {
      return c.id === m.catId;
    });
    return {
      id: m.messageId,
      who: m.catId,
      from: { kind: 'agent', catId: m.catId },
      name: c ? c.name : m.catId,
      handle: c ? c.handle : '',
      text: m.content,
      threadTitle: m.threadTitle,
      time: m.timestamp,
      timestamp: typeof m.timestamp === 'number',
      slot: 'cafe.inbox.at',
      ctx: { id: m.messageId, thread: m.threadId, messageId: m.messageId, expectedRevision: m.expectedRevision },
      open: CS.ib.open === m.messageId,
      full: m.content,
    };
  }
  function historyRow(m, entity) {
    return Object.assign({}, mentionRow(m), { ignored: entity === 'ibIgnored', handled: entity === 'ibBack' });
  }
  VM.cafeInbox = function () {
    if (projectionNeeded) projectionNeeded.add('inbox');
    if (failure) return null;
    const ignored = mentions(handled).filter(function (m) {
        return m.handledReason === 'ignored';
      }),
      pending = read
        ? read.items
            .filter(function (r) {
              return !r.userMention;
            })
            .map(function (r) {
              const ref = r.originalApprovalCard
                  ? r.originalApprovalCard.cardRef
                  : r.runtimeInteraction
                    ? r.runtimeInteraction.cardRef
                    : r.approval && r.approval.navigation.state === 'anchored'
                      ? r.approval.navigation.approvalCardRef
                      : null,
                id = ref ? ref.messageId : r.decisionRef,
                card = chatRead('chatStream').items.find(function (m) {
                  return m.mid === id;
                });
              return {
                id: id,
                kind: r.runtimeInteraction ? 'ask' : 'proposal',
                type: r.approval ? r.approval.sourceFeatureId : '',
                title: r.summary,
                from: r.runtimeInteraction
                  ? { kind: 'agent', catId: r.runtimeInteraction.requesterCatId }
                  : r.approval
                    ? { kind: 'agent', catId: r.approval.requesterCatId }
                    : card && card.from,
                time: r.runtimeInteraction
                  ? r.runtimeInteraction.createdAt
                  : r.approval
                    ? r.approval.createdAt
                    : undefined,
                timestamp: !!(r.runtimeInteraction || r.approval),
                why: r.summary,
                after: r.after,
                slot: 'cafe.inbox.decide',
                ctx: {
                  id: id,
                  thread: ref && ref.threadId,
                  noLoc: !ref,
                  canDecide: r.approval
                    ? r.approval.resolution === 'open' &&
                      r.approval.inlineApprovable &&
                      r.approval.decisionMode !== 'claim-select' &&
                      !(r.approval.sourceFeatureId === 'F260' && r.approval.detail.conflict)
                    : !!(card && card.card && (card.card.canApprove || card.card.canApproveSchedule)),
                  rejectRes: 'reject',
                  acceptRes: 'accept',
                  kView: 'view',
                  vAp: 'approvals',
                },
                act: ref ? 'msgJump' : '',
                args: ref ? { t: ref.threadId, mid: ref.messageId } : {},
              };
            })
        : [],
      confirmation = function (c) {
        return {
          id: c.id,
          title: c.action.title || c.action.summary || c.action.originalText,
          from: c.from,
          timestamp: c.createdAt,
          time: c.createdAt,
          type: c.action.kind,
          result: c.status === 'confirmed' ? 'accept' : 'reject',
          act: conciergeThread ? 'msgJump' : '',
          args: { t: conciergeThread, mid: c.messageId },
        };
      },
      confirmRows = confirmations
        .filter(function (c) {
          return c.status === 'rendered';
        })
        .map(confirmation),
      picked = Object.keys(CS.ib.apPick).filter(function (id) {
        return CS.ib.apPick[id];
      });
    if (CS.ib.view === 'ignored') {
      const now = handled ? handled.observedAt : api.now(),
        today = new Date(now).setHours(0, 0, 0, 0);
      return {
        sub: true,
        ignored: {
          time: CS.ib.ignTime,
          items: ignored
            .filter(function (m) {
              return CS.ib.ignTime === 'today'
                ? m.timestamp >= today
                : CS.ib.ignTime === 'week'
                  ? m.timestamp >= now - 7 * 86400000
                  : m.timestamp < now - 7 * 86400000;
            })
            .map(function (m) {
              return historyRow(m, 'ibIgnored');
            }),
        },
      };
    }
    if (CS.ib.view === 'handled')
      return {
        sub: true,
        handled: {
          count: mentions(handled).length,
          items: mentions(handled)
            .filter(function (m) {
              return m.handledReason !== 'ignored';
            })
            .map(function (m) {
              return historyRow(m, 'ibBack');
            }),
        },
      };
    if (CS.ib.view === 'approvals')
      return {
        sub: true,
        ap: {
          tab: CS.ib.apTab,
          pendingCount: pending.length + confirmRows.length,
          pickedCount: picked.length,
          pending: CS.ib.apTab === 'pending',
          history: CS.ib.apTab === 'history',
          type: CS.ib.apType,
          res: CS.ib.apRes,
          pendingItems: CS.ib.apTab === 'pending' ? pending.concat(confirmRows) : [],
          nonePicked: !picked.length,
          histItems: confirmations
            .filter(function (c) {
              return (
                c.status !== 'rendered' &&
                (CS.ib.apType === 'all' || (CS.ib.apType === 'thread' && c.action.kind === 'propose_thread')) &&
                (CS.ib.apRes === 'all' || (CS.ib.apRes === 'accept' && c.status === 'confirmed'))
              );
            })
            .map(confirmation),
        },
      };
    return {
      ignoredCount: ignored.length,
      undoReceipt: lastHandling && lastHandling.remaining > 0 ? lastHandling : null,
      main: {
        me: chatRead('me').handle,
        time: CS.ib.time,
        partial: !!read && (read.status !== 'available' || read.page.hasMore),
        decide: pending.concat(confirmRows),
        review: [],
        at: mentions(read).map(mentionRow),
        other: [],
      },
    };
  };
}
