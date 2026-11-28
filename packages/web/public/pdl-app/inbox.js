/* Real owner inbox; the floating shell and row declarations are unchanged. */
'use strict';
const MODAL_INIT = {};
const MODALS = {};
let inboxPendingCounts = {};
let inboxPendingByThread = {};
let inboxPendingComplete = false;
function inboxDecisionThreadId(r) {
  if (!r || r.userMention) return '';
  if (r.approval?.resolution && r.approval.resolution !== 'open') return '';
  const nav = r.approval?.navigation;
  return (
    r.originalApprovalCard?.cardRef?.threadId ||
    r.runtimeInteraction?.cardRef?.threadId ||
    r.choiceRequest?.cardRef?.threadId ||
    (nav?.state === 'anchored'
      ? nav.approvalCardRef?.threadId || nav.originRef?.threadId || ''
      : nav?.state === 'legacy_unanchored'
        ? nav.legacyThreadId || ''
        : '')
  );
}
function inboxPendingCount(threadId) {
  if (projectionNeeded) projectionNeeded.add('inbox');
  return (threadId && inboxPendingCounts[threadId]) || 0;
}
function inboxPendingItems(threadId) {
  if (projectionNeeded) projectionNeeded.add('inbox');
  return inboxPendingByThread[threadId] || [];
}
function inboxPendingLabel(threadId) {
  return tc(inboxPendingComplete ? 'pendingDecisions.count' : 'pendingDecisions.known', inboxPendingCount(threadId));
}
function inboxDecisionNotices(threadId) {
  return inboxPendingCount(threadId)
    ? [
        {
          id: 'pending-decisions',
          tone: 'warn',
          text: inboxPendingLabel(threadId) + ' · ' + tc('pendingDecisions.go'),
          act: 'pendingDecisions',
          args: { t: threadId },
        },
      ]
    : [];
}
function bindInbox() {
  inboxPendingCounts = {};
  inboxPendingByThread = {};
  inboxPendingComplete = false;
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
    allDecisions = [],
    confirmations = [],
    conciergeThread = null,
    lastHandling = null,
    confirmed = false,
    sequence = 0,
    owner;
  function rebuildPendingCounts() {
    const next = {};
    const byThread = {};
    const seen = new Set();
    allDecisions.forEach(function (r) {
      if (r && r.decisionRef) {
        if (seen.has(r.decisionRef)) return;
        seen.add(r.decisionRef);
      }
      const tid = inboxDecisionThreadId(r);
      if (tid) {
        next[tid] = (next[tid] || 0) + 1;
        const ref =
          r.originalApprovalCard?.cardRef ||
          r.runtimeInteraction?.cardRef ||
          r.choiceRequest?.cardRef ||
          r.approval?.navigation?.approvalCardRef;
        (byThread[tid] || (byThread[tid] = [])).push({
          summary: r.summary,
          createdAt: r.approval?.createdAt,
          expiresAt: r.approval?.expiresAt,
          t: tid,
          mid: ref?.messageId || '',
        });
      }
    });
    if (conciergeThread && Array.isArray(confirmations)) {
      confirmations.forEach(function (c) {
        if (c && c.status === 'rendered') {
          next[conciergeThread] = (next[conciergeThread] || 0) + 1;
          (byThread[conciergeThread] || (byThread[conciergeThread] = [])).push({
            summary: c.action?.title || c.action?.summary || c.action?.originalText,
            createdAt: c.createdAt,
            t: conciergeThread,
            mid: c.messageId || '',
          });
        }
      });
    }
    const changed = !chatDataEqual(inboxPendingCounts, next) || !chatDataEqual(inboxPendingByThread, byThread);
    inboxPendingCounts = next;
    inboxPendingByThread = byThread;
    return changed;
  }
  async function loadAllDecisionItems(ticket, currentPage, currentOffset, opt) {
    const period = CS.ib.time === 'earlier' ? 'week' : CS.ib.time;
    const items = [];
    for (let offset = 0; offset < 1000; offset += 20) {
      let pageData = null;
      if (currentPage && CS.ib.time !== 'earlier' && offset === currentOffset) {
        pageData = currentPage;
      } else {
        try {
          pageData = await api.get(
            '/api/concierge/work/decisions',
            { view: 'unified', includeUserMentions: 'true', mentionPeriod: period, limit: 20, offset: offset },
            opt,
          );
        } catch {
          return null;
        }
        if (ticket !== sequence) return null;
        if (owner !== undefined && pageData?.identity?.ownerUserId !== owner) return null;
      }
      if (!pageData || !Array.isArray(pageData.items)) return null;
      items.push.apply(items, pageData.items);
      if (!pageData.page?.hasMore || !pageData.items.length) return items;
    }
    // A bounded scan that still has more rows cannot claim a complete projection.
    return null;
  }
  function requireCurrent() {
    if (!confirmed) throw new Error(tc('inboxRefresh.retained'));
  }
  async function load() {
    const ticket = ++sequence;
    confirmed = false;
    if (inboxPendingComplete) navStale();
    inboxPendingComplete = false;
    chatDataRender();
    const opt = { afterCurrentGet: true },
      // The two decision pages are checked together (same owner); the rest are read on their own and a failure there
      // only leaves that item missing.
      [decisions, extra, thread, last] = await Promise.allSettled([
        Promise.all([
          api.get(
            '/api/concierge/work/decisions',
            {
              view: 'unified',
              includeUserMentions: 'true',
              mentionPeriod: CS.ib.time,
              limit: 20,
              offset: (CS.ib.page - 1) * 20,
            },
            opt,
          ),
          api.get(
            '/api/concierge/work/decisions',
            { view: 'unified', includeUserMentions: 'true', mentionPeriod: 'handled', limit: 20 },
            opt,
          ),
        ]),
        api.get('/api/concierge/confirmations', undefined, opt),
        api.get('/api/concierge/thread', undefined, opt),
        api.get('/api/concierge/work/mentions/last-handling', undefined, opt),
      ]);
    if (ticket !== sequence) return;
    const diff = { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
      currentOffset = (CS.ib.page - 1) * 20,
      pages = decisions.status === 'fulfilled' ? decisions.value : null;
    if (
      pages &&
      (owner === undefined || (pages[0].identity.ownerUserId === owner && pages[1].identity.ownerUserId === owner))
    ) {
      read = receiveProjectValue(read, pages[0], 'inbox', diff);
      handled = receiveProjectValue(handled, pages[1], 'inbox', diff);
      confirmed = true;
    }
    if (extra.status === 'fulfilled')
      confirmations = receiveProjectValue(confirmations, extra.value.confirmations, 'inbox.confirmations', diff);
    if (thread.status === 'fulfilled') conciergeThread = thread.value.threadId;
    if (last.status === 'fulfilled') lastHandling = last.value.receipt;
    if (confirmed && read) {
      const collected = await loadAllDecisionItems(ticket, read, currentOffset, opt);
      if (ticket !== sequence) return;
      if (Array.isArray(collected)) allDecisions = collected;
      inboxPendingComplete = Array.isArray(collected) && read.status === 'available' && extra.status === 'fulfilled';
    }
    if (rebuildPendingCounts() || inboxPendingComplete) navStale();
    await chatDataRender();
  }
  api.on('session:changed', function (identity) {
    owner = identity && identity.ownerUserId;
    ++sequence;
    confirmed = false;
    read = handled = null;
    allDecisions = [];
    confirmations = [];
    conciergeThread = null;
    lastHandling = null;
    inboxPendingComplete = false;
    rebuildPendingCounts();
    navStale();
    chatDataRender();
    if (heldNeeded.has('inbox')) return load();
  });
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('inbox') >= 0) settleHold(load());
  });
  A.pendingDecisions = function (d, el) {
    const items = inboxPendingItems(d.t || chatPort.threadId);
    if (!items.length) return A.inboxToggle({}, el);
    if (items.length === 1 && items[0].mid) return A.msgJump({ t: items[0].t, mid: items[0].mid });
    return A.menu(
      {
        menu: menuLive(
          items.map(function (item) {
            const stale = typeof item.expiresAt === 'number' && item.expiresAt < Date.now();
            return {
              label:
                (item.summary || tc('pendingDecisions.item')) +
                (typeof item.createdAt === 'number' ? ' · ' + FORMATS.ago(item.createdAt) : '') +
                (stale ? ' · ' + tc('pendingDecisions.stale') : ''),
              act: item.mid ? 'msgJump' : 'inboxToggle',
              data: item.mid ? { t: item.t, mid: item.mid } : {},
            };
          }),
        ),
      },
      el,
    );
  };
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
  function requireMention(m) {
    requireCurrent();
    const current = m && mention(m.messageId);
    if (!current || !chatDataEqual(coordinate(current), coordinate(m))) throw new Error(tc('inboxRefresh.retained'));
    return current;
  }
  async function restore(m) {
    requireMention(m);
    await api.post('/api/concierge/work/mentions/restore', {}, coordinate(m));
    await load();
  }
  async function ignore(m) {
    requireMention(m);
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
    requireCurrent();
    if (!lastHandling || lastHandling.undoId !== d.undoId) return false;
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
      ready = confirmed && p && p.coverage.state === 'complete' && p.consistency.state === 'verified';
    return {
      error: m.error,
      vm: {
        preview: p,
        ready: ready,
        count: p ? p.requests.length : 0,
        ignoredCount: p ? p.personalView.ignoredCount : 0,
      },
      submitDisabled: !ready || !p.requests.length,
      submit: async function () {
        requireCurrent();
        const ticket = sequence;
        const fresh = await api.get('/api/concierge/work/mentions/handling-preview', {
          period: p.period,
          personalView: 'visible',
        });
        if (
          !confirmed ||
          ticket !== sequence ||
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
  A.inboxReadback = async function (d) {
    const binding = Object.values(chatDataSnapshot.chat.proposals || {}).find(function (b) {
      return b.target.id === d.id;
    });
    if (binding) await chatAction('proposalReadback', { mid: binding.target.mid });
    else await chatAction('inboxReadback', { id: d.id });
    await load();
  };
  function recoveryFor(proposalId) {
    const chat = projectionSource(chatDataSnapshot.chat, 'chat'),
      source = projectionSource(projectData('sources'), 'project.sources'),
      binding = Object.values(chat.proposals || {}).find(function (b) {
        return b.target.id === proposalId;
      });
    return (binding && binding.recovery) || (source && source.inboxRecoveries && source.inboxRecoveries[proposalId]);
  }
  A.cafeIbDone = async function (d) {
    requireCurrent();
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
    if (d.kind === 'mention') {
      const current = requireMention({
        threadId: d.t,
        messageId: d.mid,
        expectedRevision: Number(d.revision),
      });
      await api.post(
        '/api/concierge/work/mentions/' + encodeURIComponent(current.threadId) + '/resolve',
        {},
        { expectedMessageId: current.messageId, expectedRevision: current.expectedRevision },
      );
    } else if (row && row.approval) {
      const ok = await chatAction('inboxDecide', {
        id: row.approval.proposalId,
        owner: read.identity.ownerUserId,
        res: d.res,
      });
      if (ok === false) return false;
    } else {
      if (!row) return false;
      await chatPort.action('cardDecide', { mid: d.id, v: d.res === 'accept' ? 'ok' : 'no' });
    }
    await load();
  };
  A.cafeIbBatch = async function (d) {
    requireCurrent();
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
      ctx: {
        id: m.messageId,
        thread: m.threadId,
        messageId: m.messageId,
        expectedRevision: m.expectedRevision,
        canWrite: confirmed,
      },
      writeDisabled: !confirmed,
      open: CS.ib.open === m.messageId,
      full: m.content,
    };
  }
  function historyRow(m, entity) {
    return Object.assign({}, mentionRow(m), { ignored: entity === 'ibIgnored', handled: entity === 'ibBack' });
  }
  VM.cafeInbox = function () {
    if (projectionNeeded) projectionNeeded.add('inbox');
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
                recovery = r.approval && recoveryFor(r.approval.proposalId),
                writable = !recovery || (!recovery.reading && (!recovery.phase || recovery.phase === 'retryable')),
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
                  proposalId: r.approval && r.approval.proposalId,
                  canReadback: !!recovery && !!recovery.phase && recovery.phase !== 'writing' && !recovery.reading,
                  canDecide:
                    confirmed &&
                    writable &&
                    (r.approval
                      ? r.approval.resolution === 'open' &&
                        r.approval.inlineApprovable &&
                        r.approval.decisionMode !== 'claim-select' &&
                        !(r.approval.sourceFeatureId === 'F260' && r.approval.detail.conflict)
                      : !!(card && card.card && (card.card.canApprove || card.card.canApproveSchedule))),
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
        displayOnly: !confirmed,
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
        displayOnly: !confirmed,
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
        displayOnly: !confirmed,
        ap: {
          tab: CS.ib.apTab,
          pendingCount: pending.length + confirmRows.length,
          pickedCount: picked.length,
          pending: CS.ib.apTab === 'pending',
          history: CS.ib.apTab === 'history',
          type: CS.ib.apType,
          res: CS.ib.apRes,
          pendingItems: CS.ib.apTab === 'pending' ? pending.concat(confirmRows) : [],
          nonePicked: !confirmed || !picked.length,
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
      displayOnly: !confirmed,
      ignoredCount: ignored.length,
      undoReceipt: confirmed && lastHandling && lastHandling.remaining > 0 ? lastHandling : null,
      main: {
        me: chatRead('me').handle,
        time: CS.ib.time,
        partial: !!read && read.status !== 'available',
        decide: pending.concat(confirmRows),
        review: [],
        at: mentions(read).map(mentionRow),
        other: [],
      },
    };
  };
}
