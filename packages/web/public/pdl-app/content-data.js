/* Work content VMs project only the console's held source data. */
'use strict';
function canonModels() {
  const source = projectData('canon');
  const draft = S.ws.canon;
  const state = {
    current:
      source &&
      Object.assign({}, source, { reason: draft.reason, target: draft.target, bindingChoices: draft.bindingChoices }),
  };
  const s = state.current,
    a = s?.detail;
  if (!s) return { assetCanon: null, canonReference: null };
  const options = (s.page?.items ?? [])
      .filter((x) => x.record.indexedVersionRef !== a?.record.indexedVersionRef)
      .map((x) => ({ v: x.record.indexedVersionRef, label: x.record.name })),
    update = s.page?.updates?.find((x) => x.original.record.indexedVersionRef === a?.record.indexedVersionRef);
  return {
    canonReference: s.reference,
    assetCanon: {
      load: s.load,
      items: s.page?.items.map((x) => ({
        title: x.record.name,
        act: 'assetCanonRead',
        args: { indexedVersionRef: x.record.indexedVersionRef },
      })),
      hasMore: s.page?.nextAfter !== undefined,
      detail: a
        ? {
            indexedVersionRef: a.record.indexedVersionRef,
            title: a.record.name,
            canWrite: a.canWrite,
            status: a.record.status,
            reasonDraft: s.reason,
            replacement: { target: s.target, options },
            bindings: a.bindings.map((b) => ({
              id: b.bindingRef,
              label: b.slot.role,
              options: options,
              selected: s.bindingChoices[b.bindingRef] ?? '',
            })),
            history: s.history?.history.map((h) => ({ title: h.reason ?? h.record.name, sub: h.recordedAt })),
            moreHistory: s.history?.nextAfter !== undefined,
            update: update
              ? { reason: update.reason, canRequest: a.record.version.locator.kind === 'workspace' }
              : null,
          }
        : null,
    },
  };
}

function documentModels() {
  const source = projectData('document');
  const opened = projectData('workbench') && projectData('workbench').opened;
  const snapshot = source && source.snapshot;
  const current =
    snapshot &&
    opened &&
    snapshot.worktreeId === opened.worktreeId &&
    snapshot.file.path === opened.file.path &&
    snapshot.file.sha256 === opened.file.sha256
      ? snapshot
      : null;
  const selected = { current: source && source.selection };
  const quote = { current: source && source.quote };
  const s = current,
    v = s?.review.view,
    phase = s?.listen.active ? s.session?.phase : 'idle';
  return {
    documentSelection: selected.current,
    documentQuote: quote.current,
    documentSource: s
      ? { work: s.file.absolutePath ?? s.file.path, worktreeId: s.worktreeId, path: s.file.path }
      : null,
    documentReview: s
      ? {
          work: s.file.absolutePath ?? s.file.path,
          load: s.review.error ? 'error' : v ? '' : 'loading',
          retryKey: `document-review:${s.file.path}`,
          annotations: v?.review.annotations.map((a) => ({
            id: a.id,
            title: a.body,
            canReply: v.canReply ?? v.canWrite,
            canSetState: v.canWrite,
            resolved: a.state === 'resolved',
            replyId: `review-reply-${a.id}`,
            replies: (a.replies ?? []).map((r) => ({ title: r.body })),
          })),
          quotes: s.quotes.quotes.map((q) => ({
            title: q.attachment.text,
            sourceChanged: q.state !== 'current',
            act: 'msgJump',
            args: { t: q.threadId, mid: q.messageId },
          })),
          listen: {
            state: phase,
            canStart: phase === 'idle' || phase === 'error',
            canPause: phase === 'playing',
            canResume: phase === 'paused',
            sourceVersion: s.listen.active
              ? s.session?.identity.contentDigest
              : `sha256:${s.file.sha256.replace(/^sha256:/, '')}`,
            activeSentence: s.listen.active ? s.session?.sentences[s.session.currentIndex] : null,
          },
        }
      : null,
    documentAnnotations: [
      ...(v?.review.annotations ?? []).flatMap((a) =>
        'kind' in a.anchor && a.anchor.kind === 'text_quote' ? [{ quote: a.anchor.quote, label: a.body }] : [],
      ),
      ...(s?.listen.active && s.listen.activeAnchor
        ? [
            {
              quote: s.session?.sentences[s.session.currentIndex]?.text,
              label: s.session?.sentences[s.session.currentIndex]?.text,
            },
          ]
        : []),
    ],
  };
}

