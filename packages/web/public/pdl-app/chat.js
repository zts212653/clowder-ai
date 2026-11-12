/* Application bindings. Engine, library and theme live unchanged under /pdl/. */
'use strict';
let chatPort;
let projectChat;
let CS;
let chatDataSnapshot;
let chatDataDiff;
let projectDataDiff;
let chatMessageIndex = new Map();
const chatEvents = {};
let chatConfirm;
let projectionNeeded = null;
const projectionPasses = [];
let heldNeeded = new Set();
let chatDataFrame = null;
// One frame collects every push before it; the engine works out what changed itself (state and view-model values).
function chatDataRender() {
  if (chatDataFrame) return chatDataFrame.work;
  const frame = {};
  chatDataFrame = frame;
  frame.work = settleHold(
    new Promise(function (resolve) {
      frame.done = resolve;
      frame.id = requestAnimationFrame(function () {
        chatDataFrame = null;
        render(true);
        resolve();
      });
    }),
  );
  return frame.work;
}
const projectionViews = new WeakMap();
// Chat arrays whose rows carry an id: a row is read and pushed as its own source, the key set ('.*') as the list
const CHAT_ROW_KEYS = ['messages', 'cats', 'queue', 'contexts', 'executions', 'activeRuns'];
function chatRowId(key, row) {
  return key === 'executions' ? row.executionId : key === 'activeRuns' ? row.responseMessageId : row.id;
}
function projectionRowKey(value, path) {
  return Array.isArray(value) && path.indexOf('chat.') === 0 && CHAT_ROW_KEYS.includes(path.slice(5))
    ? path.slice(5)
    : null;
}
function projectionRows(rows, path, key) {
  let view = projectionViews.get(rows);
  if (view) return view;
  view = new Proxy(rows, {
    get: function (source, k) {
      if (typeof k === 'string' && /^\d+$/.test(k)) {
        const row = source[k];
        return row && projectionNeeded ? projectionSource(row, path + '.' + chatRowId(key, row)) : row;
      }
      if (k === 'length' && projectionNeeded) projectionNeeded.add(path + '.*');
      return source[k];
    },
  });
  projectionViews.set(rows, view);
  return view;
}
function projectionSource(value, path) {
  const rowKey = projectionRowKey(value, path);
  if (rowKey) return projectionRows(value, path, rowKey);
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return value;
  let paths = projectionViews.get(value);
  if (!paths) projectionViews.set(value, (paths = new Map()));
  if (paths.has(path)) return paths.get(path);
  const view = new Proxy(value, {
    ownKeys: function (source) {
      if (projectionNeeded) projectionNeeded.add(path + '.*'); // the key set: only a list change (added, removed, order) reaches it
      return Reflect.ownKeys(source);
    },
    get: function (source, key) {
      const next = source[key],
        name = (path ? path + '.' : '') + String(key);
      if (
        projectionNeeded &&
        typeof key === 'string' &&
        (!next || Object.prototype.toString.call(next) !== '[object Object]') &&
        !projectionRowKey(next, name)
      )
        projectionNeeded.add(name);
      return projectionNeeded ? projectionSource(next, name) : next;
    },
  });
  paths.set(path, view);
  return view;
}
function chatDataKeys(value) {
  return Object.keys(value).filter(function (key) {
    return value[key] !== undefined;
  });
}
function chatDataEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const tag = Object.prototype.toString.call(a);
  if (tag !== Object.prototype.toString.call(b)) return false;
  if (tag === '[object Error]') return a.name === b.name && a.message === b.message;
  if (tag !== '[object Object]' && tag !== '[object Array]') return false;
  if (tag === '[object Array]' && a.length !== b.length) return false;
  const ak = chatDataKeys(a),
    bk = chatDataKeys(b);
  return (
    ak.length === bk.length &&
    ak.every(function (key) {
      return chatDataEqual(a[key], b[key]);
    })
  );
}
function chatDataCopy(value) {
  if (value == null || typeof value !== 'object') return value;
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Error]') return Object.assign(new Error(value.message), { name: value.name });
  if (tag === '[object Array]') return value.map(chatDataCopy);
  // File/Blob inputs are immutable; commands stay on the port, outside the data snapshot.
  if (tag !== '[object Object]') return value;
  return Object.fromEntries(
    chatDataKeys(value).map(function (key) {
      return [key, chatDataCopy(value[key])];
    }),
  );
}
function receiveChat(next) {
  const previous = chatDataSnapshot && chatDataSnapshot.chat,
    value = Object.assign({}, previous),
    diff = { collections: {}, fields: [] };
  if (previous === next) return { value: previous, diff: diff };
  Object.keys(Object.assign({}, previous, next)).forEach(function (key) {
    if (previous && previous[key] === next[key]) return;
    const array = CHAT_ROW_KEYS.includes(key),
      record = [
        'questions',
        'proposals',
        'schedules',
        'memoryProposals',
        'cloudRecoveries',
        'outputs',
        'live',
        'drafts',
      ].includes(key);
    if ((array || record) && next[key]) {
      const idFor = function (row) {
        return chatRowId(key, row);
      };
      const before = new Map(
          previous && previous[key]
            ? array
              ? previous[key].map(function (row) {
                  return [idFor(row), row];
                })
              : Object.entries(previous[key])
            : [],
        ),
        incoming = array
          ? next[key].map(function (row) {
              return [idFor(row), row];
            })
          : Object.entries(next[key]),
        ids = new Set(
          incoming.map(function (entry) {
            return entry[0];
          }),
        ),
        delta = { added: [], changed: [], removed: [], orderChanged: false };
      const entries = incoming.map(function (entry) {
        const id = entry[0],
          row = entry[1],
          old = before.get(id);
        if (before.has(id) && (old === row || chatDataEqual(old, row))) return [id, old];
        (before.has(id) ? delta.changed : delta.added).push(id);
        return entry;
      });
      before.forEach(function (_, id) {
        if (!ids.has(id)) delta.removed.push(id);
      });
      const previousIds = Array.from(before.keys());
      delta.orderChanged =
        array &&
        (before.size !== incoming.length ||
          incoming.some(function (entry, i) {
            return previousIds[i] !== entry[0];
          }));
      if (delta.added.length || delta.changed.length || delta.removed.length || delta.orderChanged) {
        value[key] = array
          ? entries.map(function (entry) {
              return entry[1];
            })
          : Object.fromEntries(entries);
        diff.collections[key] = delta;
      } else if (!previous || !(key in previous)) value[key] = array ? [] : {};
    } else if (!previous || previous[key] !== next[key]) {
      value[key] = next[key];
      diff.fields.push(key);
    }
  });
  return { value: value, diff: diff };
}
function pushChat(next) {
  const changed = receiveChatData({ chat: next });
  if (changed.length) chatDataRender();
  return chatDataDiff;
}
function receiveChatData(next) {
  // Compare pushed source data; VM reads project from this held snapshot.
  const received = next.chat && receiveChat(next.chat);
  if (received) chatDataDiff = received.diff;
  const beforeProject = chatDataSnapshot && chatDataSnapshot.project;
  const project = next.project && receiveProjectData(next.project);
  if (project) {
    projectDataDiff = { added: [], changed: [], removed: [] };
    Object.keys(project).forEach(function (owner) {
      const d = project[owner];
      if (d.added.length || d.changed.length || d.removed.length || d.orderChanged || d.fields.length)
        (beforeProject && owner in beforeProject ? projectDataDiff.changed : projectDataDiff.added).push(owner);
    });
  }
  const changed = Object.keys(next).filter(function (key) {
    return key === 'chat'
      ? Object.keys(received.diff.collections).length || received.diff.fields.length
      : key === 'project' && project
        ? projectDataDiff.added.length || projectDataDiff.changed.length || projectDataDiff.removed.length
        : !chatDataSnapshot || chatDataSnapshot[key] !== next[key];
  });
  if (changed.length) {
    navStale();
    chatDataSnapshot = projectionSource(Object.assign({}, chatDataSnapshot), '');
    changed.forEach(function (key) {
      if (key !== 'project') chatDataSnapshot[key] = key === 'chat' ? received.value : next[key];
    });
    if (received && received.diff.collections.messages) {
      chatMessageIndex = new Map(
        received.value.messages.map(function (m) {
          return [m.id, m];
        }),
      );
    }
    if (changed.includes('playback')) {
      const playback = chatDataSnapshot.playback;
      CS.speaking = playback.state === 'loading' || playback.state === 'playing' ? playback.messageId : null;
    }
  }
  return changed;
}
function chatHeldMessages() {
  return chatDataSnapshot.chat.messages
    .filter(function (m) {
      return !m.extra || !m.extra.recall || m.extra.recall.exposure !== 'none';
    })
    .map(function (m) {
      return m.extra && m.extra.recall ? { id: m.id, type: m.type, timestamp: m.timestamp, content: '' } : m;
    })
    .filter(function (m) {
      return !m.queuedEntryId && (!CS.viewCat || m.type === 'user' || m.catId === CS.viewCat);
    });
}
function chatFindResults() {
  const data = chatDataSnapshot.chat,
    q = CS.find.q.trim().toLowerCase();
  if (data.search && data.search.query.toLowerCase() === q)
    return data.search.results.map(function (m) {
      return { mid: m.messageId, thread: m.threadId };
    });
  return chatHeldMessages()
    .filter(function (m) {
      return q && m.content.toLowerCase().includes(q);
    })
    .sort(function (a, b) {
      return CS.find.sort === 'rel'
        ? b.content.toLowerCase().split(q).length - a.content.toLowerCase().split(q).length
        : b.timestamp - a.timestamp;
    })
    .map(function (m) {
      return { mid: m.id, thread: data.threadId };
    });
}
const chatMarkdown = new Map();
function chatMessageVM(x) {
  let body = chatMarkdown.get(x.mid);
  if (!body || body.md !== x.md) {
    body = msgMd({ md: x.md });
    chatMarkdown.set(x.mid, body);
  }
  return chatOwnerMessageVM(
    Object.assign({}, x, {
      html: body.html,
      suggestions: x.watcher ? watcherSuggestions(chatDataSnapshot.chat.threadId, x.mid) : [],
    }),
  );
}
function cafeTypedItems() {
  const model = chatRead('chatPop');
  return CS.pop.kind === 'mention'
    ? model.mentions
    : CS.pop.kind === 'ctx'
      ? model.contexts
      : CS.pop.kind === 'slash'
        ? model.commands
        : model.paths;
}
let chatCatalogSource, chatCatalogValue, chatMeSource, chatMeValue;
let chatServiceItems,
  chatSpeechAvailable = false;
