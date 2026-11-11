/* GitHub 运营插件的 console 部分：社区面板。读写都走插件自己登记的接口（/api/plugins/<插件>/…，宿主只转发）。
   读取跟着投影：面板画出来时登记来源 github.community，来源出现时读一次；动作写完再读。 */
'use strict';
(function () {
  const key = 'github.community',
    base = '/api/plugins/official.github-operations/github/community-';
  function source() {
    return projectData(key);
  }
  function publish(next) {
    pushProjectData({ [key]: Object.assign({}, source(), next) });
  }
  async function read(repo) {
    publish({ load: 'loading' });
    try {
      const [r, f] = await Promise.all([
        api.get(base + 'repos'),
        api.get(base + 'findings', { status: 'open,acknowledged' }),
      ]);
      const held = source().value,
        selected = repo || (held && held.repo) || r.repos[0],
        [value, queue] = selected
          ? await Promise.all([
              api.get(base + 'board', { repo: selected }),
              api.get(base + 'decision-queue', { repo: selected }),
            ])
          : [null, { items: [] }];
      publish({ load: '', repos: r.repos, value: value, decisions: queue.items, findings: f.findings });
    } catch (error) {
      publish({ load: 'error' });
    }
  }
  function write(path, body, repo) {
    return api
      .post(base + path, {}, body)
      .then(function () {
        return read(repo);
      })
      .catch(function (error) {
        toast(error.message);
        return false;
      });
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf(key) >= 0) settleHold(read());
  });

  function issueState(state) {
    return { 'pending-decision': 'pendingDecision', declined: 'rejected' }[state] || state;
  }
  function issueOf(n) {
    return source().value.issues.find(function (i) {
      return String(i.issueNumber) === String(n);
    });
  }
  function threadTitle(id) {
    const thread = sidebarData().threads.find(function (t) {
      return t.id === id;
    });
    return thread ? thread.title : id;
  }
  function narrator(i) {
    return (
      i.directionCard &&
      i.directionCard.entries.find(function (e) {
        return e.authoredByRole === 'narrator';
      })
    );
  }

  VM.githubCommunity = function () {
    if (projectionNeeded) projectionNeeded.add(key);
    const held = source();
    if (!held || held.load) return { load: held ? held.load : 'loading' };
    if (!held.value) return { noRepo: true, repos: held.repos, list: null };
    const board = held.value,
      focused = NAV_CTX ? NAV_CTX.c : navFocusC(),
      stack = navTop(focused).f === key ? focused : navTabKey('panel', key),
      sub = navArg('sub', stack),
      cats = projectChatData().cats,
      identity = function (id) {
        const c = cats.find(function (c) {
          return c.id === id;
        });
        return { id: id, name: c ? c.nickname || c.displayName : id, handle: c ? c.mentionPatterns[0] : '' };
      };
    if (sub) {
      const issue = board.issues.find(function (i) {
        return 'i' + i.issueNumber === sub;
      });
      if (!issue) return { detail: { gone: true } };
      const cat = identity(issue.assignedCatId),
        entry = narrator(issue),
        detail = {
          n: issue.issueNumber,
          thread: issue.assignedThreadId,
          state: issueState(issue.state),
          ago: issue.updatedAt,
          title: issue.title,
          hasCat: !!issue.assignedCatId,
          catName: cat.name,
          catHandle: cat.handle,
          threadTitle: issue.assignedThreadName || threadTitle(issue.assignedThreadId),
        };
      if (entry && issue.state === 'pending-decision') {
        const route = entry.routeRecommendation;
        detail.dir = {
          reject: !!route && route.kind === 'decline',
          accept: !route || route.kind !== 'decline',
          questions: entry.questions.map(function (q) {
            return { label: q.id, value: q.result };
          }),
          evidence: entry.evidenceRefs,
          route: route && route.kind,
        };
      } else if (issue.closureChecklist) {
        const checklist = issue.closureChecklist;
        detail.closure = {
          pending: !!checklist.blockers.length && !checklist.waiverPresent,
          locked: true,
          rows: issue.closureWaiver
            ? [{ waived: true, text: issue.closureWaiver.reason }]
            : checklist.blockers.length
              ? checklist.blockers.map(function (b) {
                  return { blocker: true, text: b.detail };
                })
              : [{ ready: true }],
        };
      }
      return { detail: detail };
    }
    const fs = S.ws.cSt || 'all',
      fc = S.ws.cCat || 'all',
      ft = S.ws.cTime || 'all',
      selected = board.issues.filter(function (i) {
        return (
          (fs === 'all' || issueState(i.state) === fs) &&
          (fc === 'all' || i.assignedCatId === fc) &&
          (ft === 'all' || api.now() - i.updatedAt <= +ft * 86400000)
        );
      });
    return {
      repos: held.repos,
      list: {
        repo: board.repo,
        fs: fs,
        fc: fc,
        ft: ft,
        cats: Array.from(
          new Set(
            board.issues
              .map(function (i) {
                return i.assignedCatId;
              })
              .filter(Boolean),
          ),
        ).map(function (id) {
          return Object.assign({ v: id }, identity(id));
        }),
        issueCount: board.issues.length,
        prCount: board.prItems.length,
        syncing: !!held.syncing,
        issueGroups: ['unreplied', 'discussing', 'pending-decision', 'accepted', 'declined', 'closed'].map(
          function (state) {
            return {
              state: issueState(state),
              items: selected
                .filter(function (i) {
                  return i.state === state;
                })
                .map(function (i) {
                  const cat = identity(i.assignedCatId),
                    drill = !!((narrator(i) && i.state === 'pending-decision') || i.closureChecklist),
                    decision = held.decisions.find(function (d) {
                      return d.subjectType === 'issue' && d.number === i.issueNumber;
                    });
                  return {
                    id: i.issueNumber,
                    n: i.issueNumber,
                    title: i.title,
                    hasCat: !!i.assignedCatId,
                    catName: cat.name,
                    catHandle: cat.handle,
                    threadTitle: i.assignedThreadName || threadTitle(i.assignedThreadId),
                    ago: i.updatedAt,
                    unreplied: i.state === 'unreplied',
                    priority: decision && decision.priority,
                    normalPriority: !decision || decision.priority === 'normal',
                    drill: drill,
                    canOpen: drill || !!i.assignedThreadId,
                    thread: i.assignedThreadId,
                  };
                }),
            };
          },
        ),
        prGroups: ['unreplied', 'replied', 'has-new-activity', 'merged', 'closed'].map(function (state) {
          return {
            state: state,
            items: board.prItems
              .filter(function (p) {
                return p.group === state;
              })
              .map(function (p) {
                const r = p.externalReview,
                  cloud = r && r.cloud && r.cloud.headSha === r.currentHeadSha ? r.cloud : null,
                  ci = r && r.ci && r.ci.headSha === r.currentHeadSha ? r.ci : null;
                return {
                  n: p.prNumber,
                  title: p.title,
                  author: p.author,
                  catName: identity(p.ownerCatId).name,
                  ago: p.updatedAt,
                  life: r && r.lifecycle,
                  cloud: cloud && cloud.status,
                  cloudFail: !!cloud && ['blocking', 'failed_or_timeout'].includes(cloud.status),
                  ci: ci && ci.status,
                  ciFail: !!ci && ci.status === 'fail',
                  sent: r && r.lastDeliveredHeadSha,
                  thread: p.threadId,
                };
              }),
          };
        }),
        findings: held.findings
          .filter(function (f) {
            return (
              f.subjectKey.startsWith('issue:' + board.repo + '#') || f.subjectKey.startsWith('pr:' + board.repo + '#')
            );
          })
          .map(function (f) {
            return {
              i: f.findingId,
              msg: f.message,
              kind: f.findingKind,
              sev: f.severity,
              st: f.status,
              pending: ['open', 'acknowledged'].includes(f.status),
            };
          }),
      },
    };
  };

  ['wsCSt', 'wsCCat'].forEach(function (name, i) {
    CHANGES[name] = function (e) {
      S.ws[i ? 'cCat' : 'cSt'] = e.target.value;
      render(true);
    };
  });
  function issuePath(n) {
    return 'issues/' + encodeURIComponent(issueOf(n).id);
  }
  A.wsSendSys = function (d) {
    return write(issuePath(d.n) + '/dispatch', { threadId: S.thread });
  };
  A.wsRepoSync = function (d) {
    const repo = (d.v || val('ws-repo')).trim();
    publish({ syncing: true });
    return Promise.all([
      api.post(base + 'issues/sync', { repo: repo }, {}),
      api.post(base + 'issues/sync-prs', { repo: repo }, {}),
    ])
      .then(function () {
        return read(repo);
      })
      .catch(function (error) {
        toast(error.message);
      })
      .then(function () {
        publish({ syncing: false });
      });
  };
  A.wsReport = function (d) {
    const form = {
      kind: 'github.report',
      on: function () {
        if (dlgNeed(form, ['dlg-in'])) return false;
        return write(issuePath(d.n) + '/report', { publicCommentUrl: val('dlg-in') });
      },
    };
    dialog(form);
  };
  A.wsWaive = function (d) {
    const form = {
      kind: 'github.waive',
      on: function () {
        if (dlgNeed(form, ['dlg-r', 'dlg-e'])) return false;
        return write(issuePath(d.n) + '/waive-closure', { reason: val('dlg-r'), evidence: val('dlg-e') });
      },
    };
    dialog(form);
  };
  ENT.issue = {
    get: issueOf,
    status: 'state',
    set: function (issue, field, value) {
      const entry = narrator(issue);
      return write('issues/' + encodeURIComponent(issue.id) + '/resolve', {
        decision: { accepted: 'accepted', rejected: 'declined' }[value],
        routeRecommendation: entry && entry.routeRecommendation,
      });
    },
  };
  ENT.finding = {
    get: function (id) {
      return { id: id };
    },
    status: 'status',
    set: function (finding, field, value) {
      return write(
        'findings/' + encodeURIComponent(finding.id) + '/' + (value === 'confirmed' ? 'acknowledge' : 'resolve'),
        {},
      );
    },
  };

  // Issue draft cards (render type card.community_issue_draft): each card on screen is its own source
  // github.issueDraft:<message>:<block>; it is read once when it appears and every write pushes the plugin's receipt.
  const draftPath = '/api/plugins/official.github-operations/github/community-issue-drafts',
    draftCards = {};
  function draftKey(d) {
    return 'github.issueDraft:' + d.mid + ':' + d.b;
  }
  function draftField(d) {
    return 'issue-' + d.mid + '-' + d.b + '-';
  }
  function draftPublish(key, next) {
    pushProjectData({ [key]: Object.assign({}, projectData(key), next) });
  }
  function draftReceipt(draft) {
    return {
      draftId: draft.draftId || '',
      phase: draft.status === 'published' || draft.status === 'cancelled' ? draft.status : 'editing',
      title: draft.title,
      bodyMarkdown: draft.bodyMarkdown,
      targetRepo: draft.targetRepo,
      labels: draft.labels || [],
      url: draft.githubIssueUrl || '',
    };
  }
  function draftRead(key) {
    const block = draftCards[key],
      meta = block.meta;
    return Promise.all([
      api.get(draftPath + '/config'),
      meta.draftId ? api.get(draftPath + '/by-id/' + encodeURIComponent(meta.draftId)) : null,
    ]).then(
      function (r) {
        const saved = r[1] && r[1].draft;
        draftPublish(
          key,
          Object.assign(
            { load: '', repos: r[0].repos, error: '', busy: false, lastAction: '' },
            draftReceipt(
              saved || {
                title: meta.proposedTitle || '',
                bodyMarkdown: meta.proposedBody || '',
                targetRepo: meta.proposedRepo || r[0].defaultRepo,
                labels: meta.proposedLabels,
              },
            ),
          ),
        );
      },
      function (error) {
        draftPublish(key, { load: 'error', error: error.message, lastAction: 'read' });
      },
    );
  }
  api.on('sources:needed', function (diff) {
    diff.added.forEach(function (key) {
      if (draftCards[key]) settleHold(draftRead(key));
    });
  });
  VM.githubIssueDraft = function (rich) {
    const d = { mid: rich.mid, b: rich.block.id },
      key = draftKey(d),
      f = draftField(d);
    draftCards[key] = rich.block;
    if (projectionNeeded) projectionNeeded.add(key);
    const s = projectData(key) || { load: 'loading' };
    if (s.load)
      return { title: rich.title, args: d, state: s.load === 'loading' ? 'loading' : '', error: s.error, repos: [] };
    const editable = s.phase !== 'published' && s.phase !== 'cancelled' && !s.busy;
    return {
      title: rich.title,
      args: d,
      draftId: s.draftId,
      repoId: f + 'repo',
      titleId: f + 'title',
      bodyId: f + 'body',
      repos: s.repos,
      targetRepo: CS.f[f + 'repo'] != null && !s.draftId ? CS.f[f + 'repo'] : s.targetRepo,
      titleValue: CS.f[f + 'title'] != null ? CS.f[f + 'title'] : s.title,
      bodyMarkdown: CS.f[f + 'body'] != null ? CS.f[f + 'body'] : s.bodyMarkdown,
      canEdit: editable,
      canCreate: editable && !s.draftId,
      canPublish: editable && !!s.draftId,
      canCancel: editable,
      error: s.error,
      url: s.url,
      state: s.busy ? 'loading' : s.phase === 'editing' ? (s.draftId ? 'draft' : '') : s.phase,
    };
  };
  // Create, publish and cancel each write the plugin's route; a publish retry keeps the draftId the plugin returned
  function draftWrite(d, op) {
    const key = draftKey(d),
      s = projectData(key),
      f = draftField(d);
    if (s.busy) return false;
    if (op === 'cancel' && !s.draftId) {
      draftPublish(key, { phase: 'cancelled' });
      return true;
    }
    const title = CS.f[f + 'title'] != null ? CS.f[f + 'title'] : s.title,
      bodyMarkdown = CS.f[f + 'body'] != null ? CS.f[f + 'body'] : s.bodyMarkdown,
      targetRepo = !s.draftId && CS.f[f + 'repo'] != null ? CS.f[f + 'repo'] : s.targetRepo;
    if (op !== 'cancel') {
      if (!title.trim()) return fieldErr(f + 'title', tc('pcf.fill', tc('github.issueDraft.title')));
      if (!bodyMarkdown.trim()) return fieldErr(f + 'body', tc('pcf.fill', tc('github.issueDraft.body')));
    }
    draftPublish(key, {
      title: title,
      bodyMarkdown: bodyMarkdown,
      targetRepo: targetRepo,
      busy: true,
      error: '',
      lastAction: op,
    });
    const sent =
      op === 'create'
        ? api.post(
            draftPath,
            {},
            {
              sourceType: 'cat_initiated',
              sourceId: d.b,
              title: title,
              bodyMarkdown: bodyMarkdown,
              targetRepo: targetRepo,
              labels: s.labels,
              threadId: S.thread,
              messageId: d.mid,
            },
          )
        : api.post(
            draftPath + '/by-id/' + encodeURIComponent(s.draftId) + '/' + op,
            {},
            op === 'publish' ? { title: title, bodyMarkdown: bodyMarkdown } : {},
          );
    return sent.then(
      function (r) {
        draftPublish(key, Object.assign({ busy: false }, draftReceipt(r.draft)));
        return true;
      },
      function (error) {
        draftPublish(key, { busy: false, error: error.message });
        return false;
      },
    );
  }
  A.ghIssueDraftCreate = function (d) {
    return draftWrite(d, 'create');
  };
  A.ghIssueDraftPublish = function (d) {
    return draftWrite(d, 'publish');
  };
  A.ghIssueDraftCancel = function (d) {
    return draftWrite(d, 'cancel');
  };
  A.ghIssueDraftRetry = function (d) {
    const key = draftKey(d),
      op = projectData(key).lastAction;
    if (op !== 'read') return draftWrite(d, op);
    draftPublish(key, { load: 'loading' });
    return draftRead(key);
  };
})();