/* Works filter and time groups use the contract keys: codepr covers code and pr; days bucket by the viewer's calendar. */
function workMatch(w, f) {
  return f === 'all' || (f === 'codepr' ? w.type === 'code' || w.type === 'pr' : w.type === f);
}
function workDay(at) {
  const d = new Date(at),
    now = new Date(),
    days = Math.round(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
        new Date(d.getFullYear(), d.getMonth(), d.getDate())) /
        864e5,
    );
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? 'week' : 'earlier';
}
function workKey(work) {
  return work.navigationId;
}
function reviewsModels() {
  const source = projectData('reviews');
  if (!source) return {};
  const data = projectChatData(),
    threadId = data.threadId,
    ui = CS;
  const memberNames = new Map(data.cats.map((cat) => [cat.id, cat.nickname || cat.displayName]));
  const selectedWork = source.openedWork,
    artifacts = source.artifacts,
    global = source.global;
  const localWorks = artifacts.works,
    globalWorks = global.works,
    recentOwners = source.recentOwners;
  const globalEnabled = source.globalEnabled,
    widgets = source.widgets;
  const worktreeId = source.worktreeId,
    workMetadata = source.workMetadata,
    text = source.text;
  const contexts = source.contexts,
    load = source.load,
    history = source.history,
    historyLoad = source.historyLoad;
  const compareSrc = source.compareSrc,
    error = source.error,
    reviewId = source.reviewId,
    round = source.round;
  const snapshot = source.review && Object.assign({}, source.review, { controller: source.review });
  const view = snapshot && snapshot.view && snapshot.view.review.reviewId === reviewId ? snapshot.view : null;
  const state = function () {
    return ui.review;
  };
  const currentRound = function () {
    return (
      view &&
      (view.review.rounds.find(function (r) {
        return r.number === (state() && state().round != null ? state().round : snapshot.round);
      }) ||
        view.review.rounds.at(-1))
    );
  };
  const initialWork = selectedWork && selectedWork.artifact;
  const workKind = initialWork && initialWork.sourceFacts.content.kind;
  const worksReading = { current: S.ws.wk },
    textReading = { current: CS.ws };
  const selectionForChat = { current: source.selectionForChat };
  const draft = CS.contentModification;
  const modification = {
    current:
      source.modification &&
      Object.assign({}, source.modification, {
        prompt: draft.prompt,
        targetId: draft.targetId,
        threadId: draft.threadId,
        imageEdit: draft.imageEdit,
      }),
  };
  const work =
    selectedWork &&
    (selectedWork.reference ||
      [...localWorks, ...globalWorks, ...recentOwners].some((w) => workKey(w) === workKey(selectedWork.artifact)))
      ? selectedWork.artifact
      : null;
  const fileSource = work ? work.sourceFacts.fileSource : null;
  const s = state(),
    r = currentRound(),
    canWrite = !!view?.authority.canWrite && !view.pendingVersion && r === view.review.rounds.at(-1),
    media = r?.asset.media;
  const seconds = (tick) =>
    media?.kind === 'video'
      ? (tick * media.timebase.numerator) / media.timebase.denominator - media.containerStartSeconds
      : 0;
  const point = (anchor) =>
    anchor.kind === 'video-range'
      ? { ...(anchor.frameRegion ?? anchor.framePoint), from: seconds(anchor.startTick), to: seconds(anchor.endTick) }
      : anchor;
  const marks =
    r?.annotations.map((a) => ({
      ...point(a.anchor),
      label: a.body,
      open: canWrite ? { act: 'workReviewEdit', args: { id: a.id } } : null,
    })) ?? [];
  if (s?.draft?.x !== undefined && !s.edit) marks.push({ ...s.draft, label: s.draft.body, open: null });
  if (s?.focusAnchor) marks.push({ ...point(s.focusAnchor), open: null });
  const named = view && r ? source.requestSources[r.number] : null;
  const review = s
    ? view && r && media
      ? {
          load: snapshot?.controller.loading ? 'loading' : snapshot?.controller.error ? 'error' : '',
          title: view.review.title,
          canWrite,
          canPick: canWrite,
          video: media.kind === 'video',
          selectedRound: r.number,
          rounds: view.review.rounds.map((r) => ({ v: r.number })),
          canCompare: view.review.rounds.length > 1,
          version: { sourceTitle: work?.name, openedAt: r.openedAt, ownerRevision: r.asset.ownerRevision },
          location:
            s.focusAnchor?.kind === 'video-range'
              ? {
                  id: work && workKey(work),
                  at: seconds(s.focusAnchor.startTick),
                  key: JSON.stringify([reviewId, r.number, s.focusVersion]),
                }
              : null,
          discussion: { canBring: !!view.authority.ownerCatId && !!named },
          editing: !!s.edit,
          modification: !!modification.current,
          draft: s.draft,
          actionError: error || snapshot?.controller.error,
          media: {
            id: work && workKey(work),
            kind: media.kind,
            src: snapshot?.round === r.number ? snapshot?.src : null,
            width: media.width,
            height: media.height,
            label: work?.name,
            marks,
            review: true,
            canPick: canWrite,
            canWrite: canWrite,
            markup:
              s.markup ??
              r.visualMarks
                ?.filter((m) => m.state === 'active')
                .map((m) => {
                  const { frame, ...drawing } = m.drawing;
                  return {
                    ...drawing,
                    readonly: m.author.kind !== 'human' || m.author.actorId !== view.review.task.ownerUserId,
                    ...(frame
                      ? {
                          time: seconds(frame.tick),
                          until:
                            seconds(frame.tick) +
                            (media.kind === 'video' && media.frameRate
                              ? media.frameRate.denominator / media.frameRate.numerator
                              : 0),
                        }
                      : {}),
                  };
                }),
            frameStep:
              media.kind === 'video'
                ? media.frameRate
                  ? media.frameRate.denominator / media.frameRate.numerator
                  : media.timebase.numerator / media.timebase.denominator
                : 0,
          },
          history: {
            ...history,
            items: history.entries.map((e) => ({ title: e.kind, sub: e.receipt.createdAt })),
            hasMore: history.nextCursor !== null,
            load: historyLoad,
          },
          annotations: r.annotations.map((a) => ({
            id: a.id,
            body: a.body,
            resolved: a.state === 'resolved',
            canEdit: canWrite && a.author.kind === 'human' && a.author.actorId === view.review.task.ownerUserId,
            canSetState: canWrite,
            canReanchor: view.authority.canWrite && !canWrite,
            replies: a.replies.map((reply) => ({ title: reply.body })),
            mediaId: work && workKey(work),
            at: a.anchor.kind === 'video-range' ? seconds(a.anchor.startTick) : 0,
          })),
          responses: r.responses?.map((response) => ({
            annotationId: response.annotationId,
            explanation: response.explanation,
            canJudge: view.authority.canWrite && !view.pendingVersion && r.state !== 'superseded',
            title: view.review.rounds
              .find((round) => round.number === r.responseSource?.round)
              ?.annotations.find((a) => a.id === response.annotationId)?.body,
            source: r.responseSource ? { round: r.responseSource.round, annotationId: response.annotationId } : null,
            result: response.resultAnchor ? { round: r.number, anchor: response.resultAnchor } : null,
            accepted: response.judgment?.outcome === 'accepted',
            reopened: response.judgment?.outcome === 'reopened',
          })),
          comparison:
            s.compare && compareSrc
              ? {
                  leftMedia: { id: 'before', kind: media.kind, src: compareSrc },
                  rightMedia: { id: 'after', kind: media.kind, src: snapshot?.src },
                }
              : null,
        }
      : { load, choosing: true, contexts }
    : null;
  const m = modification.current,
    record = m?.view?.record,
    execution = m?.view?.execution,
    candidates = m?.view?.candidates ?? [];
  const reading = worksReading.current;
  const row = (w) => {
    const cat = data.cats.find((c) => c.id === w.catId);
    const cover =
      w.type === 'video' && w.work
        ? workCoverVM({ contentRef: w.work.contentRef, ownerRevision: w.work.ownerRevision })
        : null;
    return {
      id: workKey(w),
      type: w.type,
      name: w.name,
      cover: cover,
      coverSource: cover && cover.image ? api.file(cover.image.url) : '',
      cat: w.catId,
      catName: cat?.nickname || cat?.displayName,
      catHandle: cat?.mentionPatterns[0],
      at: w.createdAt,
      thread: w.threadId,
      threadTitle: w.threadTitle,
      day: workDay(w.createdAt),
      stale: !!w.work && w.work.ownerRevision < w.work.currentOwnerRevision,
      revision: w.work ? { own: w.work.ownerRevision, cur: w.work.currentOwnerRevision } : null,
      source: w.url ? w.sourceFacts.mediaUrl : null,
      args: { id: workKey(w) },
      actsCtx: { thread: w.threadId || threadId, msg: w.sourceMessageId },
      scope: reading.scope,
      group: reading.group,
    };
  };
  const worksModel = (values, source, globalScope, showScope) => {
    const matches = values.filter(
      (w) =>
        (!globalScope || !reading.cat || w.catId === reading.cat) &&
        w.name.toLocaleLowerCase().includes(reading.q.trim().toLocaleLowerCase()),
    );
    const items = matches.filter((w) => workMatch(w, reading.f)).map(row);
    const grouped = globalScope && reading.group !== 'none';
    const groupKey = (w) => (reading.group === 'thread' ? w.thread : reading.group === 'cat' ? w.cat || '' : w.day);
    const keys = [...new Set(items.map(groupKey))];
    const groups = keys.map((key, i) => {
      const rows = items.filter((w) => groupKey(w) === key);
      return {
        id: 'works-' + i,
        last: i === keys.length - 1,
        group: reading.group,
        day: key,
        name: reading.group === 'thread' ? rows[0].threadTitle : '',
        catName: reading.group === 'cat' ? rows[0].catName : '',
        catHandle: reading.group === 'cat' ? rows[0].catHandle : '',
        count: rows.length,
        items: rows,
      };
    });
    return {
      load: globalScope
        ? !values.length
          ? source.loading || source.loadingMore
            ? 'loading'
            : source.error
              ? 'error'
              : ''
          : ''
        : source.loading
          ? 'loading'
          : source.error
            ? 'error'
            : !source.complete
              ? 'stale'
              : '',
      hasMore: globalScope && !!source.hasMore,
      loadingMore: globalScope && !!source.loadingMore,
      stale: globalScope && !!source.stale,
      moreError: globalScope && !!source.error,
      items,
      scope: globalScope ? 'global' : 'thread',
      q: reading.q,
      layout: reading.view,
      chips: ['all', 'image', 'file', 'codepr', 'audio', 'video', 'widget'].map((v) => ({
        v,
        count: matches.filter((w) => workMatch(w, v)).length,
        active: reading.f === v,
      })),
      groups: grouped ? groups : [],
      groupVal: reading.group,
      catVal: reading.cat,
      catOpts: [...new Set(values.map((w) => w.catId))].filter(Boolean).map((v) => {
        const c = data.cats.find((c) => c.id === v);
        return { v, name: c?.nickname || c?.displayName || v, handle: c?.mentionPatterns[0] };
      }),
    };
  };
  return {
    contextWorks: globalWorks
      .filter((work) => work.work)
      .map((work) => ({ workId: work.work.contentRef, version: work.work.ownerRevision, title: work.name })),
    worksState: reading,
    workTextState: textReading.current,
    workItems: localWorks.map(row),
    widgetWorks: [
      ...new Map(
        [...localWorks, ...globalWorks].filter((w) => w.type === 'widget').map((w) => [workKey(w), w]),
      ).values(),
    ].map((w) => {
      const key = workKey(w),
        state = widgets[key]?.state;
      return {
        id: key,
        kind: w.type,
        title: w.name,
        source:
          state && state.status === 'ready'
            ? 'data:text/html;charset=utf-8,' + encodeURIComponent(state.block.html)
            : w.sourceFacts.fileUrl,
        openPath: w.path || w.name,
        meta: {
          type: w.type,
          author: memberNames.get(w.catId) || w.catId,
          at: w.createdAt,
          version: w.work && w.work.ownerRevision,
          hasThread: !!w.threadId,
          threadTitle: w.threadTitle,
        },
        widget: {
          key,
          load:
            !state || state.status === 'loading'
              ? 'loading'
              : state.status === 'error'
                ? 'error'
                : state.status === 'ready'
                  ? ''
                  : 'empty',
          html: state?.status === 'ready' ? state.block.html : null,
        },
      };
    }),
    workSource: work ? { t: work.threadId || threadId, mid: work.sourceMessageId } : null,
    works: worksModel(
      reading.scope === 'global' ? globalWorks : localWorks,
      reading.scope === 'global' ? global : artifacts,
      reading.scope === 'global',
      true,
    ),
    worksAll: worksModel(globalWorks, { ...global, loading: global.loading || !globalEnabled }, true, false),
    selectionForChat: selectionForChat.current,
    reviewState: s,
    reviewId,
    reviewRound: round,
    mediaReview: review,
    work: work
      ? {
          id: workKey(work),
          title: work.name,
          i: workKey(work),
          kind:
            text.error || (!work.url && !work.ref)
              ? 'nosrc'
              : workKind === 'office' || workKind === 'binary'
                ? 'bin'
                : workKind,
          source: work.sourceFacts.fileUrl || work.sourceFacts.mediaUrl,
          openPath: fileSource && fileSource.kind === 'workspace' ? fileSource.path : work.name,
          meta: {
            type: work.type,
            at: work.createdAt,
            author: memberNames.get(work.catId) || work.catId,
            version: work.work?.ownerRevision,
            hasThread: !!work.threadId,
            threadTitle: work.threadTitle,
          },
          bodyLoad: text.loading ? 'loading' : '',
          text:
            text.content === null
              ? null
              : {
                  path: text.path,
                  md: text.content,
                  mode: !text.isMarkdown ? 'src' : textReading.current.mode,
                },
          pr:
            work.type === 'pr'
              ? {
                  url: work.url ?? work.sourceFacts.prUrl,
                  ref: work.ref,
                  target: workPrTarget(work),
                  changes: prChangesVM(workPrTarget(work)),
                }
              : null,
          bin:
            ['office', 'binary'].includes(workKind) && fileSource && fileSource.kind !== 'none'
              ? { source: work.sourceFacts.fileUrl }
              : null,
          fileInfo: workMetadata ? fileInfoVM(workMetadata) : null,
          canonReference: work.work
            ? { contentRef: work.work.contentRef, ownerRevision: work.work.ownerRevision }
            : null,
          coverReference:
            work.type === 'video' && work.work
              ? { contentRef: work.work.contentRef, ownerRevision: work.work.ownerRevision }
              : null,
          canReview: ['image', 'video'].includes(work.type),
          review: !!review,
          media:
            review || !['image', 'video', 'audio'].includes(workKind)
              ? null
              : {
                  id: workKey(work),
                  kind: workKind,
                  src: work.url ? work.sourceFacts.mediaUrl : null,
                  label: work.name,
                  marks: ui.lb?.selection ? [ui.lb.selection] : [],
                  canPick: work.type === 'image',
                  canWrite: false,
                },
        }
      : null,
    workPreview:
      work && ui.lb
        ? {
            id: workKey(work),
            target: { kind: 'work', id: workKey(work) },
            title: work.name,
            author: memberNames.get(work.catId) || work.catId,
            version: work.work && work.work.ownerRevision,
            at: work.createdAt,
            index: 1,
            total: 1,
            file:
              fileSource && fileSource.kind === 'workspace'
                ? { path: fileSource.path, worktreeId: fileSource.worktreeId }
                : null,
            many: false,
            source: s
              ? view && snapshot?.round === r?.number
                ? snapshot?.download
                : undefined
              : work.url
                ? work.sourceFacts.mediaUrl
                : null,
            selection: ui.lb?.selection,
            words: ui.lb?.words,
          }
        : null,
    discussion:
      view && r && named
        ? {
            threadId: view.review.task.threadId,
            target: view.authority.ownerCatId,
            attachment: {
              v: 1,
              kind: 'media',
              title: view.review.title,
              mediaType: r.asset.mediaType,
              source: named.source,
              selections: [],
              taskContext: named.taskContext,
            },
          }
        : null,
    contentModification: {
      modification: m
        ? {
            ...m,
            load: m.load,
            canImageEdit: m.place === 'review' && media?.kind === 'image',
            canChoose: !m.taskContext,
            choicesReady: !!m.choices,
            targetOptions: (m.choices?.cats ?? [])
              .filter((c) => c.mcpSupport && c.preflight?.disposition !== 'rejected')
              .map((c) => ({ v: c.catId, label: c.name })),
            threadOptions: (m.choices?.threads ?? []).map((t) => ({ v: t.threadId, label: t.title })),
            canSubmit: !m.requestId,
            canCancel: !!record && !record.control && !candidates.length,
            state: record?.control
              ? 'cancelled'
              : execution && ['failed', 'interrupted', 'unknown', 'withdrawn_running'].includes(execution.state)
                ? execution.state
                : record?.issue
                  ? 'issue'
                  : '',
            ownerResolution: record?.control?.taskResolution,
            results: candidates.map((c) => {
              const round =
                c.kind === 'media' &&
                view?.review.rounds.find(
                  (r) => r.asset.contentRef === c.asset.contentRef && r.asset.ownerRevision === c.asset.ownerRevision,
                );
              return {
                act: round ? 'workReviewPrepare' : '',
                args: round ? { round: round.number } : {},
              };
            }),
            requestId: m.requestId,
          }
        : null,
    },
  };
}

