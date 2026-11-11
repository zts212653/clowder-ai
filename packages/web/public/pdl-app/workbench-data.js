/* Workspace owners project only the snapshots accepted by the console. */
'use strict';

function fileInfoVM(file) {
  return {
    mime: file.mime,
    size: file.size,
    modifiedAt: file.modifiedAt,
    pageCount: file.pageCount,
    pageUnit: file.pageUnit,
  };
}
function recallSourceArgs(item) {
  const href = item.sourceHref;
  if (item.sourceUnavailableReason || !href || !href.startsWith('/') || href.startsWith('//')) return null;
  const url = new URL(href, 'https://pdl.invalid');
  const thread = /^\/thread\/([^/]+)$/.exec(url.pathname);
  if (thread) {
    const id = decodeURIComponent(thread[1]),
      mid = url.searchParams.get('message');
    return mid ? { act: 'msgJump', thread: id, mid } : { act: 'threadOpen', id };
  }
  const family = url.searchParams.get('family'),
    id = url.searchParams.get('memoryId'),
    revision = url.searchParams.get('revision');
  if (url.pathname === '/memory' && family === 'profile' && id && revision) return { family, id, revision };
  if (
    url.pathname === '/memory/search' &&
    item.anchor &&
    url.searchParams.get('q') === item.anchor &&
    item.documentSource
  )
    return { family: 'document', id: url.searchParams.get('q') };
  return null;
}
function recallItems(events, threadId) {
  return events.flatMap(function (event) {
    const mid = event.reply ? event.reply.id : event.messageId,
      reply = mid ? { mid: mid, thread: threadId } : null;
    return (event.results && event.results.length ? event.results : [null]).map(function (result, i) {
      const source = result ? recallSourceArgs(result) : null,
        document = source && source.family === 'document';
      return {
        key: result ? event.id + ':' + i : event.id,
        title: result ? result.title : event.query,
        sub: result && !result.sourceUnavailableReason ? result.snippet : '',
        source: event.source,
        tool: event.toolName,
        date: event.timestamp,
        act: document ? 'recallSource' : source ? source.act || 'memOpen' : '',
        args: document ? { anchor: source.id } : source,
        ctx: { source: source, reply: reply },
      };
    });
  });
}
function recallGroups(events, data) {
  const groups = new Map();
  events
    .slice()
    .sort(function (a, b) {
      return b.timestamp - a.timestamp;
    })
    .forEach(function (event) {
      const mid = event.reply ? event.reply.id : event.messageId,
        key = mid || 'unlocated',
        cat = data.cats.find(function (c) {
          return c.id === event.catId;
        });
      let group = groups.get(key);
      if (!group) {
        group = {
          key: key,
          reply: !!mid,
          who: {
            id: event.catId,
            name: cat ? cat.nickname || cat.displayName : event.catId,
            handle: cat ? cat.mentionPatterns[0] : '',
          },
          count: 0,
          at: event.reply ? event.reply.timestamp : event.replyTimestamp || event.timestamp,
          eventAt: event.timestamp,
          items: [],
        };
        groups.set(key, group);
      }
      const results = recallItems([event], data.threadId);
      group.items.push({
        key: event.id,
        title: event.query,
        source: event.source,
        tool: event.toolName,
        graph: event.toolName === 'cat_cafe_graph_resolve',
        push: event.source === 'push',
        date: event.timestamp,
        results: results,
        canLocate: !!mid,
        mid: mid,
        thread: data.threadId,
        ctx: results[0].ctx,
      });
      if (mid) group.count = group.items.length;
    });
  return Array.from(groups.values()).sort(function (a, b) {
    return b.at - a.at;
  });
}
function fileTree(nodes, out = {}, parent = '') {
  out[parent] = nodes.map((node) => ({
    name: node.name,
    path: node.type === 'directory' ? `${node.path}/` : node.path,
    dir: node.type === 'directory',
    slot: 'ws.files.file',
    actsCtx: { path: node.path, quote: `\`${node.path}\``, dir: node.type === 'directory' },
  }));
  for (const node of nodes) if (node.children) fileTree(node.children, out, `${node.path}/`);
  return out;
}
function taskView(task) {
  const cats = projectChatData().cats,
    owner = cats.find(function (c) {
      return c.id === task.ownerCatId;
    }),
    creator = cats.find(function (c) {
      return c.id === task.createdBy;
    });
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    nextStatus: { todo: 'doing', doing: 'done', blocked: 'doing', done: 'todo' }[task.status],
    kind: task.kind,
    hasKindSubject: !!task.subjectKey,
    kindSubject: task.subjectKey,
    owner: task.ownerCatId,
    hasOwner: !!task.ownerCatId,
    ownerName: owner ? owner.displayName : task.ownerCatId,
    ownerHandle: owner ? owner.mentionPatterns[0] : '',
    updatedAt: task.updatedAt,
    updatedTimestamp: typeof task.updatedAt === 'number',
    why: task.why,
    createdBy: task.createdBy,
    creatorName: creator ? creator.displayName : task.createdBy,
    createdAt: task.createdAt,
    createdTimestamp: typeof task.createdAt === 'number',
    feature: task.relatedFeatureId,
    features: task.detectedFeatureIds,
    subject: task.subjectKey,
    thread: task.threadId,
    source: task.sourceMessageId,
    actsCtx: { thread: task.threadId, msg: task.sourceMessageId },
  };
}
function workbenchModels() {
  const source = projectData('workbench'),
    ui = S.ws;
  return {
    get fileDraftDirty() {
      return Object.values(source.fileEdits).some((draft) => draft.content !== draft.original);
    },
    workbenchState: ui,
    get worktrees() {
      return source.workspace.worktrees;
    },
    get tasks() {
      const { tasks } = source;
      if (source.taskError) throw source.taskError;
      const taskOrder = ['doing', 'blocked', 'todo', 'done'];
      const shown = (tasks ?? [])
        .filter((t) => ui.tkF === 'all' || t.status === ui.tkF)
        .sort((a, b) => taskOrder.indexOf(a.status) - taskOrder.indexOf(b.status));

      return {
        load: tasks === null ? 'loading' : '',
        filter: ui.tkF,
        counts: Object.fromEntries(
          ['all', 'doing', 'blocked', 'todo', 'done'].map((v) => [
            v,
            (tasks ?? []).filter((t) => v === 'all' || t.status === v).length,
          ]),
        ),
        hasTasks: !!tasks && !!tasks.length,
        items: shown.map(taskView),
      };
    },
    get files() {
      const { workspace, fileSearch } = source;
      const wt = workspace.worktrees.find((w) => w.id === workspace.worktreeId),
        picker = wt ? { root: wt.root, branch: wt.branch, head: wt.head, worktrees: workspace.worktrees } : null;
      return {
        load: workspace.error || fileSearch.error ? 'error' : workspace.loading || fileSearch.loading ? 'loading' : '',
        wt: picker,
        q: ui.q,
        searching: !!ui.q,
        tree: fileTree(workspace.tree),
        found: fileSearch.results.map((r) => ({
          path: r.path,
          kind: 'file',
          text: r.content,
          contentHit: r.matchType !== 'filename',
          line: r.line,
        })),
        mode: ui.qMode,
      };
    },
    get filePage() {
      const { opened, fileInfo, fileEdits, editing } = source,
        fileScope = JSON.stringify([opened?.worktreeId, opened?.file.path]),
        info = fileInfo.scope === fileScope ? fileInfo : undefined;
      const file = opened?.file;
      const markdown = !!file && !file.binary && /\.(md|markdown)$/i.test(file.path);
      const draft = fileEdits[fileScope];
      const isEditing = editing.editMode && editing.isTokenValid && !!draft;
      const rendered = !isEditing && markdown && ui.fileMode !== 'src';
      const mediaKind = file?.binary
        ? ['image', 'video', 'audio'].find((kind) => file.mime.startsWith(`${kind}/`))
        : undefined;
      const fileParams = opened ? new URLSearchParams({ worktreeId: opened.worktreeId, path: opened.file.path }) : null;
      const filePage = file
        ? {
            path: file.absolutePath ?? file.path,
            name: file.path.split('/').pop(),
            filePath: file.path,
            worktreeId: opened?.worktreeId,
            canEdit: editing.canEdit,
            editing: isEditing,
            edit: draft ? { ...draft, inputId: 'file-edit-' + fileScope, conflict: editing.saveError ?? '' } : null,
            body: file.content,
            markdown,
            mode: rendered ? 'render' : 'src',
            binary: file.binary,
            hasBody: !file.binary,
            quote: !file.binary,
            media: mediaKind
              ? {
                  id: `file:${file.absolutePath ?? `${opened.worktreeId}:${file.path}`}`,
                  kind: mediaKind,
                  src: api.file('/api/workspace/file/raw?' + fileParams),
                  label: file.path.split('/').pop(),
                  marks: [],
                }
              : null,
            fileInfo: file.binary && !mediaKind ? fileInfoVM(file) : null,
            actions: {
              load: info?.load ?? 'loading',
              name: file.path.split('/').pop(),
              canDownload: true,
              source: api.file('/api/workspace/file/download?' + fileParams),
              canOpen: !!info?.info?.local && !!info.info.canOpen,
              canReveal: !!info?.info?.local && !!info.info.canReveal,
              defaultApplication: info?.info?.defaultApplication,
            },
          }
        : null;

      return filePage;
    },
    get git() {
      const { workspace, git, native, patch } = source;
      const wt = workspace.worktrees.find((w) => w.id === workspace.worktreeId),
        picker = wt ? { root: wt.root, branch: wt.branch, head: wt.head, worktrees: workspace.worktrees } : null;
      const g = git.id === workspace.worktreeId ? git.data : undefined,
        drift = g ? g.health.runtimeDrift : null;
      const fileRow = (f) => ({
        path: f.path,
        name: f.path.split('/').pop(),
        status: f.status,
        sub: [{ text: f.path, mono: true }],
        slot: 'ws.changes.file',
        diff: {
          mode: ui.diffMode,
          hunks:
            patch?.id === workspace.worktreeId
              ? patch.parsed
                  .filter((file) => file.path === f.path)
                  .flatMap((file) =>
                    file.hunks.map((hunk) => [
                      hunk.header,
                      hunk.lines
                        .filter((line) => line.type !== 'header')
                        .map((line) => [line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ', line.content]),
                    ]),
                  )
              : [],
        },
        actsCtx: { path: f.path, deleted: f.status === 'D' },
      });

      return {
        load: ui.reviewOpen ? native.load || git.load : git.load,
        prChanges: ui.prTarget ? prChangesVM(ui.prTarget) : null,
        nativeTargets: native.nativeTargets,
        reviewOpen: ui.reviewOpen,
        review: {
          target: ui.review.target,
          mode: ui.review.mode,
          baseVal: ui.review.base,
          shaVal: ui.review.sha,
          askVal: ui.review.ask,
        },
        reviews: native.reviews.slice(0, 5).map(function (r) {
          return {
            id: r.id,
            state: r.status,
            target: { uncommitted: 'uncommitted', base_branch: 'base', commit: 'sha', custom: 'ask' }[r.target.kind],
            targetValue:
              r.target.kind === 'base_branch'
                ? r.target.branch
                : r.target.kind === 'commit'
                  ? r.target.sha
                  : r.target.kind === 'custom'
                    ? r.target.instructions
                    : '',
            mode: r.delivery === 'inline' ? 'session' : 'thread',
            summary: r.result ? r.result.summary : r.items.length ? r.items[r.items.length - 1].text : '',
            at: r.updatedAt,
            timestamp: typeof r.updatedAt === 'number',
          };
        }),
        wt: picker,
        branch: wt?.branch,
        drift: drift
          ? {
              available: drift.available,
              ahead: drift.aheadOfMain,
              behind: drift.behindMain,
              mainHead: drift.mainHead,
              runtimeHead: drift.runtimeHead,
            }
          : null,
        view: ui.gitView,
        diffMode: ui.diffMode,
        count: g ? g.status.staged.length + g.status.unstaged.length + g.status.untracked.length : 0,
        commitCount: g ? g.log.commits.length : 0,
        groups: g
          ? [
              ['staged', g.status.staged],
              ['unstaged', g.status.unstaged],
              ['untracked', g.status.untracked],
            ].map(([kind, files]) => ({ id: kind, label: kind, count: files.length, items: files.map(fileRow) }))
          : [],
        commits: g?.log.commits.map((c) => ({
          ...c,
          short: c.short || c.hash,
          authorName: c.author,
          files: c.files,
          actsCtx: { short: c.hash },
        })),
        wts: g?.health.worktrees.map((w) => ({
          ...w,
          orphan: w.isOrphan,
        })),
        behind: drift ? drift.behindCommits.map((c) => ({ id: c.short, title: c.subject })) : [],
        stale: g?.health.staleBranches.map((b) => ({ ...b, branch: b.name, date: b.lastCommitDate })),
      };
    },
    get exec() {
      return executionModel(ui.execQ);
    },
    get cafeWsRecall() {
      return recallModel();
    },
  };
}

function executionRun(run) {
  return {
    key: run.invocationId,
    who: run.catId,
    status: run.status,
    messages: run.keyMessages,
    statusEvents: run.statusEvents,
    preview: run.firstAssistantOutputEvidence,
    tools: run.toolUseCount,
    errors: run.errorCount,
    dur: run.durationMs / 1000,
    at: run.startedAt,
    invocationId: run.invocationId,
  };
}
function executionEvent(row) {
  return Object.assign({}, row, {
    key: row.id,
    ts: row.timestamp,
    ms: row.kind === 'tool' ? row.durationMs : undefined,
  });
}
function executionModel(query) {
  const source = projectData('workbench').execution,
    data = projectChatData(),
    state = S.ws,
    { invocations, external, externalDetail, read, detail, search } = source;
  const rows = read.threadId === data.threadId ? read : { sessions: [], runs: [], load: 'loading' };
  const externalRows = external.threadId === data.threadId ? external : { sessions: [], load: 'loading' };
  const cats = [
    ...new Set([
      ...rows.sessions.map((s) => s.catId),
      ...data.executions.filter((e) => e.threadId === data.threadId).map((e) => e.catId),
    ]),
  ];
  const members = cats.map(function (id) {
    const cat = data.cats.find(function (c) {
        return c.id === id;
      }),
      sessions = rows.sessions.filter(function (s) {
        return s.catId === id;
      }),
      cur = sessions.find(function (s) {
        return s.status === 'active';
      }),
      live = data.executions.find(function (e) {
        return e.threadId === data.threadId && e.catId === id;
      }),
      ctx = cur && cur.contextHealth,
      plan = invocations && invocations[id] && invocations[id].taskProgress;
    return {
      id: id,
      key: id,
      who: id,
      name: cat ? cat.displayName : id,
      handle: cat ? cat.mentionPatterns[0] : '',
      current: !!cur,
      running: !!live,
      hasSession: !!cur,
      sessionSeq: cur && cur.seq,
      sessionId: cur && cur.cliSessionId,
      session: cur
        ? { cli: cur.cliSessionId, compressed: cur.compressionCount > 0, ctxWarn: !!ctx && ctx.fillRatio >= 0.8 }
        : null,
      currentSession: cur
        ? {
            usage: cur.lastUsage
              ? { in: cur.lastUsage.inputTokens, out: cur.lastUsage.outputTokens, cost: cur.lastUsage.costUsd }
              : null,
            runtime: cur.runtimeSession
              ? { kind: cur.runtimeSession.runtime, life: cur.runtimeSession.lifecycleState }
              : null,
            created: cur.createdAt,
            createdTimestamp: typeof cur.createdAt === 'number',
            msgs: cur.messageCount,
            compress: cur.compressionCount,
          }
        : null,
      hasContext: !!ctx,
      context: ctx ? { used: ctx.usedTokens, ceiling: ctx.windowTokens, source: ctx.source } : null,
      contextPercent: ctx ? ctx.fillRatio * 100 : 0,
      contextWarn: !!ctx && ctx.fillRatio >= 0.8,
      run: { time: live ? (Date.now() - live.startedAt) / 1000 : 0, hasLast: false },
      sessions: sessions
        .slice()
        .sort(function (a, b) {
          return b.seq - a.seq;
        })
        .map(function (s) {
          return {
            key: s.id,
            seq: s.seq,
            sealed: s.status === 'sealed',
            state: s.status,
            reason: s.sealReason,
            sid: s.cliSessionId || s.id,
            at: s.sealedAt || s.createdAt,
            runsId: 'runs-' + s.id,
            runs: rows.runs
              .filter(function (r) {
                return r.sessionId === s.id;
              })
              .map(executionRun),
            canRestore: s.status === 'sealed' && !live,
          };
        }),
      runsId: 'sessions-' + id,
      plan: plan
        ? {
            doneCount: plan.tasks.filter(function (t) {
              return t.status === 'completed';
            }).length,
            count: plan.tasks.length,
            items: plan.tasks.map(function (t) {
              return { title: t.subject, done: t.status === 'completed', state: t.status };
            }),
          }
        : null,
    };
  });
  const browse = () => {
    const q = query.trim(),
      searched = search.threadId === data.threadId && search.query === q;
    return {
      load: rows.load || externalRows.load || (q ? (searched ? search.load : 'loading') : ''),
      external: externalRows.sessions.map((x) => ({
        id: x.sessionId,
        title: x.title || data.cats.find((c) => c.id === x.catId)?.displayName || x.catId,
        model: x.model,
        hasModel: !!x.model,
        state: x.lifecycle.state,
        active: x.lifecycle.state === 'active',
        trail: x.lastObservedAt,
        act: 'externalSession',
        args: { sessionId: x.sessionId },
      })),
      externalBrowsing: true,
      q: query,
      searched: !!q,
      browse: !q,
      hits:
        q && searched
          ? search.hits.map((hit) => {
              const run = rows.runs.find(
                  (r) => r.sessionId === hit.sessionId && r.invocationId === hit.pointer.invocationId,
                ),
                session = rows.sessions.find((s) => s.id === hit.sessionId);
              return {
                ...(run ? executionRun(run) : { who: session?.catId }),
                key: JSON.stringify([hit.sessionId, hit.pointer.eventNo, hit.pointer.invocationId]),
                preview: hit.snippet,
                args: hit.pointer.invocationId
                  ? { k: 'exec', v: hit.pointer.invocationId, sessionId: hit.sessionId }
                  : { sessionId: hit.sessionId, eventNo: String(hit.pointer.eventNo) },
              };
            })
          : [],
      now: members.filter((c) => c.current),
      past: members.filter((c) => !c.current),
    };
  };
  if (externalDetail) {
    const owner = externalRows.sessions.find((s) => s.sessionId === externalDetail.id);
    const session = rows.sessions.find((s) => s.id === externalDetail.id);
    return {
      ...browse(),
      externalDetail:
        owner || session
          ? {
              title: owner ? owner.title || owner.catId : session.catId,
              body: externalDetail.messages.map((x) => x.content).filter(Boolean),
              sessionId: externalDetail.id,
              more: !!externalDetail.nextCursor,
              model: owner && owner.model,
            }
          : null,
    };
  }
  if (detail) {
    const sub = detail.invocationId,
      summary = detail.summary,
      events = detail.timelineRows;
    return {
      ...browse(),
      load: rows.load,
      run: {
        id: sub,
        who: summary.catId,
        title: summary.keyMessages[0] ?? sub,
        seq: summary.sessionSeq,
        at: summary.startedAt,
        sealed: summary.status === 'sealed',
        name: summary.keyMessages[0],
        duration: summary.durationMs / 1000,
        input: summary.inputTokens,
        output: summary.outputTokens,
        hasInput: summary.inputTokens !== undefined,
        hasTokens: summary.inputTokens !== undefined || summary.outputTokens !== undefined,
        state: summary.status,
        mode: state.tjMode,
        rawRecords: detail.events,
        events: events.map(executionEvent),
      },
    };
  }
  return browse();
}
function recallModel() {
  const read = projectData('workbench').recall,
    data = projectChatData(),
    ui = S.ws,
    page = read.threadId === data.threadId ? read.page : null,
    events = read.events;
  const groups = recallGroups(events, data);
  const selected = ui.recallFor;
  return {
    load: read.threadId !== data.threadId ? 'loading' : read.load || (page?.readStatus === 'partial' ? 'stale' : ''),
    replyCount: selected
      ? Number(groups.some((group) => group.key === selected))
      : groups.filter((group) => group.key !== 'unlocated').length,
    filtered: !!selected,
    filterFor: selected,
    groups,
    events: { next: page?.nextCursor ?? null },
  };
}
function terminalModels() {
  const source = projectData('terminal'),
    workspace = projectData('workbench').workspace,
    cats = projectChatData().cats,
    ui = S.ws;
  if (!workspace.worktreeId) return { terminal: null };
  const mine = ui.pane === 'mine',
    pane = source.panes.find(function (p) {
      return p.paneId === ui.pane;
    }),
    wt = workspace.worktrees.find(function (w) {
      return w.id === workspace.worktreeId;
    }),
    output = mine ? source.mine : pane && source.outputs[pane.paneId],
    cat =
      pane &&
      cats.find(function (c) {
        return c.id === pane.catId;
      });
  return {
    terminal: {
      load: source.worktreeId === workspace.worktreeId ? source.load : 'loading',
      wt: wt ? { id: wt.id, root: wt.root, branch: wt.branch, head: wt.head, worktrees: workspace.worktrees } : null,
      mine: mine,
      ro: !mine,
      owner: cat ? cat.displayName : pane && pane.catId,
      cantReconnect: source.mine.status !== 'disconnected',
      cantClose: source.mine.status !== 'connected',
      panes: [{ k: 'mine', on: mine, mine: true, state: source.mine.status }].concat(
        source.panes.map(function (p) {
          const c = cats.find(function (c) {
            return c.id === p.catId;
          });
          return {
            k: p.paneId,
            on: ui.pane === p.paneId,
            cat: p.catId,
            name: c ? c.displayName : p.catId,
            handle: c && c.mentionPatterns[0],
            state: p.status,
          };
        }),
      ),
      screen: {
        id: output ? output.id : '',
        mine: mine,
        status: output ? output.status : 'disconnected',
        owner: cat ? cat.displayName : pane && pane.catId,
        output: output ? output.output : '',
        caret: mine
          ? output && output.status === 'connected'
            ? 'live'
            : null
          : pane && pane.status === 'running'
            ? 'idle'
            : null,
      },
      mineId: source.mine.id,
    },
  };
}
function homeModels() {
  const data = projectChatData(),
    source = projectData('home'),
    waits = source.waits,
    ui = S.ws,
    now = Date.now(),
    member = function (id) {
      const c = data.cats.find(function (c) {
        return c.id === id;
      });
      return { id: id, name: c ? c.displayName : id, handle: c ? c.mentionPatterns[0] : '' };
    },
    runs = data.executions.map(function (x) {
      const cmd = x.kind === 'managed_command';
      return {
        key: x.executionId,
        who: x.catId,
        command: cmd,
        activity: x.activity,
        carrier: x.carrier,
        thread: x.threadTitle || x.threadId,
        here: x.threadId === data.threadId,
        time: (now - x.startedAt) / 1000,
        actions: {
          id: x.executionId,
          inv: x.turnInvocationId,
          thread: x.threadId,
          cmd: cmd,
          name: member(x.catId).name,
          activity: x.activity,
          cancel: x.cancelability,
        },
      };
    }),
    items = (waits.projection ? waits.projection.items : [])
      .slice()
      .sort(function (a, b) {
        return (
          ['ready_to_return', 'unknown', 'waiting_for_update'].indexOf(a.state) -
          ['ready_to_return', 'unknown', 'waiting_for_update'].indexOf(b.state)
        );
      })
      .map(function (w) {
        const owner = member(w.ownerCatId);
        return {
          key: w.taskId,
          kind: 'deployment',
          state: w.state,
          title: w.taskTitle,
          condition: w.condition.kind,
          waited: w.createdAt === null ? null : ((w.matchedAt || now) - w.createdAt) / 1000,
          services: w.condition.services,
          revision: w.condition.kind === 'revision_included' ? w.condition.revision : '',
          ready: w.state === 'ready_to_return',
          owner: w.ownerCatId,
          hasOwner: !!w.ownerCatId,
          ownerName: owner.name,
          ownerHandle: owner.handle,
          actions: { thread: w.threadId },
          reason: w.stateReason,
          nextStep: w.nextStep,
        };
      }),
    held = source.heldWaits.map(function (w) {
      const owner = member(w.catId);
      return Object.assign({}, w, {
        key: w.waitId,
        kind: 'hold_ball',
        title: w.threadTitle,
        owner: w.catId,
        ownerName: owner.name,
        ownerHandle: owner.handle,
        hasOwner: true,
        actions: { thread: w.threadId, waitId: w.waitId, cancelable: w.cancelability.state === 'cancelable' },
      });
    }),
    candidate = waits.projection && waits.projection.candidate,
    detail = source.detail,
    read = detail.id === ui.execDetail ? detail.read : null,
    job = read && read.job,
    current = data.executions.find(function (x) {
      return x.executionId === ui.execDetail;
    }),
    activeLoad =
      source.hydration === 'error'
        ? 'error'
        : source.hydration !== 'ready'
          ? 'loading'
          : source.unavailable.length
            ? 'stale'
            : '';
  return {
    live: {
      execDetail: !!ui.execDetail,
      load: activeLoad || (waits.hydration === 'error' ? 'error' : waits.projection === null ? 'loading' : ''),
      count: runs.length,
      runs: runs,
      waits: {
        count: items.length + held.length,
        items: items.concat(held),
        candidate: candidate
          ? {
              rev: candidate.revision,
              observed: candidate.observedAt,
              satisfiable: candidate.satisfiableCount,
              unknown: candidate.unknownCount,
            }
          : null,
      },
    },
    execDetail: !ui.execDetail
      ? null
      : !job
        ? { load: detail.id === ui.execDetail ? detail.load : 'loading' }
        : {
            id: ui.execDetail,
            state: job.state,
            failed: ['failed', 'timed_out', 'lost'].includes(job.state),
            live: !!current,
            exitCode: job.result && job.result.exitCode,
            thread: source.selected && source.selected.threadTitle,
            threadId: source.selected && source.selected.threadId,
            command: job.command,
            elapsed: (job.result ? job.result.durationMs : now - job.createdAt) / 1000,
            cancelable: !!current && read.cancelable,
            tail: job.tail,
            trace: job.transitions.map(function (t) {
              return { key: t.revision, state: t.state, time: t.at / 1000 };
            }),
          },
  };
}
function recentWorksModels() {
  const read = projectData('recentWorks'),
    data = projectChatData(),
    projectId =
      data.threadId === 'default'
        ? data.newProjectId
        : data.threads.find(function (t) {
            return t.id === data.threadId;
          }).projectPath,
    owners = read.projectId === projectId && read.load === '' ? read.artifacts : [];
  return {
    recentWorkOwners: owners,
    recentWorks: {
      rw: !projectId
        ? { load: 'empty', works: { items: [] } }
        : read.projectId !== projectId
          ? { load: 'loading', works: { items: [] } }
          : {
              load: read.load,
              works: {
                items: read.artifacts.map(function (w, index) {
                  const c = data.cats.find(function (c) {
                    return c.id === w.catId;
                  });
                  return {
                    id: w.navigationId,
                    index: index,
                    args: { id: w.navigationId },
                    name: w.name,
                    type: w.type,
                    cat: w.catId,
                    catName: c ? c.displayName : w.catId,
                    catHandle: c ? c.mentionPatterns[0] : '',
                    threadTitle: w.threadTitle,
                    thread: w.threadId,
                    at: w.createdAt,
                  };
                }),
              },
            },
    },
  };
}
