/* Sidebar data and commands; all rows, fields and dialogs use the copied declarations. */
'use strict';
let sidebarSnapshot;
let sidebarOwnerValue;
function receiveSidebar(next) {
  if (next === sidebarSnapshot) return { added: [], changed: [], removed: [], orderChanged: false, fields: [] };
  const diff = { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
    previous = sidebarSnapshot,
    before = new Map(
      (previous ? previous.threads : []).map(function (t) {
        return [t.id, t];
      }),
    ),
    ids = new Set(
      next.threads.map(function (t) {
        return t.id;
      }),
    );
  const threads = next.threads.map(function (t) {
    const old = before.get(t.id);
    if (old === t || (old && chatDataEqual(old, t))) return old;
    (old ? diff.changed : diff.added).push(t.id);
    return t;
  });
  before.forEach(function (_, id) {
    if (!ids.has(id)) diff.removed.push(id);
  });
  diff.orderChanged =
    !previous ||
    previous.threads.length !== next.threads.length ||
    next.threads.some(function (t, i) {
      return t.id !== previous.threads[i].id;
    });
  const fields = {};
  Object.keys(next).forEach(function (key) {
    if (key === 'threads') return;
    const fieldDiff = { added: [], changed: [], removed: [], orderChanged: false, fields: [] };
    fields[key] = receiveProjectValue(previous && previous[key], next[key], 'sidebar.' + key, fieldDiff);
    if (!previous || previous[key] !== fields[key]) diff.fields.push(key);
  });
  if (diff.added.length || diff.changed.length || diff.removed.length || diff.orderChanged || diff.fields.length) {
    sidebarSnapshot = Object.assign({}, previous, { threads: threads });
    diff.fields.forEach(function (key) {
      sidebarSnapshot[key] = fields[key];
    });
    const o = sidebarSnapshot.owner;
    sidebarOwnerValue = o
      ? Object.assign({}, o, {
          classification: sidebarSnapshot.classification,
          unread: sidebarSnapshot.attention.filter(function (r) {
            return r.unreadCount > 0;
          }).length,
          runningThreadIds: Array.from(
            new Set(
              sidebarSnapshot.executions.map(function (e) {
                return e.threadId;
              }),
            ),
          ),
          preferences: Object.assign({}, o.preferences, {
            open: o.preferences.open || {},
          }),
        })
      : null;
  }
  return diff;
}
function pushSidebar(next) {
  const diff = receiveSidebar(next);
  if (diff.added.length || diff.changed.length || diff.removed.length || diff.orderChanged || diff.fields.length) {
    navStale();
    chatDataRender();
  }
  return diff;
}
function sidebarData() {
  if (projectionNeeded) projectionNeeded.add('sidebar');
  return sidebarSnapshot;
}
function sidebarOwner() {
  return sidebarOwnerValue;
}
// Sidebar search (the navFind popup, query CS.navQ): finds threads by title, id and project path;
// a feature number (f123) matches whole words and the board items tagged with it.
function sidebarMatch(t, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const title = t.title || '';
  if (!/^f\d+$/i.test(q)) return (title + ' ' + t.id + ' ' + t.projectPath).toLowerCase().includes(q);
  const board = chatDataSnapshot.project && chatDataSnapshot.project.board;
  return (
    new RegExp('\\b' + q + '\\b', 'i').test(title) ||
    (!!board &&
      board.items.some(function (item) {
        return (
          item.id === t.backlogItemId &&
          item.tags.some(function (tag) {
            return tag.toLowerCase() === q;
          })
        );
      }))
  );
}
function sidebarSubmit(m) {
  return Promise.resolve(
    chatPort.action('sidebarGroupWrite', {
      value: JSON.stringify({
        action: 'organize',
        threadIds: Object.keys(m.sel).filter(function (id) {
          return m.sel[id];
        }),
        expectedGroups: m.groups,
        ...(CS.f['org-to'] === 'new' ? { name: m.newName } : { groupId: CS.f['org-to'] }),
      }),
    }),
  ).then(function () {
    const ids = Object.keys(m.sel).filter(function (id) {
      return m.sel[id];
    });
    const group = sidebarOwner().preferences.groups.find(function (g) {
      return ids.every(function (id) {
        return g.threadIds.includes(id);
      });
    });
    CS.lastGid = group && group.id;
  });
}
async function sidebarModalOpen(d) {
  if (!sidebarOwner() && (await chatAction('sidebarRead')) === false) return;
  const groups = sidebarOwner().preferences.groups;
  CS.modal = {
    kind: d.v,
    id: d.id,
    gid: d.gid,
    sel: {},
    cats: [],
    messageIds: [],
    groups: groups.map(function (g) {
      return { id: g.id, threadIds: g.threadIds.slice() };
    }),
  };
  if (d.id) CS.modal.sel[d.id] = true;
  if (CS.f['org-preset']) {
    CS.f['org-preset'].forEach(function (id) {
      CS.modal.sel[id] = true;
    });
    delete CS.f['org-preset'];
  }
  CS.f['org-to'] = d.gid || (groups[0] ? groups[0].id : '');
  CS.f['org-q'] = '';
  CS.f['org-name'] = '';
  CS.f['cl-q'] = '';
  render(true);
}
function bindSidebar() {
  const groupPrefs = store.get('sidebar-groups', {});
  const owner = sidebarOwner;
  const groupKeys = ['recent', 'pinned', 'project', 'favorites', 'system'];
  function baseNav() {
    const data = sidebarData(),
      visible = data.threads.filter(function (t) {
        return (
          !t.deletedAt &&
          (!CS.tag || (CS.tag === '__none' ? !t.labels || !t.labels.length : (t.labels || []).includes(CS.tag)))
        );
      }),
      tests = {
        pinned: function (t) {
          return t.pinned;
        },
        project: function (t) {
          return !t.systemKind && t.id !== 'default';
        },
        favorites: function (t) {
          return t.favorited;
        },
        system: function (t) {
          return t.systemKind;
        },
      },
      listed = tests[CS.group] ? visible.filter(tests[CS.group]) : visible,
      zone = data.timeZone,
      none = { empty: !listed.length };
    const row = function (t) {
      return {
        id: t.id,
        title: t.title,
        cur: t.id === data.threadId,
        pinned: !!t.pinned,
        fav: !!t.favorited,
        draft: chatDataSnapshot.chat.drafts[t.id],
        time: t.lastActiveAt,
        meta: [],
      };
    };
    if (CS.group !== 'project')
      return {
        ...none,
        sections: [
          {
            key: CS.group,
            head: { kind: 'sec', n: listed.length },
            rows: listed.map(row),
          },
        ],
      };
    const projects = new Map(),
      pins = new Set(data.projectPins),
      names = new Map(data.projectNames),
      open = CS.projOpen || (CS.projOpen = {});
    listed.forEach(function (t) {
      if (!projects.has(t.projectPath)) projects.set(t.projectPath, []);
      projects.get(t.projectPath).push(t);
      if (open[t.projectPath] === undefined) open[t.projectPath] = true;
    });
    return {
      ...none,
      sections: Array.from(projects)
        .sort(function (a, b) {
          return Number(pins.has(b[0])) - Number(pins.has(a[0]));
        })
        .map(function (entry) {
          const path = entry[0],
            list = entry[1],
            parts = path.replace(/[\\/]+$/, '').split(/[\\/]/),
            name =
              names.get(path) ||
              (path === 'default' ? '' : /^[a-z]:[\\/]+$/i.test(path) ? path : parts[parts.length - 1] || path);
          return {
            key: 'proj:' + path,
            collapsed: !open[path],
            rows: list.map(row),
            head: {
              kind: 'proj',
              id: path,
              path: path,
              name: name,
              fixed: pins.has(path),
              tip: path,
              open: open[path],
              n: list.length,
              add: { label: 'home' },
            },
          };
        }),
    };
  }
  function groups(o = owner()) {
    return o
      ? o.preferences.groups.map(function (g) {
          const p = groupPrefs[g.id] || {},
            anchor = 'group:' + g.id;
          return {
            id: g.id,
            name: g.name,
            ids: g.threadIds,
            open: p.open == null ? o.preferences.open[anchor] !== false : p.open,
            peek: p.peek == null ? (o.preferences.collapsedPeek || {})[anchor] !== false : p.peek,
            sort: p.sort || ((o.preferences.memberSort || {})[anchor] === 'running-first' ? 'running' : 'manual'),
          };
        })
      : [];
  }
  function labels() {
    const o = owner();
    return o
      ? o.labels.map(function (x) {
          return { id: x.id, name: x.name, tint: x.color };
        })
      : [];
  }
  function grouped(id) {
    return groups().find(function (g) {
      return g.ids.indexOf(id) >= 0;
    });
  }
  function command(value) {
    return chatPort.action('sidebarGroupWrite', { value: JSON.stringify(value) });
  }
  ENT.thread.inline = 'row-rename';
  A.renameCommit = function (d, el) {
    const r = S.renaming;
    if (r) return A.rename({ entity: r.entity, id: r.id, v: el.value });
  };
  FORMS.cafeRowRename = function () {
    const r = S.renaming;
    if (r) return A.rename({ entity: r.entity, id: r.id, v: val('row-rename') });
  };
  VM.navThreads = function () {
    const data = sidebarData();
    if (data.load) return { load: data.load };
    const model = Object.assign({}, baseNav(), { group: CS.group, route: S.route, tag: CS.tag }),
      o = owner();
    if (CS.group !== 'recent' || !o) return model;
    const groupRows = groups(o),
      groupedIds = new Set(
        groupRows.flatMap(function (g) {
          return g.ids;
        }),
      ),
      runningIds = new Set(o.runningThreadIds),
      threadsById = new Map(
        data.threads.map(function (t) {
          return [t.id, t];
        }),
      );
    const rows = model.sections.reduce(function (all, section) {
      return all.concat(section.rows);
    }, []);
    const rowsById = new Map(
      rows.map(function (r) {
        return [r.id, r];
      }),
    );
    const pinned = rows.filter(function (r) {
      return r.pinned && !groupedIds.has(r.id);
    });
    const sections = pinned.length ? [{ key: 'pinned', head: { kind: 'sec', n: pinned.length }, rows: pinned }] : [];
    groupRows.forEach(function (g) {
      let list = g.ids
        .map(function (id) {
          return rowsById.get(id);
        })
        .filter(Boolean);
      const thread = function (id) {
        return threadsById.get(id);
      };
      const running = function (id) {
        return runningIds.has(id);
      };
      if (g.sort === 'recent')
        list.sort(function (a, b) {
          return thread(b.id).lastActiveAt - thread(a.id).lastActiveAt;
        });
      if (g.sort === 'running')
        list.sort(function (a, b) {
          return Number(running(b.id)) - Number(running(a.id));
        });
      if (list.length)
        sections.push({
          key: 'grp:' + g.id,
          gid: g.id,
          collapsed: !g.open,
          rows: list,
          peek: g.peek
            ? list.filter(function (r) {
                return !!r.badge || running(r.id);
              })
            : [],
          head: { kind: 'group', id: g.id, name: g.name, n: list.length, open: g.open },
        });
    });
    const recent = rows.filter(function (r) {
      return !r.pinned && !groupedIds.has(r.id);
    });
    sections.push({
      key: 'recent',
      head: { kind: 'sec', n: recent.length },
      rows: recent,
    });
    return Object.assign({}, model, { sections: sections });
  };
  VM.cafeNavShell = function () {
    const tag = labels().find(function (x) {
      return x.id === CS.tag;
    });
    return {
      findOpen: !!CS.navFind,
      tagName: tag ? tag.name : '',
      tag: CS.tag,
      route: S.route,
      group: CS.group,
      counts: Object.fromEntries(
        groupKeys.map(function (k) {
          return [
            k,
            sidebarData().threads.filter(function (t) {
              return (
                !t.deletedAt &&
                (k === 'pinned'
                  ? t.pinned
                  : k === 'favorites'
                    ? t.favorited
                    : k === 'system'
                      ? t.systemKind
                      : !t.systemKind)
              );
            }).length,
          ];
        }),
      ),
      noTag: !CS.tag,
      hasTag: !!CS.tag,
      untaggedOn: CS.tag === '__none',
      untagged: sidebarData().threads.filter(function (t) {
        return !t.labels || !t.labels.length;
      }).length,
      tags: labels().map(function (t) {
        return {
          id: t.id,
          name: t.name,
          n: sidebarData().threads.filter(function (r) {
            return (r.labels || []).includes(t.id);
          }).length,
          on: CS.tag === t.id,
        };
      }),
      unread: owner() ? owner().unread : 0,
      unclassified: sidebarData().threads.filter(function (t) {
        return !t.deletedAt && !t.systemKind && !(t.labels || []).length;
      }).length,
      classifying: owner() && owner().classification.phase === 'generating',
      byProject: CS.group === 'project',
      hidden: CS.navHidden,
      trash: '',
    };
  };

  A.cafeOrgView = function () {
    undoDrop();
    const group = groups().find(function (g) {
      return g.id === CS.lastGid;
    });
    if (group) {
      (groupPrefs[group.id] || (groupPrefs[group.id] = {})).open = true;
      CS.group = 'recent';
      navStale();
      render(true);
      locateNode('gid', group.id, { at: 'start', ring: false });
    }
  };
  A.cafeSearchOrg = function () {
    CS.f['org-preset'] = sidebarData()
      .threads.filter(function (t) {
        return !t.deletedAt && !t.systemKind && sidebarMatch(t, CS.navQ);
      })
      .map(function (t) {
        return t.id;
      });
    return sidebarModalOpen({ v: 'org' });
  };
  // a thread dragged into a group (to = group id) or out of its group (to = ''); groups keep time order
  A.cafeThreadMove = function (d) {
    const from = grouped(d.id),
      o = owner();
    if (d.to) {
      if (from && from.id === d.to) return;
      return command({
        action: 'organize',
        threadIds: [d.id],
        groupId: d.to,
        expectedGroups: o.preferences.groups.map(function (g) {
          return { id: g.id, threadIds: g.threadIds.slice() };
        }),
      });
    }
    if (from) return command({ action: 'remove', groupId: from.id, threadId: d.id });
  };
  // 🔍 opens / closes the search popup; ⌘K only opens it (stay; no trigger, so it anchors on 🔍); each opening starts empty
  A.searchOpen = function (d) {
    if (CS.navFind && !(d && d.stay)) {
      CS.navFind = false;
      render(true);
      return;
    }
    if (!CS.navFind) CS.navQ = '';
    CS.navHidden = false;
    if (window.innerWidth <= 960) S.navOpen = true;
    if (space() !== 'cafe') go('chat');
    CS.navFind = true;
    if (d && d.stay) {
      render(true);
      popAnchorAt('navFind', '.nav-head [data-act="searchOpen"]');
    }
    render(true);
    focusField('nav-q');
  };
  VM.navFind = function () {
    const q = (CS.navQ || '').trim(),
      hits = q
        ? sidebarData().threads.filter(function (t) {
            return !t.deletedAt && !t.systemKind && sidebarMatch(t, q);
          })
        : [];
    return {
      q: CS.navQ || '',
      matches: hits.length,
      items: hits.map(function (t) {
        return { id: t.id, title: t.title, time: t.lastActiveAt, projectPath: t.projectPath };
      }),
    };
  };
  INPUTS.navQ = function (e) {
    CS.navQ = e.target.value;
    render(true);
  };
  A.locate = function () {
    const t = sidebarData().threads.find(function (t) {
      return t.id === sidebarData().threadId;
    });
    if (!t) return;
    const g = grouped(t.id);
    if (g) (groupPrefs[g.id] || (groupPrefs[g.id] = {})).open = true;
    if (CS.group === 'project') CS.projOpen[t.projectPath] = true;
    if (CS.tag && (CS.tag === '__none' ? (t.labels || []).length : !(t.labels || []).includes(CS.tag))) CS.tag = null;
    if (
      (CS.group === 'pinned' && !t.pinned) ||
      (CS.group === 'favorites' && !t.favorited) ||
      (CS.group === 'system' && !t.systemKind)
    )
      CS.group = 'recent';
    if (window.innerWidth <= 960) S.navOpen = true;
    navStale();
    render(true);
    locateNode('tid', t.id);
  };
  ENT.group = {
    coll: groups,
    title: function () {
      return { kind: 'cafeGroupRename' };
    },
    rename: function (g, name) {
      return command({ action: 'rename', groupId: g.id, name: name }).then(function () {
        render(true);
      });
    },
    set: function (g, key, value) {
      const p = groupPrefs[g.id] || (groupPrefs[g.id] = {});
      p[key] = value;
      store.set('sidebar-groups', groupPrefs);
    },
    remove: async function (g) {
      for (const id of g.ids.slice(0, -1)) await command({ action: 'remove', groupId: g.id, threadId: id });
      render(true);
    },
  };
  ENT.grouped = {
    get: function (id) {
      return { id: id };
    },
    undo: ['remove'],
    undoText: function () {
      return tc('chat.group.remove.toast');
    },
    remove: async function (x) {
      await command({ action: 'remove', groupId: grouped(x.id).id, threadId: x.id });
      const receipt = owner().preferences.undo;
      return function () {
        return command(Object.assign({ action: 'undo' }, receipt));
      };
    },
  };

  A.sidebarReveal = function (d) {
    return chatAction('sidebarReveal', d);
  };
  ENT.proj.undo = ['false', 'remove'];
  ENT.proj.remove = async function (project) {
    const ids = sidebarData()
      .threads.filter(function (t) {
        return (
          t.projectPath === project.id && t.id !== 'default' && !t.systemKind && !t.connectorHubState && !t.deletedAt
        );
      })
      .map(function (t) {
        return t.id;
      });
    await chatPort.action('sidebarArchive', { id: project.id });
    if (ids.indexOf(chatPort.threadId) >= 0) await chatPort.action('thread', { id: 'default' });
    return function () {
      return chatPort.action('sidebarRestore', { value: JSON.stringify(ids) });
    };
  };
  let homeRequest = null;
  A.homeOpen = function (d) {
    homeRequest = { id: d.id === '__none' ? '' : d.id || '' };
    go('home');
  };
  onRender(function () {
    if (homeRequest && chatPort.threadId === 'default' && !chatRead('chatComposer').locked) {
      const intent = homeRequest;
      homeRequest = null;
      chatAction('newProject', intent);
    }
  });

  ENT.tag = {
    coll: labels,
    add: function (values) {
      return chatAction('sidebarLabelCreate', { name: values.v, color: val('tag-tint') });
    },
    confirm: function (x) {
      return { kind: 'tagDelete', args: { name: x.name } };
    },
    remove: function (x) {
      return chatPort.action('sidebarLabelDelete', { id: x.id }).then(function () {
        if (CS.tag === x.id) CS.tag = null;
      });
    },
  };

  A.cafeOrgNew = function (d) {
    const m = CS.modal;
    if (d.op === 'drop' && d.id && d.id !== 'new') return A.remove({ entity: 'group', id: d.id });
    if (d.op === 'set') {
      m.newName = d.v.trim();
      CS.f['org-to'] = 'new';
    } else {
      m.newName = null;
      CS.f['org-to'] = '';
    }
    render(true);
  };
  MODALS.tags = function () {
    return {
      vm: {
        tags: labels().map(function (l) {
          return {
            id: l.id,
            name: l.name,
            tint: l.color,
            n: sidebarData().threads.filter(function (t) {
              return (t.labels || []).includes(l.id);
            }).length,
          };
        }),
        tint: CS.f['tag-tint'],
      },
    };
  };
  MODALS.classify = function () {
    const q = (CS.f['cl-q'] || '').toLowerCase(),
      all = sidebarData().threads.filter(function (t) {
        return t.id !== 'default' && !t.deletedAt && !t.systemKind;
      }),
      state = owner().classification;
    return {
      vm: {
        un: all.filter(function (t) {
          return !(t.labels || []).length;
        }).length,
        q: CS.f['cl-q'],
        tint: CS.f['tag-tint'],
        tags: labels().map(function (l) {
          return { id: l.id, name: l.name, tint: l.color };
        }),
        phase: state.phase,
        load: state.phase === 'generating' ? 'loading' : state.error ? 'error' : '',
        error: state.error,
        suggestions: state.suggestions
          .filter(function (r) {
            return (
              !q ||
              all
                .find(function (t) {
                  return t.id === r.threadId;
                })
                .title.toLowerCase()
                .includes(q)
            );
          })
          .map(function (r) {
            return {
              id: r.threadId,
              ids: [r.threadId],
              title: all.find(function (t) {
                return t.id === r.threadId;
              }).title,
              accepted: r.accepted,
              labels: r.labels.map(function (id) {
                return {
                  label: id.startsWith('pending:')
                    ? id.slice(8)
                    : labels().find(function (l) {
                        return l.id === id;
                      }).name,
                  isNew: id.startsWith('pending:'),
                };
              }),
            };
          }),
        threads: all
          .filter(function (t) {
            return !q || (t.title + ' ' + t.id + ' ' + t.projectPath).toLowerCase().includes(q);
          })
          .map(function (t) {
            return {
              id: t.id,
              title: t.title,
              projectPath: t.projectPath,
              tags: labels().map(function (l) {
                return { threadId: t.id, id: l.id, name: l.name, on: (t.labels || []).includes(l.id) };
              }),
            };
          }),
      },
    };
  };
  MODALS.org = function (m) {
    const all = sidebarData().threads.filter(function (t) {
        return t.id !== 'default' && !t.deletedAt && !t.systemKind;
      }),
      opts = (m.newName ? [{ v: 'new', label: m.newName, pending: true }] : []).concat(
        groups().map(function (g) {
          return { v: g.id, label: g.name, pending: false };
        }),
      );
    if (
      CS.f['org-to'] &&
      !opts.some(function (o) {
        return o.v === CS.f['org-to'];
      })
    )
      CS.f['org-to'] = opts.length ? opts[0].v : '';
    const to = CS.f['org-to'],
      n = Object.keys(m.sel).filter(function (id) {
        return m.sel[id];
      }).length,
      q = (CS.f['org-q'] || '').toLowerCase();
    return {
      vm: {
        n: n,
        opts: opts,
        to: to,
        q: CS.f['org-q'],
        free: all
          .filter(function (t) {
            return !grouped(t.id);
          })
          .map(function (t) {
            return t.id;
          })
          .join(','),
        threads: all
          .filter(function (t) {
            return !q || t.title.toLowerCase().includes(q);
          })
          .map(function (t) {
            const g = grouped(t.id);
            return { id: t.id, title: t.title, group: g ? g.name : '', selected: !!m.sel[t.id] };
          }),
      },
      submitDisabled: !to || n < (to === 'new' ? 2 : 1),
      submit: sidebarSubmit,
    };
  };
  const tagDrafts = {};
  STATE_ROOTS.tid = function () {
    sidebarData().threads.forEach(function (t) {
      if (tagDrafts[t.id] && tagDrafts[t.id].source === t.labels) return;
      tagDrafts[t.id] = {
        source: t.labels,
        tags: Object.fromEntries(
          (t.labels || []).map(function (id) {
            return [id, true];
          }),
        ),
      };
    });
    return tagDrafts;
  };
  SET_AFTER['tid.{t}.tags'] = function (_, d) {
    return chatAction('sidebarLabels', {
      id: d.t,
      value: JSON.stringify(
        Object.keys(tagDrafts[d.t].tags).filter(function (id) {
          return tagDrafts[d.t].tags[id];
        }),
      ),
    });
  };
  A.sidebarTagPick = function (d) {
    const t = sidebarData().threads.find(function (x) {
        return x.id === d.id;
      }),
      ids = (t.labels || []).slice(),
      i = ids.indexOf(d.tag);
    if (i >= 0) ids.splice(i, 1);
    else ids.push(d.tag);
    return chatAction('sidebarLabels', { id: t.id, value: JSON.stringify(ids) });
  };
  ['clSuggest', 'clAccept', 'clDismiss'].forEach(function (name) {
    A[name] = function (d) {
      return chatAction(name, Object.assign({}, d, { ids: d.ids ? JSON.stringify(d.ids) : '' }));
    };
  });
  A.cafeAutoClassify = async function () {
    await sidebarModalOpen({ v: 'classify' });
    return A.clSuggest({});
  };
  const live = INPUTS.cafeLive;
  INPUTS.cafeLive = function (e) {
    if (['org-q', 'cl-q', 'hs-q'].indexOf(e.target.id) >= 0) {
      CS.f[e.target.id] = e.target.value;
      render(true);
    } else return live(e);
  };
  CHANGES.cafeSel = function (e) {
    CS.f[e.target.id] = e.target.value;
    render(true);
  };
}