function contentClock(seconds) {
  const value = Math.max(0, seconds);
  return Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
}
function filmModels() {
  const source = projectData('film');
  if (!source) return {};
  const projects = source.projects,
    load = source.load,
    selected = source.selected,
    reference = source.reference;
  const ui = { current: S.ws.film },
    workbench = S.ws;
  const sourceFor = function (screening) {
    if (selected && selected.descriptor && selected.descriptor.screening.id === screening)
      return { descriptor: selected.descriptor, input: selected.input, facts: selected.facts };
    return reference && reference.descriptor.screening.id === screening ? reference : null;
  };
  const media = (source, right = false) => {
    const s = selected,
      { descriptor, input } = source,
      screen = descriptor.screening;
    const id = `film:${s.head.contentRef}:${screen.id}${right ? ':reference' : ''}`;
    return {
      id,
      kind: 'video',
      src: api.file(descriptor.mediaUrl),
      label: descriptor.screening.title,
      canPick: true,
      project: s.head.contentRef,
      screening: screen.id,
      marks: s.review.annotations.flatMap((a) => {
        const original = a.projectMessage;
        if (!original || original.screeningId !== screen.id || !original.selection.displayRegion) return [];
        return [
          {
            ...original.selection.displayRegion.bbox,
            from: source.facts.annotationTimes[a.id].from,
            to: source.facts.annotationTimes[a.id].to,
            label: a.body,
            annotationId: a.id,
          },
        ];
      }),
      group: reference ? s.head.contentRef : null,
      points: reference
        ? input.document.timeline.scenes.flatMap(function (scene) {
            const at = source.facts.scenePositions[scene.id];
            return at == null ? [] : [{ key: scene.id, label: scene.label, at: at }];
          })
        : null,
      width: descriptor.screening.media.media.width,
      height: descriptor.screening.media.media.height,
    };
  };
  const s = selected,
    state = ui.current,
    d = s?.input.document,
    m = s?.descriptor ? media({ descriptor: s.descriptor, input: s.input, facts: s.facts }) : null,
    comparison = reference ? media(reference, true) : null,
    leftPoints = m?.points,
    rightPoints = comparison?.points,
    common = leftPoints && rightPoints ? leftPoints.filter((a) => rightPoints.some((b) => a.key === b.key)) : [],
    preview = workbench.clipPreview,
    previewSource = preview?.markArgs ? sourceFor(preview.markArgs.screening) : null;
  const locate = (tick) => {
    if (!s?.descriptor || !m) return {};
    const at = s.facts.segmentPositions[tick];
    return at == null ? {} : { act: 'mediaSeek', args: { id: m.id, at: at } };
  };
  const assets = d?.assets.map((a) => {
    const used = d.timeline.segments
        .flatMap((s) => s.visuals)
        .find((v) => a.versions.some((version) => version.id === v.assetVersionRef)),
      version = a.versions.find((v) => v.id === (state.assets[a.id] ?? used?.assetVersionRef)) ?? a.versions.at(-1);
    return {
      id: a.id,
      stableRef: version.id,
      title: a.name,
      kind: a.kind,
      size: version.byteLength,
      projectId: s.head.contentRef,
      selected: version.id,
      versions: a.versions.map((v, i) => ({ id: v.id, n: i + 1 })),
      selectId: `film-asset-${a.id}`,
      args: { id: s.head.contentRef, asset: a.id, version: version.id },
      uses: d.timeline.segments
        .filter((segment) => segment.visuals.some((v) => v.assetVersionRef === version.id))
        .map((segment) => {
          const to = locate(segment.startTick);
          return { title: segment.label, canLocate: !!to.args, location: to.args };
        }),
    };
  });
  const items = projects.map((p) => {
    const document = p.document,
      screenings = document.screenings ?? [],
      screening = screenings.at(-1);
    return {
      key: p.contentRef,
      id: p.contentRef,
      title: document.title,
      segments: document.timeline.segments.length,
      screenings: screenings.length,
      dur:
        (document.timeline.durationTicks * document.timeline.timebase.numerator) /
        document.timeline.timebase.denominator,
      screening: screening && screening.id,
      source: screening
        ? api.file(
            '/api/video-projects/' +
              encodeURIComponent(p.contentRef) +
              '/screenings/' +
              encodeURIComponent(screening.id) +
              '/media',
          )
        : '',
      hasScreening: !!screening,
      preview: screening
        ? {
            kind: 'video',
            src: api.file(
              `/api/video-projects/${encodeURIComponent(p.contentRef)}/screenings/${encodeURIComponent(screening.id)}/media`,
            ),
          }
        : null,
    };
  });
  return {
    filmOwner: s?.head,
    filmReviewRevision: s?.review.revision,
    filmReference: s ? { contentRef: s.head.contentRef, ownerRevision: s.input.ownerRevision } : null,
    filmPreview: preview?.markArgs
      ? previewSource
        ? {
            title: preview.title,
            screeningTitle: previewSource.descriptor.screening.title,
            hasScreeningTitle: !!previewSource.descriptor.screening.title,
            inputRevision: previewSource.input.ownerRevision,
            recordedAt: previewSource.descriptor.screening.createdAt,
            url: preview.url,
            media: {
              ...media(previewSource),
              id: preview.media.id,
              group: null,
              points: null,
              canPick: true,
              project: preview.markArgs.id,
              screening: preview.markArgs.screening,
            },
          }
        : null
      : preview,
    cafeWsClips: {
      load,
      project: !!selected,
      layout: state.layout,
      items,
    },
    filmProject:
      s && d
        ? {
            id: s.head.contentRef,
            sync: s.sync?.pending ? { pending: s.sync.pending } : null,
            title: s.head.document.title,
            inputRevision: s.input.ownerRevision,
            reference: { contentRef: s.head.contentRef, ownerRevision: s.input.ownerRevision },
            archived: !!s.head.document.archivedAt,
            media: m,
            hasScreening: !!m,
            comparison,
            compareGroup: comparison
              ? {
                  group: s.head.contentRef,
                  hasPoints: common.length > 0,
                  points: common.map((p) => [p.key, p.label]),
                }
              : null,
            compare: state.compare,
            comparisonOptions: (s.head.document.screenings ?? [])
              .filter((x) => x.id !== s.descriptor?.screening.id)
              .map((x) => [x.id, x.title]),
            primaryTitle: s.descriptor?.screening.title,
            referenceTitle: reference?.descriptor.screening.title,
            screening: s.descriptor?.screening.id,
            screens: s.head.document.screenings?.map((screen) => [screen.id, screen.title]),
            canCompare: (s.head.document.screenings?.length ?? 0) > 1,
            tab: state.tab,
            storyTab: state.tab === 'story',
            assetsTab: state.tab === 'assets',
            reviewTab: state.tab === 'review',
            opinions: s.review.annotations
              .filter((a) => !a.projectMessage || !!sourceFor(a.projectMessage.screeningId))
              .map((a) => {
                const history = a.projectHistory ?? [];
                const latest = [...history]
                  .reverse()
                  .find((h) => ['addressed', 'reopened', 'resolved'].includes(h.kind));
                const original = a.projectMessage;
                const source = original ? sourceFor(original.screeningId) : null;
                const at = original && source ? source.facts.annotationTimes[a.id].from : null;
                return {
                  id: a.id,
                  compare: a.sourceComparison,
                  cur: state.opinion === a.id,
                  title: a.body,
                  state: a.state,
                  last: latest,
                  canLocate: at !== null,
                  location: { id: source === reference ? comparison?.id : m?.id, at: at },
                  sourceChanged: original?.sourceState === 'changed' || original?.sourceState === 'unavailable',
                  source: original ? { thread: original.source.threadId, mid: original.source.messageId } : null,
                  canReopen: latest?.kind === 'addressed' || a.state === 'resolved',
                  act: at === null ? '' : 'mediaSeek',
                  args: { id: source === reference ? comparison?.id : m?.id, at },
                  history: history.filter((h) => h.kind !== 'created'),
                  replies: (a.replies ?? []).map((r) => ({
                    title: r.body,
                    authorKind: r.author.kind,
                    authorName:
                      r.author.kind === 'cat'
                        ? projectChatData().cats.find((c) => c.id === r.author.actorId)?.displayName
                        : '',
                  })),
                };
              }),
            chapters: d.timeline.scenes.map((scene) => {
              const shot = d.timeline.segments.find((segment) => segment.sceneId === scene.id);
              return { title: scene.label, canLocate: !!shot, location: shot ? locate(shot.startTick).args : null };
            }),
            assets,
            story: d.timeline.segments.map((segment) => ({
              id: segment.id,
              title: segment.label,
              sub: d.timeline.scenes.find((scene) => scene.id === segment.sceneId)?.label,
              startTime: (segment.startTick * d.timeline.timebase.numerator) / d.timeline.timebase.denominator,
              endTime:
                ((segment.startTick + segment.durationTicks) * d.timeline.timebase.numerator) /
                d.timeline.timebase.denominator,
              canLocate: !!locate(segment.startTick).args,
              location: locate(segment.startTick).args,
              visuals: segment.visuals.map((v) => {
                const asset = d.assets.find((a) => a.versions.some((version) => version.id === v.assetVersionRef));
                return {
                  title: asset?.name,
                  generated: !asset,
                  sub: v.assetVersionRef,
                  known: !!asset,
                  projectId: s.head.contentRef,
                  assetId: asset?.id,
                  version: v.assetVersionRef,
                };
              }),
              events: d.timeline.events
                .filter((e) => e.segmentId === segment.id)
                .map((e) => ({ title: e.text ?? e.kind, sub: e.speaker })),
            })),
          }
        : null,
  };
}
