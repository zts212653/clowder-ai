'use strict';
let matterData = { catalogs: {}, details: {} };
function matterSourceKey(detail) {
  return 'matters:' + (detail ? 'detail:' + CS.m.matterId : 'catalog:' + (CS.m.matterQuery || ''));
}
// One matter entry (the matter page and a memory card's write receipt): the source is a quote coordinate or a
// return pointer (thread only / thread + message); a summary is the writer's reading, not the original words.
function matterEntryVM(e, editable) {
  const src = e.source,
    who = function (a) {
      return !a ? '' : a.kind === 'agent' ? a.catId : a.kind === 'user' ? 'user' : 'system';
    },
    by = e.summary && e.summaryAuthor;
  return {
    entryId: e.entryId,
    status: e.status,
    quote: (e.sourceStatus === 'current' && e.quote) || '',
    changed: e.sourceStatus === 'changed',
    summary: e.summary || '',
    summaryBy: !by
      ? ''
      : by.kind === 'agent'
        ? pdlReads('who').member(by.catId).name
        : by.kind === 'user'
          ? pdlReads('who').me().name
          : '',
    speaker: who(src.author),
    time: src.timestamp || e.recordedAt || null,
    pointer: src.kind ? src.origin : '',
    threadOnly: src.kind === 'thread',
    attribution: e.attribution,
    jump: { t: src.threadId, mid: src.messageId || '' },
    editable: editable && e.status === 'active',
  };
}
// A description or title change for the diff component: equal leading and trailing lines are left out.
function matterDiff(before, after) {
  const a = before ? before.split('\n') : [],
    b = after ? after.split('\n') : [];
  let i = 0,
    j = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const minus = a.slice(i, a.length - j).map(function (l) {
      return ['-', l];
    }),
    plus = b.slice(i, b.length - j).map(function (l) {
      return ['+', l];
    });
  return { mode: 'unified', hunks: [['', minus.concat(plus)]] };
}
function matterState(detail) {
  const raw = projectData('matters'),
    id = detail ? CS.m.matterId : CS.m.matterQuery || '';
  return raw && raw[detail ? 'details' : 'catalogs'][id];
}
function matterPublish() {
  pushProjectData({ matters: matterData });
  matterData = projectHeldData.matters;
}
async function matterPull(detail, id, more) {
  const field = detail ? 'details' : 'catalogs',
    previous = matterData[field][id],
    key = 'matters:' + (detail ? 'detail:' : 'catalog:') + id;
  let state = { data: previous && previous.data, loading: true, error: '' };
  matterData = Object.assign({}, matterData, { [field]: Object.assign({}, matterData[field], { [id]: state }) });
  matterPublish();
  const params = detail ? { history: 'true', limit: '30' } : { query: id, limit: '12' };
  if (more) params.cursor = previous.data.nextCursor;
  try {
    const result = await api.get(
      detail ? '/api/memory/matters/' + encodeURIComponent(id) : '/api/memory/matters',
      params,
    );
    if (!heldNeeded.has(key)) return;
    const rows = detail ? 'entries' : 'items';
    if (more) result[rows] = previous.data[rows].concat(result[rows]);
    state = { data: result, loading: false, error: '' };
  } catch (error) {
    state = { data: null, loading: false, error: error.message };
  }
  matterData = Object.assign({}, matterData, { [field]: Object.assign({}, matterData[field], { [id]: state }) });
  matterPublish();
}
api.on('sources:needed', function (diff) {
  diff.added
    .filter(function (key) {
      return key.indexOf('matters:') === 0;
    })
    .forEach(function (key) {
      const detail = key.indexOf('matters:detail:') === 0,
        id = key.slice(detail ? 'matters:detail:'.length : 'matters:catalog:'.length);
      settleHold(matterPull(detail, id, false));
    });
});
VM.memoryMatters = function () {
  const detail = !!CS.m.matterId;
  if (projectionNeeded) projectionNeeded.add(matterSourceKey(detail));
  const page = matterState(detail),
    data = page && page.data;
  return {
    detail: detail,
    query: CS.m.matterQuery || '',
    load: !data ? (page && page.error ? 'error' : 'loading') : '',
    error: CS.m.matterError || (page && page.error) || '',
    retryable: !!CS.m.matterPending,
    loadingMore: !!page && page.loading && !!data,
    cursor: data && data.nextCursor,
    items: !detail && data ? data.items : [],
    matter: detail && data ? data.matter : null,
    entries:
      detail && data
        ? data.entries.map(function (entry) {
            return matterEntryVM(entry, true);
          })
        : [],
    summaryStatus: data && data.summaryStatus,
    receipt: CS.m.matterReceipt,
  };
};
A.matterOpen = function (d) {
  CS.m.matterId = d.id || '';
  CS.m.view = 'matters';
  CS.m.matterError = '';
  CS.m.matterReceipt = null;
  render(true);
};
INPUTS.matterQuery = function (e) {
  CS.m.matterQuery = e.target.value;
  render(true);
};
A.matterRead = function (d) {
  const detail = !!CS.m.matterId,
    page = matterState(detail);
  if (page && page.loading) return;
  return settleHold(matterPull(detail, detail ? CS.m.matterId : CS.m.matterQuery || '', !!d.more));
};
async function matterWrite(command) {
  const state = CS.m;
  if (!state.matterPending) state.matterPending = Object.assign({ requestId: crypto.randomUUID() }, command);
  try {
    const receipt = await api.post('/api/memory/matters/write', {}, state.matterPending);
    state.matterPending = null;
    state.matterError = '';
    state.matterReceipt = receipt;
    state.matterId = receipt.outcome === 'forgotten' ? '' : receipt.matter.matterId;
    render(true);
    window.dispatchEvent(new Event('cat-cafe:memory-changed'));
    return true;
  } catch (error) {
    state.matterError = error.message;
    if (error.status < 500) state.matterPending = null;
    render(true);
    return false;
  }
}
onStart('late', function () {
  window.addEventListener('cat-cafe:memory-changed', function () {
    heldNeeded.forEach(function (key) {
      if (key.indexOf('matters:') !== 0) return;
      const detail = key.indexOf('matters:detail:') === 0;
      settleHold(matterPull(detail, key.slice(detail ? 'matters:detail:'.length : 'matters:catalog:'.length), false));
    });
  });
});
A.matterRetry = function () {
  return matterWrite(CS.m.matterPending);
};
A.matterEdit = function () {
  const matter = matterState(true).data.matter;
  dialog({
    kind: 'matterEdit',
    args: matter,
    on: function () {
      const title = val('matter-title'),
        description = val('matter-description');
      if (!title) {
        fieldErr('matter-title', tc('common.required'));
        return false;
      }
      return matterWrite({
        operation: 'edit',
        matterId: matter.matterId,
        expectedRevision: matter.revision,
        title: title,
        description: description,
      });
    },
  });
};
// Add or correct a source: a thread or message link, a summary and/or a quote (a quote needs a message link).
// Correcting prefills the entry and keeps its original location when the link and quote are unchanged.
A.matterSource = function (d) {
  const page = CS.m.matterId ? matterState(true).data : null,
    matter = page ? page.matter : null,
    old =
      d.entryId &&
      page.entries.find(function (e) {
        return e.entryId === d.entryId;
      }),
    oldLink = old
      ? location.origin +
        '/thread/' +
        encodeURIComponent(old.source.threadId) +
        (old.source.messageId ? '?message=' + encodeURIComponent(old.source.messageId) : '')
      : '';
  dialog({
    kind: 'matterSource',
    args: {
      create: !matter,
      title: d.v || '',
      link: oldLink,
      summary: old ? old.summary || '' : '',
      quote: old ? old.quote || '' : '',
    },
    on: async function () {
      let link, threadId;
      try {
        link = new URL(val('matter-link'), location.href);
        const match = /^\/thread\/([^/]+)$/.exec(link.pathname);
        threadId = match && decodeURIComponent(match[1]);
      } catch {
        fieldErr('matter-link', tc('memoryOwners.matter.invalidLink'));
        return false;
      }
      const messageId = link.searchParams.get('message'),
        summary = val('matter-summary').trim(),
        quote = val('matter-quote');
      if (!threadId) {
        fieldErr('matter-link', tc('memoryOwners.matter.invalidLink'));
        return false;
      }
      if (!summary && !quote) {
        fieldErr('matter-summary', tc('memoryOwners.matter.summaryOrQuote'));
        return false;
      }
      if (quote && !messageId) {
        fieldErr('matter-link', tc('memoryOwners.matter.quoteNeedsMessage'));
        return false;
      }
      let source = messageId ? { threadId: threadId, messageId: messageId } : { threadId: threadId };
      if (quote) {
        try {
          source = (
            await api.post('/api/memory/matters/source', {}, { threadId: threadId, messageId: messageId, quote: quote })
          ).source;
        } catch (error) {
          fieldErr('matter-quote', error.message);
          return false;
        }
      }
      const command = matter
        ? { operation: d.entryId ? 'correct' : 'append', matterId: matter.matterId, expectedRevision: matter.revision }
        : { operation: 'create', title: val('matter-title'), description: val('matter-description') };
      if (summary) command.summary = summary;
      if (d.entryId) {
        command.entryId = d.entryId;
        if (val('matter-link') !== oldLink || quote !== (old.quote || '')) command.source = source;
      } else command.sources = [source];
      return matterWrite(command);
    },
  });
};
A.matterChange = function (d) {
  const matter = matterState(true).data.matter,
    command = { operation: d.operation, matterId: matter.matterId, expectedRevision: matter.revision };
  if (d.entryId) return matterWrite(Object.assign(command, { entryId: d.entryId }));
  dialog({
    kind: 'matterConfirm',
    args: { operation: d.operation, title: matter.title },
    on: function () {
      return matterWrite(command);
    },
  });
};