function chatRead(name) {
  if (name === 'memberCatalog') {
    const cats = chatDataSnapshot.chat.cats;
    if (chatCatalogSource !== cats) {
      chatCatalogSource = cats;
      chatCatalogValue = projectChat(projectChatData(), CS, chatDataSnapshot).memberCatalog;
    }
    return chatCatalogValue;
  }
  if (name === 'me') {
    const me = chatDataSnapshot.chat.me;
    if (projectionNeeded) projectionNeeded.add('chat.me');
    if (chatMeSource !== me) {
      chatMeSource = me;
      chatMeValue = projectChat(projectChatData(), CS, chatDataSnapshot).me;
    }
    return chatMeValue;
  }
  if (name === 'speechAvailable') {
    const voice = projectData('voice'),
      services = voice && voice.services,
      items = services && services.items;
    if (chatServiceItems !== items) {
      chatServiceItems = items;
      chatSpeechAvailable = projectChat(projectChatData(), CS, chatDataSnapshot).speechAvailable;
    }
    return chatSpeechAvailable;
  }
  return projectChat(projectChatData(), CS, chatDataSnapshot, name)[name];
}
/* A reply still in progress: streaming, or the response an active run is writing (before its first output) */
function chatReplying(mid) {
  const message = chatMessageIndex.get(mid);
  return (
    !!message &&
    (message.isStreaming ||
      chatDataSnapshot.chat.activeRuns.some(function (run) {
        return run.responseMessageId === mid;
      }))
  );
}
/* Time as data: a half-minute clock in UI state. What reads it (the replying line: tip every 30 s, silent minutes) redraws when it moves */
RUN_TICK.push(function () {
  const at = Math.floor(Date.now() / 30000) * 30000;
  if (CS.clock === at) return;
  CS.clock = at;
  chatDataRender();
});
function chatLive(id, turn, threadId) {
  const source = chatDataSnapshot.chat.live && chatDataSnapshot.chat.live[threadId];
  if (!source || (turn != null && !chatReplying(turn))) return '';
  return source[id] === 'done' ? '' : source[id] || '';
}
function chatAction(name, d, el) {
  return Promise.resolve()
    .then(function () {
      return chatPort.action(name, d || {}, el);
    })
    .then(function (value) {
      // A host action's effects arrive as data pushes or as changes to CS; the engine works out what changed.
      return chatDataRender().then(function () {
        return value;
      });
    })
    .catch(function (error) {
      if (error.name !== 'PdlReadError') toast(error.message);
      return false;
    });
}
function chatUpdate(port) {
  if (port) {
    chatPort = port;
    CS = pdlTrack(port.state, 'CS');
    const sidebar = receiveSidebar(port.sidebarData),
      changed = receiveChatData(port.data),
      sidebarChanged =
        sidebar.added.length ||
        sidebar.changed.length ||
        sidebar.removed.length ||
        sidebar.orderChanged ||
        sidebar.fields.length;
    if (!(sidebarChanged || changed.length)) return;
    if (sidebarChanged) navStale();
  }
  const changed = S.thread !== chatPort.threadId;
  S.thread = chatPort.threadId;
  S.navW = chatPort.navResize.width();
  if (changed) {
    S.ws.recallFor = null;
    S.ws.recallPages = 0;
    navStale();
    go(chatPort.threadId === 'default' ? 'home' : 'chat');
    return;
  }
  chatDataRender();
}
window.clowderChat = {
  update: chatUpdate,
  pushSidebar: pushSidebar,
  pushProject: pushProjectData,
  pushChat: pushChat,
  dataError: dataError,
  dataOk: dataOk,
  emit: function (event, data) {
    let result;
    (chatEvents[event] || []).forEach(function (fn) {
      result = fn(data);
    });
    return result;
  },
  confirm: function (kind, args) {
    return new Promise(function (resolve) {
      chatConfirm = resolve;
      dialog({
        kind: kind,
        args: args,
        on: function () {
          chatConfirm = null;
          resolve(true);
          render(true);
        },
      });
    });
  },
  start: async function (port, projections) {
    projectChat = projections;
    chatPort = port;
    CS = pdlTrack(port.state, 'CS');
    if (!CS.draft) CS.draft = { 'chat-input': '' };
    receiveSidebar(port.sidebarData);
    receiveChatData(port.data);
    // Register first: beforeRender runs last, onRender runs first, so only the
    // projection is recorded, not the other bindings' post-render effects.
    beforeRender(function () {
      if (chatDataFrame) {
        const frame = chatDataFrame;
        chatDataFrame = null;
        cancelAnimationFrame(frame.id);
        frame.done();
      }
      projectionNeeded = pdlReadSet();
      projectionPasses.push(projectionNeeded);
    });
    onRender(function () {
      const next = projectionPasses.pop();
      projectionNeeded = projectionPasses.length ? projectionPasses[projectionPasses.length - 1] : null;
      if (projectionNeeded) {
        next.forEach(function (key) {
          projectionNeeded.add(key);
        });
        return;
      }
      const added = Array.from(next).filter(function (key) {
          return !heldNeeded.has(key);
        }),
        removed = Array.from(heldNeeded).filter(function (key) {
          return !next.has(key);
        });
      heldNeeded = next;
      if (!added.length && !removed.length) return;
      queueMicrotask(function () {
        chatPort.needed({ added: added, removed: removed });
        (chatEvents['sources:needed'] || []).forEach(function (fn) {
          fn({ added: added, removed: removed });
        });
      });
    });
    apiProvide({
      get: port.get,
      post: port.post,
      file: port.file,
      on: function (name, fn) {
        (chatEvents[name] || (chatEvents[name] = [])).push(fn);
      },
      send: function (name, data) {
        if (name.indexOf('terminal:') === 0) {
          return Promise.resolve(chatPort.action(name, data)).catch(function (error) {
            toast(error.message);
          });
        }
        if (name === 'tree:open') {
          chatAction('fileChildren', { p: data.p }).then(function () {
            (chatEvents['tree:loaded'] || []).forEach(function (fn) {
              fn(data);
            });
          });
          return;
        }
        Promise.resolve(chatAction(name, data)).then(function () {
          (chatEvents.refreshed || []).forEach(function (fn) {
            fn(data);
          });
        });
      },
    });
    ioConnect(api);
    platformProvide({
      richRender: port.richRender,
      terminal: port.terminal,
      packRead: port.packRead,
      packSave: function (name, pack) {
        PLATFORM.download(name, port.packText(pack), 'application/yaml');
      },
    });
    api.on('composer:changed', function () {
      render(true); // the host changed composer state (a restored draft): the composer shows it now
    });
    STATE_ROOTS.cs = function () {
      return CS;
    };
    SET_AFTER['s.dialog'] = function (value) {
      if (!value && chatConfirm) {
        const resolve = chatConfirm;
        chatConfirm = null;
        resolve(false);
      }
    };
    Object.assign(S, {
      navW: port.navResize.width(),
      thread: port.threadId,
      ws: {},
      running: false,
      runSecs: 0,
      panel: null,
    });
    CS.runtime = { drafts: {} };
    KEY_FNS.push(function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key || '').toLowerCase() === 'k') {
        e.preventDefault();
        A.searchOpen({ stay: 1 });
        return true;
      }
    });
    A.scheduleDecide = function (d) {
      return chatAction('cardDecide', { mid: d.mid, v: d.decision === 'approve' ? 'ok' : 'no' });
    };
    ['chatHeader', 'chatPage', 'chatComposer', 'chatPop', 'chatWelcome'].forEach(function (name) {
      VM[name] = function () {
        return chatRead(name);
      };
    });
    VM.threadExport = function () {
      return {
        items: chatRead('threadExport')
          .items.filter(function (x) {
            return S.exportMids == null || S.exportMids.indexOf(x.mid) >= 0;
          })
          .map(chatMessageVM),
      };
    };
    VM.chatHeader = function () {
      return Object.assign({}, chatRead('chatHeader'), { editing: !!S.renaming });
    };
    VM.chatComposer = function () {
      return chatRead('chatComposer');
    };
    VM.chatPop = function () {
      return chatRead('chatPop');
    };
    // a list the model hands over as ids + a builder: each item is built on its own
    function chatList(name, map) {
      const parts = chatRead(name);
      return {
        parts: parts,
        items: parts.ids.map(function (_, i) {
          return map(parts.item(i));
        }),
      };
    }
    VM.chatStream = function () {
      return { items: chatList('chatStreamParts', chatMessageVM).items };
    };
    VM.chatTicks = function () {
      const list = chatList('chatTicksParts', function (tick) {
        return tick;
      });
      return { older: list.parts.older, ticks: list.items };
    };
    Object.assign(WHO_DATA, {
      members: function () {
        return chatRead('memberCatalog');
      },
      member: function (id, name) {
        return (
          chatRead('memberCatalog').find(function (m) {
            return m.id === id;
          }) || { id: id, name: name || id, handle: '' }
        );
      },
      me: function () {
        return chatRead('me');
      },
      live: function (id, turn) {
        return chatLive(id, turn, sidebarData().threadId);
      },
      threadLive: function (tid, id) {
        return chatLive(id, undefined, tid);
      },
      handleId: function (handle) {
        const m = chatRead('memberCatalog').find(function (m) {
          return m.handle === handle;
        });
        return m ? m.id : null;
      },
    });
    ENGINE_PARTS.navState = function () {
      return { thread: S.thread };
    };
    ENGINE_PARTS.navRestore = function (x) {
      if (x.thread) chatAction('thread', { id: x.thread });
    };
    ENGINE_PARTS.addressParam = function (route, args) {
      return route === 'chat' ? S.thread : args.p;
    };
    PAGES.chat = function () {
      return pdlView('page.chat');
    };

    NAV_TITLE = function () {
      return chatRead('chatHeader').title;
    };
    ENT.title = {
      get: function () {
        return chatRead('chatHeader');
      },
      name: 'title',
      inline: 'title-edit',
      rename: function (x, value) {
        return chatAction('rename', { v: value });
      },
    };
    A.renameCommit = function (d, el) {
      A.rename({ entity: 'title', v: el.value });
    };
    INPUTS.cafeCompose = function (e) {
      const ta = e.target,
        before = CS.draft[ta.id] || '',
        previousPop = CS.pop;
      CS.draft[ta.id] = ta.value;
      return Promise.resolve(chatPort.action('compose', { v: ta.value, pos: String(ta.selectionStart) })).then(
        function () {
          if (CS.pop && CS.pop.typed) {
            const pop = CS.pop,
              same = previousPop && previousPop.typed && previousPop.kind === pop.kind;
            spotOpen('caret', ta.parentElement, caretRect(ta), function (spot) {
              popAnchor('chat.pop', spot);
              CS.pop = Object.assign(pop, {
                typed: true,
                input: ta.id,
                i: same ? Math.min(previousPop.i, 30) : 0,
                up: true,
                span: 5,
              });
              const count = cafeTypedItems().length;
              if (CS.pop.i >= count) CS.pop.i = 0;
              render(true);
            });
          } else if ((previousPop && previousPop.typed) || !before.trim() !== !ta.value.trim()) {
            render(true);
          }
        },
      );
    };
    KEY_FNS.push(function (e) {
      if (!CS.pop || !CS.pop.typed || e.target.id !== CS.pop.input || e.isComposing) return false;
      const items = cafeTypedItems();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const next = keyStep(e, CS.pop.i, items.length, { wrap: true, flip: true });
        if (next != null) {
          e.preventDefault();
          CS.pop.i = next;
          render(true);
          return true;
        }
      }
      if (((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') && items.length) {
        e.preventDefault();
        const row = document.querySelector('.pop-host[data-pop="chat.pop"] [aria-selected="true"][data-act]');
        if (row) row.click();
        return true;
      }
      return false;
    });
    [
      'send',
      'stop',
      'cafeRunStop',
      'cafeMsgRetry',
      'cafeQueue',
      'cafeReadAll',
      'cafeWhisper',
      'cafePick',
      'cafeTypedPick',
      'cloudRecoveryRead',
      'bindRetry',
    ].forEach(function (name) {
      A[name] = function (d, el) {
        if (name === 'send') {
          const input = d.for || 'chat-input',
            vote = /^\/vote(?:\s+(.*))?$/.exec(CS.draft[input].trim());
          if (vote && !/^(?:status|cast)(?:\s|$)/.test(vote[1] || ''))
            return vote[1] === 'end' ? A.cafeVoteEnd({}) : A.dialog({ kind: 'vote', question: vote[1] || '' });
        }
        if (name === 'cafeTypedPick') {
          const p = CS.pop,
            item = cafeTypedItems()[+d.i];
          if (p.kind === 'mention') d = { insert: d.text + ' ' };
          else if (item.kind === 'THREAD') d = { kind: 'thread', id: item.id };
          else if (item.kind === 'FILE') d = { kind: 'file', id: item.path, path: item.path };
          else if (item.kind === 'work')
            d = { kind: 'work', id: item.attachment.workId, path: String(item.attachment.version) };
        }
        if (name === 'cafeQueue') {
          const entry = chatRead('chatComposer').queue.items[+d.i];
          d = { id: entry.key, v: d.v === 'edit' ? 'recall' : 'remove' };
        }
        if (name === 'cafeTypedPick' && CS.pop && CS.pop.typed) {
          const pop = CS.pop,
            id = pop.input || 'chat-input',
            current = val(id, true),
            before = current.slice(0, pop.start),
            after = current.slice(pop.end);
          const apply = function (text) {
            CS.pop = null;
            A.insert({ into: id, mode: 'replace', text: before + text + after });
            focusField(id, before.length + text.length);
          };
          if (d.insert !== undefined) return apply(d.insert);
          return chatAction(name, d, el).then(function (value) {
            if (value !== false) apply('');
          });
        }
        if (d.i != null && d.mid == null) d = Object.assign({}, d, { mid: chatRead('chatStream').items[+d.i].mid });
        return chatAction(name, d, el);
      };
    });
    ['cafeExport', 'cafeMultiExport'].forEach(function (name) {
      A[name] = function (d) {
        return chatAction(name, d).then(
          function (file) {
            if (file) {
              A.download(file);
              file.release();
            }
          },
          function (error) {
            toast(error.message, null, 'danger');
          },
        );
      };
    });
    A.cafeQueueSend = function (d) {
      const entry = chatRead('chatComposer').queue.items[+d.i];
      return dialog({
        kind: 'queueSend',
        args: {
          text: entry.text,
          names: entry.to.map(function (id) {
            return WHO_DATA.member(id).name;
          }),
        },
        on: function () {
          return chatPort.action('cafeQueueSend', {
            id: entry.key,
            mode: picked('steer'),
          });
        },
      });
    };
    A.cafeMic = function () {
      return chatAction('cafeMic');
    };
    A.cafeHistOpen = function (d, el) {
      return A.popOpen({ pop: 'history' }, el);
    };
    WHEN['voice.output'] = function () {
      return !!chatRead('speechAvailable');
    };
    SET_AFTER['cs.viewCat'] = function () {
      return chatAction('conversationView', { v: CS.viewCat || '' });
    };
    SET_AFTER['cs.speaking'] = function () {
      return chatAction('speak', { mid: CS.speaking || '' });
    };
    WHEN['voice.input'] = function () {
      return chatRead('chatComposer').voiceAvailable;
    };
    A.thread = function (d) {
      return chatAction('thread', d);
    };
    A.threadOpen = A.thread;
    ['cardDecide', 'cardAskToggle', 'cardAsk', 'entityResolve'].forEach(function (name) {
      A[name] = function (d) {
        return chatAction(name, d);
      };
    });
    A.entityAction = function (d) {
      CS.f['entity-action-' + d.mid] = d.v;
      const c = chatRead('chatStream').items.find(function (x) {
        return x.mid === d.mid;
      }).card.conflict;
      c.replacements.forEach(function (row) {
        CS.f[row.id] = '';
      });
      if (c.replacements.length) {
        render(true);
        return;
      }
      return A.entityResolve({
        mid: d.mid,
        fingerprint: c.fingerprint,
        action: d.v,
      });
    };
    A.entityName = function (d) {
      const c = chatRead('chatStream').items.find(function (x) {
          return x.mid === d.mid;
        }).card.conflict,
        names = {};
      for (const row of c.replacements) {
        const value = row.value.trim();
        if (!value) {
          fieldErr(row.id, tc('pcf.fill', row.label));
          return false;
        }
        names[row.key] = value;
      }
      return A.entityResolve({
        mid: d.mid,
        fingerprint: c.fingerprint,
        action: c.selected,
        replacementCanonicalNames: JSON.stringify(names),
      });
    };
    A.draftAttachment = function (d) {
      CS.lb = { mid: '', block: '', i: +d.i, target: { kind: 'draftAttachment', i: +d.i } };
      render(true);
    };
    A.msgJump = function (d) {
      S.inboxOpen = false;
      return chatAction('jump', d.t ? Object.assign({}, d, { thread: d.t }) : d);
    };
    A.findOpen = function (d) {
      const list = chatFindResults();
      CS.findNav = {
        q: CS.find.q,
        list: list,
        i: +d.i,
        back: streamTop(),
        backThread: chatDataSnapshot.chat.threadId,
      };
      return chatAction('jump', list[+d.i]);
    };
    A.findStep = function (d) {
      const n = CS.findNav;
      n.i = (n.i + Number(d.v) + n.list.length) % n.list.length;
      return chatAction('jump', n.list[n.i]);
    };
    let findReturn = null;
    A.findBack = function () {
      const n = CS.findNav;
      CS.findNav = null;
      if (n.backThread !== chatDataSnapshot.chat.threadId) {
        findReturn = { threadId: n.backThread, at: n.back };
        return chatAction('thread', { id: n.backThread });
      }
      render(true);
      streamScrollTo(n.back);
    };
    onRender(function () {
      if (findReturn && chatDataSnapshot.chat.threadId === findReturn.threadId && !chatDataSnapshot.chat.loading) {
        streamScrollTo(findReturn.at);
        findReturn = null;
      }
    });
    VM.chatPage = function () {
      const n = CS.findNav,
        owner = chatOwnerData(),
        reading = owner && owner.vote,
        vote = reading && reading.threadId === chatPort.threadId && reading.value;
      return Object.assign({}, chatRead('chatPage'), {
        find: n ? { q: n.q, index: n.i + 1, count: n.list.length } : null,
        vote:
          vote && vote.status === 'active'
            ? {
                question: vote.question,
                count: vote.voteCount == null ? Object.keys(vote.votes).length : vote.voteCount,
              }
            : null,
      });
    };
    A.histOpen = function () {
      CS.f['hs-q'] = '';
      CS.modal = { kind: 'hist' };
      render(true);
    };
    A.histPick = function (d) {
      CS.modal = null;
      render(true);
      return A.insert({ into: 'chat-input', text: d.v, mode: 'replace' });
    };
    A.popBack = function () {
      const stack = CS.pop.stack || [];
      CS.pop.page = stack.pop() || 'main';
      render(true);
    };
    A.memberOpen = function (d) {
      return go('member-' + (d.p || d.who || d.id), { ask: true });
    };
    A.pluginOpen = function (d) {
      return go(d.to, { ask: true });
    };
    A.cbAuthOpen = function () {
      S.ws.opsView = 'obs';
      S.ws.obsV = 'auth';
      ENGINE_PARTS.openTab('panel', 'ops');
      return chatAction('opsBrowse');
    };
    A.traceOpen = function (d) {
      const m = chatHeldMessages()[+d.i],
        stream = m.extra && m.extra.stream,
        id = stream && (stream.turnInvocationId || stream.invocationId);
      if (id) return A.runOpen({ k: id });
      S.folds['row:exec'] = m.catId;
      return ENGINE_PARTS.openTab('panel', 'exec');
    };
    A.streamLatest = function () {
      streamScrollTo(null);
    };
    STREAM_OLDER.load = function (done) {
      if (chatRead('chatPage').older) return false;
      chatAction('older').then(done);
    };
    A.streamOlder = function () {
      return STREAM_OLDER.load(function () {});
    };
    A.reply = function (d) {
      return chatAction('reply', d);
    };
    SET_AFTER['cs.reply'] = function () {
      chatAction('reply', { mid: CS.reply || '' });
    };
    A.cafeAttach = A.attachOpen = function () {
      PLATFORM.pickFile('', function (file) {
        chatPort.attach([file]);
        CS.pop = null;
        render(true);
      });
    };
    A.ctxPop = function (d, el) {
      return A.popOpen({ pop: 'ctx' }, el);
    };
    A.popOpen = function (d, el) {
      CS.pop = {
        kind: d.pop,
        page: d.page,
        i: d.i === undefined ? undefined : +d.i,
        mode: d.mode,
        up: !!d.up,
        span: d.span ? +d.span : undefined,
        fit: !!d.fit,
      };
      popAnchor('chat.pop', el);
      render(true);
    };
    A.popClose = function () {
      // The popup frame closing it: drop only this popup, no whole-page render (the composer island).
      CS.pop = null;
      popRefresh('chat.pop');
    };
    A.mediaOpen = function (d) {
      CS.lb = { mid: d.mid, block: d.block, i: +d.i };
      render(true);
    };
    VM.mediaPreview = function () {
      return chatRead('mediaPreview');
    };
    VM.work = function () {
      return chatRead('mediaPreview');
    };
    A.workDownload = function () {
      const preview = chatRead('mediaPreview');
      return A.download({ source: preview.source, name: preview.title });
    };

    A.modal = function (d) {
      if (d.v === 'tset') return A.threadSettings(d);
      if (d.v === 'import') return A.importOpen(d);
      if (['org', 'tags', 'classify'].indexOf(d.v) >= 0) return sidebarModalOpen(d);
      if (MODALS[d.v]) {
        CS.modal = { kind: d.v, id: d.id };
        const initialized = MODAL_INIT[d.v] ? MODAL_INIT[d.v](CS.modal) : undefined;
        render(true);
        return initialized;
      }
      if (d.v === 'branch') {
        const message =
          chatRead('chatStream').items.find(function (m) {
            return m.mid === d.mid;
          }) || chatRead('chatStream').items[+d.i];
        CS.modal = { kind: 'branch', id: message.mid, cats: [], messageIds: [message.mid] };
        CS.f['br-text'] = message.md;
        render(true);
        return;
      }
      if (d.v !== 'forward') return;
      const items = chatRead('chatStream').items;
      const mids =
        d.id === 'multi'
          ? items
              .filter(function (x) {
                return CS.picked[x.mid];
              })
              .map(function (x) {
                return x.mid;
              })
          : [d.mid || items[+d.i].mid];
      CS.modal = {
        kind: 'forward',
        id: d.id,
        messageIds: mids,
        cats: [],
        selectionItems: d.selection ? [d.selection] : undefined,
      };
      render(true);
    };
    SET_AFTER['cs.modal.to'] = function () {
      CS.modal.cats = sidebarData()
        .threads.find(function (t) {
          return t.id === CS.modal.to;
        })
        .participants.slice();
    };
    VM.chatModal = function () {
      const m = CS.modal;
      if (!m) return null;
      let d;
      if (MODALS[m.kind]) d = MODALS[m.kind](m);
      else if (m.kind === 'hist') {
        const q = (CS.f['hs-q'] || '').toLowerCase();
        d = {
          vm: {
            q: CS.f['hs-q'],
            items: chatDataSnapshot.chat.historyEntries
              .filter(function (t) {
                return !q || t.toLowerCase().includes(q);
              })
              .map(function (t) {
                return { t: t };
              }),
          },
        };
      } else if (m.kind === 'branch')
        d = {
          vm: {
            edited: CS.f['br-text'] !== undefined,
            value: CS.f['br-text'],
            quote: chatMessageIndex.get(m.id).content,
          },
          submit: true,
        };
      else {
        const model = chatRead('chatModal');
        if (!model) return null;
        d = { vm: model.data, submit: true, submitDisabled: model.submission.disabled };
      }
      const frame = modalFrame(m.kind, d.vm);
      return {
        kind: m.kind,
        title: frame.title,
        help: frame.help,
        wide: !!frame.wide,
        view: d.view || 'modal.' + m.kind,
        data: d.vm,
        form: d.submit ? 'cafeModal' : '',
        submission: d.submit ? { label: frame.submitLabel, disabled: !!m.busy || !!d.submitDisabled } : null,
        scanLabel: frame.scanLabel,
        busy: !!m.busy,
        error: m.error || d.error || '',
      };
    };
    MODALS.anno = function (m) {
      return {
        vm: { quote: m.quote, value: CS.f['an-text'], rows: 4 },
        submit: function () {
          return m.onSubmit();
        },
      };
    };
    FORMS.cafeModal = async function () {
      const m = CS.modal;
      if (!m || m.busy || (m.kind === 'forward' ? !m.to : VM.chatModal().submission.disabled)) return;
      m.busy = true;
      m.error = '';
      render(true);
      try {
        if (MODALS[m.kind]) {
          if ((await MODALS[m.kind](m).submit(m)) === false) return false;
        } else if (m.kind === 'branch')
          await chatPort.action('threadBranch', { mid: m.id, text: CS.f['br-text'] || '' });
        else if (m.kind === 'org') await sidebarSubmit(m);
        else
          await chatPort.action('forward', {
            to: m.to,
            cats: JSON.stringify(m.cats),
            mids: JSON.stringify(m.messageIds),
            partial: String(m.id === 'multi'),
          });
        if (CS.modal === m) {
          CS.modal = null;
          if (m.kind === 'forward') {
            CS.multi = false;
            CS.picked = {};
          }
        }
        return true;
      } catch (error) {
        m.error = error.message;
      } finally {
        m.busy = false;
        render(true);
      }
    };

    A.fieldFocus = function (d) {
      focusField(d.id);
    };
    VM.memberCard = function () {
      return chatRead('memberCard');
    };
    A.memberCard = function (d) {
      const who = d.who || chatRead('chatComposer').target.who;
      if (CS.memberCard && CS.memberCard !== who) {
        CS.memberCard = null;
        render(true);
      }
      CS.memberCard = who;
      render(true);
    };
    A.mention = function (d) {
      const member = WHO_DATA.member(d.who);
      CS.memberCard = null;
      render(true);
      A.insert({ into: 'chat-input', text: member.handle + ' ' });
    };

    A.multi = function (d) {
      CS.multi = true;
      CS.picked = {};
      const x = chatRead('chatStream').items[+d.i];
      if (x) return chatAction('cafePick', { mid: x.mid });
      render(true);
    };

    ENT.proj = {
      get: function (id) {
        const section = VM.navThreads().sections.find(function (section) {
          return section.head.id === id;
        });
        return section ? { id: id, name: section.head.name, pinned: section.head.fixed } : null;
      },
      title: function () {
        return { kind: 'cafeProjRename' };
      },
      set: function (project, field, value) {
        return chatAction('projectPin', { id: project.id, v: String(value) });
      },
      rename: function (project, value) {
        return chatAction('projectRename', { id: project.id, v: value });
      },
      undo: ['false'],
      undoText: function () {
        return tc('chat.project.pin.unpinned');
      },
    };

    SET_AFTER['cs.projAll'] = function (value) {
      VM.navThreads().sections.forEach(function (section) {
        CS.projOpen[section.head.id] = value === '1';
      });
      CS.projAll = null;
    };
    const threads = function () {
      return sidebarData().threads;
    };
    ENT.thread = {
      coll: threads,
      name: 'title',
      rename: function (x, v) {
        return chatAction('rename', { id: x.id, v: v });
      },
      set: function (x, field, v) {
        return chatAction('threadStatus', { id: x.id, field: field, v: String(v) });
      },
      remove: function (x) {
        return chatAction('threadDelete', { id: x.id });
      },
    };
    ENT.pin = {
      get: function (id) {
        return threads().find(function (t) {
          return t.id === id;
        });
      },
      status: 'pinned',
      set: ENT.thread.set,
    };

    ['richPick', 'richRandom', 'richSubmit'].forEach(function (name) {
      A[name] = function (d) {
        return chatAction(name, d);
      };
    });
    ENT.msgDel = {
      get: function (id) {
        return chatRead('chatStream').items[+id];
      },
      set: function (x, field, v) {
        return chatAction('messageDelete', { mid: x.mid, v: String(v) });
      },
    };
    ['ctx', 'att'].forEach(function (kind) {
      ENT[kind] = {
        get: function (id) {
          return { id: id };
        },
        remove: function (x) {
          return chatAction(kind === 'ctx' ? 'removeContext' : 'removeImage', {
            id: x.id,
          });
        },
      };
    });
    A.cafeMsgRetry = function (d) {
      const x = chatRead('chatStream').items[+d.i];
      dialog({
        kind: 'messageRetry',
        args: { name: WHO_DATA.member(x.who).name },
        on: function () {
          return chatAction('cafeMsgRetry', { mid: x.mid });
        },
      });
    };
    A.cafeExecOpen = function (d) {
      return chatAction('cafeExecOpen', { mid: chatRead('chatStream').items[+d.i].mid });
    };
    A.cafePaste = function (d, el, event) {
      const files = Array.from(event.clipboardData.files).filter(function (f) {
        return f.type.indexOf('image/') === 0;
      });
      if (!files.length) return false;
      chatPort.attach(files);
      return true;
    };
    INPUTS.cafeField = function (e) {
      CS.f[e.target.id] = e.target.value;
      if (e.target.id.indexOf('pick-') === 0) render(true);
    };
    A.cafeAskSubmit = function (d) {
      return chatAction('runtimeRespond', d);
    };
    ['runtimePick', 'runtimeRespond', 'runtimeConversationInsert', 'runtimeReload'].forEach(function (name) {
      A[name] = function (d) {
        return chatAction(name, d);
      };
    });
    INPUTS.runtimeValue = function (e) {
      const id = e.target.dataset.id,
        key = e.target.dataset.key;
      const draft = CS.runtime.drafts[id] || (CS.runtime.drafts[id] = { values: {} });
      draft.values[key] = e.target.value;
    };
    INPUTS.runtimeCustom = function (e) {
      return chatAction('runtimeCustom', { id: e.target.dataset.id, v: e.target.value });
    };
    CHANGES.runtimeSet = function (e) {
      const id = e.target.dataset.id,
        key = e.target.dataset.key;
      const draft = CS.runtime.drafts[id] || (CS.runtime.drafts[id] = { values: {} });
      draft.values[key] = e.target.value;
      render(true);
    };
    INPUTS.cafeLive = function (e) {
      if (e.target.id === 'ctx-q') return chatAction('contextSearch', { q: e.target.value });
    };
    // redraw on every keystroke: the works / memory handoff carries the current query
    INPUTS.cafeFindQ = function (e) {
      CS.find.q = e.target.value;
      CS.find.active = false;
      render(true);
    };
    FORMS.cafeFind = function () {
      CS.find.active = true;
      return chatAction('cafeFind');
    };
    RESIZERS.nav = port.navResize;
    rtBind('panel', {
      view: function (key) {
        const draw = PANELS[key.indexOf('work:') === 0 ? 'work' : key];
        return draw ? draw(key) : PDL_VIEWS[key] ? pdlView(key) : '';
      },
      exists: function (key) {
        return !!PANEL_VIEWS[key];
      },
      visible: function (key) {
        return !!PANEL_VIEWS[key];
      },
      title: function (key) {
        return PANEL_VIEWS[key][0];
      },
      icon: function (key) {
        return PANEL_VIEWS[key][1];
      },
      menu: function () {
        const inThread = S.route === threadView();
        return Object.keys(PANEL_VIEWS).filter(function (key) {
          return !!PANEL_VIEWS[key][3] && (!panelScoped(key) || inThread);
        });
      },
      badge: function (key) {
        return BADGES[key] ? BADGES[key]() : null;
      },
    });
    onRender(function () {
      if (CS.pendingMid) {
        const mid = CS.pendingMid;
        delete CS.pendingMid;
        // Start after the draw restores the previous reading anchor.
        queueMicrotask(function () {
          scrollToMessage(mid);
        });
      }
    });
    bindAppearance();
    bindPluginSpaces();
    bindOwnerProjections();
    bindProject();
    bindHome();
    bindSidebar();
    bindInbox();
    bindMembers();
    bindAccounts();
    bindProfiles();
    bindCapabilities();
    bindRules();
    bindThreadSettings();
    bindNotifications();
    bindSetup();
    bindChatOwners();
    bindPlacement();
    onStart('pdl', pdlNodeSlots);
    let bootDone;
    const booted = new Promise(function (resolve) {
      bootDone = resolve;
    });
    onStart('boot', async function () {
      settleHold(chatPort.exportReady);
      S.exportMids = chatPort.exportMids;
      applyThemeVals();
      applyAssets();
      // the address after # reopens the page it names (settings, member, plugin…); the thread itself is in the path
      const address = (location.hash || '').replace('#', '');
      if (chatPort.exportMids === undefined && address && !/^(chat|home|export)(-|$)/.test(address))
        go(address, { address: true });
      else
        go(
          chatPort.exportMids === undefined
            ? chatPort.threadId === 'default'
              ? 'home'
              : 'chat'
            : 'export-' + chatPort.threadId,
        );
      bootDone();
    });
    // React loads these classic scripts after the native event; the engine runs its own startup phases.
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await booted;
  },
};
