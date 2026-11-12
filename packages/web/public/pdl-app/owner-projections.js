/* Application VM projections moved from React owners. Receipts stay in the held snapshot. */
(() => {
  // pure:packages/shared/src/types/capability-evolution-refs.ts
  var isAssetRef = (ref) => typeof ref.assetKind === 'string' && typeof ref.assetId === 'string';
  var refIdentity = (ref) =>
    JSON.stringify(
      isAssetRef(ref)
        ? ['asset', ref.ownerFeatureId, ref.ownerStateRef, ref.version ?? null, ref.assetKind, ref.assetId]
        : ['owner', ref.ownerFeatureId, ref.ownerStateRef, ref.version ?? null],
    );

  globalThis.projectRefIdentity = refIdentity;

  // pure:packages/shared/src/types/routing-signal-closures.ts
  function compare(left, right) {
    return left.observedAt - right.observedAt || left.eventId.localeCompare(right.eventId);
  }
  function catKey(ownerId, catId) {
    return JSON.stringify([ownerId, catId]);
  }
  function sameSubject(left, right) {
    if (left.type === 'cat') return right.type === 'cat' && left.catId === right.catId;
    if (left.type === 'provider') return right.type === 'provider' && left.providerId === right.providerId;
    return right.type === 'quota_pool' && left.poolId === right.poolId;
  }
  function routingSignalClosures(events) {
    const closures = /* @__PURE__ */ new Map();
    const assertions = new Map(
      events.filter((event) => event.eventType === 'asserted').map((event) => [event.eventId, event]),
    );
    const probesByCat = /* @__PURE__ */ new Map();
    const closers = events.filter((event) => event.eventType !== 'asserted').sort(compare);
    for (const closer of closers) {
      for (const id of closer.closesSignalIds) {
        const assertion = assertions.get(id);
        if (!assertion) continue;
        if (
          closures.has(assertion.eventId) ||
          assertion.ownerId !== closer.ownerId ||
          !sameSubject(assertion.subjectRef, closer.subjectRef) ||
          assertion.observedAt > closer.observedAt
        )
          continue;
        closures.set(id, closer);
      }
      if (
        closer.eventType === 'recovered' &&
        closer.source === 'dispatch_success' &&
        closer.subjectRef.type === 'cat' &&
        closer.probeStartedAt !== void 0
      ) {
        const key = catKey(closer.ownerId, closer.subjectRef.catId);
        const probes = probesByCat.get(key) ?? [];
        if (!probes.length || closer.probeStartedAt > probes[probes.length - 1].probeStartedAt)
          probes.push({ ...closer, probeStartedAt: closer.probeStartedAt });
        probesByCat.set(key, probes);
      }
    }
    for (const assertion of assertions.values()) {
      if (
        assertion.subjectRef.type !== 'cat' ||
        (assertion.source !== 'provider_error' && assertion.source !== 'health_probe')
      )
        continue;
      const probes = probesByCat.get(catKey(assertion.ownerId, assertion.subjectRef.catId)) ?? [];
      let low = 0;
      let high = probes.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (probes[middle].probeStartedAt < assertion.observedAt) low = middle + 1;
        else high = middle;
      }
      const probe = probes[low];
      const existing = closures.get(assertion.eventId);
      if (probe && (!existing || compare(probe, existing) < 0)) closures.set(assertion.eventId, probe);
    }
    return closures;
  }

  // pure:packages/shared/src/core-commands.ts
  var CORE_COMMANDS = [
    // --- general ---
    {
      name: '/help',
      usage: '/help',

      category: 'general',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/config',
      usage: '/config',

      category: 'general',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/config set',
      usage: '/config set <key> <value>',

      category: 'general',
      surface: 'web',
      source: 'core',
    },
    // --- memory ---
    {
      name: '/remember',
      usage: '/remember <key> <value>',

      category: 'memory',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/recall',
      usage: '/recall [key]',

      category: 'memory',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/approve',
      usage: '/approve <entryId>',

      category: 'memory',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/archive',
      usage: '/archive <entryId>',

      category: 'memory',
      surface: 'web',
      source: 'core',
    },
    // --- knowledge ---
    {
      name: '/evidence',
      usage: '/evidence <query>',

      category: 'knowledge',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/reflect',
      usage: '/reflect <query>',

      category: 'knowledge',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/signals',
      usage: '/signals [inbox]',

      category: 'knowledge',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/signals search',
      usage: '/signals search <query>',

      category: 'knowledge',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/signals sources',
      usage: '/signals sources [sourceId on|off]',

      category: 'knowledge',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/signals stats',
      usage: '/signals stats',

      category: 'knowledge',
      surface: 'web',
      source: 'core',
    },
    // --- task ---
    {
      name: '/tasks extract',
      usage: '/tasks extract [N]',

      category: 'task',
      surface: 'web',
      source: 'core',
    },
    // --- vote ---
    {
      name: '/vote',
      usage: '/vote',

      category: 'vote',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/vote status',
      usage: '/vote status',

      category: 'vote',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/vote cast',

      category: 'vote',
      surface: 'web',
      source: 'core',
    },
    {
      name: '/vote end',
      usage: '/vote end',

      category: 'vote',
      surface: 'web',
      source: 'core',
    },
    // --- connector ---
    {
      name: '/commands',
      usage: '/commands',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/where',
      usage: '/where',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/new',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/threads',
      usage: '/threads',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/use',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/thread',
      usage: '/thread <thread_id> <message>',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/cats',
      usage: '/cats',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/status',
      usage: '/status',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/history',
      usage: '/history [N]',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/unbind',
      usage: '/unbind',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/allow-group',
      usage: '/allow-group',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/deny-group',
      usage: '/deny-group',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    // --- routing (F154: Cat Routing Personalization) ---
    {
      name: '/focus',

      category: 'connector',
      surface: 'connector',
      source: 'core',
      subcommands: ['clear'],
    },
    {
      name: '/ask',

      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
  ];

  // pure:packages/shared/src/codex-account.ts
  function accountQuotaOwnerMatches(observation, accountRef, identity) {
    return (
      !!identity &&
      observation?.owner?.accountRef === accountRef &&
      observation.owner.userId === identity.userId &&
      observation.owner.workspaceId === identity.workspaceId
    );
  }

  // pure:packages/web/src/components/capability-evolution/exploration/exploration-history.ts
  function isHistoricalStep(node) {
    return node?.kind === 'public_archive' && node.history !== void 0;
  }

  // pure:packages/web/src/components/capability-evolution/exploration/exploration-decision-model.ts
  function suggestedExperiment(catalog, experiments) {
    const recorded = experiments.filter((run) => run.status === 'recorded' && run.recordCount > 0);
    return recorded.findLast((run) => suggestedComparison(catalog, run)) ?? recorded.at(-1) ?? experiments.at(-1);
  }
  function suggestedComparison(catalog, experiment) {
    if (experiment.status !== 'recorded' || !experiment.recordCount) return;
    const parents =
      catalog.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(experiment.nodeRef))?.parentEdges ?? [];
    const candidates = catalog.experiments.filter((candidate) => {
      if (
        candidate.status !== 'recorded' ||
        !candidate.recordCount ||
        !parents.some((edge) => refIdentity(edge.parentNodeRef) === refIdentity(candidate.nodeRef))
      )
        return false;
      const a = candidate.conditions,
        b = experiment.conditions;
      return (
        ['environment', 'sampleSet', 'measurement', 'groundTruth', 'window'].every(
          (key) => refIdentity(a[key].sourceRef) === refIdentity(b[key].sourceRef),
        ) &&
        a.groundTruth.status === b.groundTruth.status &&
        a.exposure === b.exposure &&
        a.comparison.design === b.comparison.design &&
        a.comparison.design !== 'undeclared' &&
        a.comparison.planRef &&
        b.comparison.planRef &&
        refIdentity(a.comparison.planRef) === refIdentity(b.comparison.planRef)
      );
    });
    return candidates.length === 1 ? candidates[0] : void 0;
  }

  // pure:packages/web/src/components/capability-evolution/exploration/use-exploration-workspace.ts
  function resolveNode(catalog, selectedNodeRef, exactSource) {
    if (selectedNodeRef)
      return catalog?.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(selectedNodeRef));
    if (exactSource)
      return catalog?.nodes.find(
        (node) => node.kind === 'owner_version' && refIdentity(node.versionRef) === refIdentity(exactSource),
      );
    return (
      catalog?.nodes.find(isHistoricalStep) ??
      catalog?.nodes.filter((entry) => entry.kind === 'owner_version').at(-1) ??
      catalog?.nodes.at(-1)
    );
  }
  function selectExperiment(catalog, experiments, selectedRef) {
    if (selectedRef) return experiments.find((run) => refIdentity(run.experimentRef) === refIdentity(selectedRef));
    return catalog ? suggestedExperiment(catalog, experiments) : void 0;
  }

  // pure:packages/web/src/components/capability-evolution/exploration/exploration-comparison.ts
  function comparisonScopeKey(left, right) {
    return JSON.stringify(
      [
        left.experimentRef,
        right.experimentRef,
        left.conditions.sampleSet.sourceRef,
        right.conditions.sampleSet.sourceRef,
      ].map(refIdentity),
    );
  }
  function completeSide(side) {
    const { experiment, records } = side;
    return (
      records.length === experiment.recordCount &&
      records.every(
        (record) =>
          refIdentity(record.experimentRef) === refIdentity(experiment.experimentRef) &&
          refIdentity(record.nodeRef) === refIdentity(experiment.nodeRef) &&
          refIdentity(record.windowRef) === refIdentity(experiment.conditions.window.sourceRef) &&
          refIdentity(record.measurementRef) === refIdentity(experiment.conditions.measurement.sourceRef),
      )
    );
  }
  function compareExplorationRecords(left, right, scope, acceptedScopeKey) {
    const result = { status: 'unavailable', reasons: [], pairs: [], leftOnly: [], rightOnly: [] };
    const a = left.experiment.conditions;
    const b = right.experiment.conditions;
    if (refIdentity(left.experiment.experimentRef) === refIdentity(right.experiment.experimentRef))
      return { ...result, reasons: ['sameExperiment'] };

    for (const key of ['environment', 'window', 'measurement', 'groundTruth'])
      if (refIdentity(a[key].sourceRef) !== refIdentity(b[key].sourceRef)) result.reasons.push('conditionsDiffer');
    if (a.exposure !== b.exposure || a.groundTruth.status !== b.groundTruth.status)
      result.reasons.push('conditionsDiffer');
    if (
      a.comparison.design === 'undeclared' ||
      a.comparison.design !== b.comparison.design ||
      !a.comparison.planRef ||
      !b.comparison.planRef ||
      refIdentity(a.comparison.planRef) !== refIdentity(b.comparison.planRef)
    )
      result.reasons.push('conditionsDiffer');
    if (!completeSide(left) || !completeSide(right)) result.reasons.push('incompleteRecords');
    if (!left.records.length || !right.records.length) result.reasons.push('incompleteRecords');
    if (result.reasons.length) return result;
    if (a.comparison.design === 'unpaired') return { ...result, status: 'unpaired' };
    const leftInputs = new Map(left.records.map((record) => [refIdentity(record.inputRef), record]));
    const rightInputs = new Map(right.records.map((record) => [refIdentity(record.inputRef), record]));
    if (leftInputs.size !== left.records.length || rightInputs.size !== right.records.length)
      return { ...result, reasons: ['differentSamples'] };
    for (const record of left.records) {
      const paired = rightInputs.get(refIdentity(record.inputRef));
      if (paired) result.pairs.push({ left: record, right: paired });
      else result.leftOnly.push(record);
    }
    result.rightOnly = right.records.filter((record) => !leftInputs.has(refIdentity(record.inputRef)));
    if (!result.pairs.length) return { ...result, reasons: ['differentSamples'] };
    const partial = result.leftOnly.length > 0 || result.rightOnly.length > 0;
    const accepted =
      scope === 'paired_subset' && acceptedScopeKey === comparisonScopeKey(left.experiment, right.experiment);
    return { ...result, status: partial && !accepted ? 'scope_required' : 'paired' };
  }

  // pure:packages/web/src/components/capability-evolution/exploration/exploration-reading.ts
  var DEFAULT_EXPLORATION = {
    comparisonScope: 'full',
    viewport: { x: 0, y: 0, zoom: 1, collapsed: [] },
    draft: { text: '', intent: 'explore' },
  };

  // pure:packages/web/src/components/routing-context/team-member-projection.ts
  var FIT_KINDS = /* @__PURE__ */ new Set(['strength', 'underused_strength', 'summon_signal']);
  var WATCH_KINDS = /* @__PURE__ */ new Set(['anti_signal', 'hard_limit']);

  function readTeamAvailability(availability, dispatch) {
    return {
      availability,
      ownerAttemptAllowed: availability === 'unavailable' && dispatch?.ownerAttemptAllowed === true,
    };
  }
  function readTeamCapability(candidate) {
    if (candidate.profile.state !== 'applied') return { state: 'absent', summary: '' };
    const revision = candidate.profile.revision;
    const fitSignals = revision.relevantSignals.filter((signal) => FIT_KINDS.has(signal.kind)).map((s) => s.summary);
    const watchOuts = revision.relevantSignals.filter((signal) => WATCH_KINDS.has(signal.kind)).map((s) => s.summary);
    return {
      state: 'applied',
      summary: fitSignals.join(' '),
      fitSignals,
      watchOuts,
      revision,
    };
  }
  function identityKey(value) {
    return value.toLocaleLowerCase().replace(/[\s._-]+/g, '');
  }
  function dedupeSecondaryParts(parts, primary) {
    const kept = [];
    const seen = /* @__PURE__ */ new Set([identityKey(primary)]);
    for (const part of [...parts].reverse()) {
      if (!part) continue;
      const key = identityKey(part);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.unshift(part);
    }
    return kept;
  }
  function buildTeamMemberIdentity(catId, cat) {
    if (!cat) return { catId, displayName: catId, secondaryLabel: null };
    const displayName = cat.nickname?.trim() || cat.displayName;
    const breedLabel = cat.breedDisplayName ?? cat.displayName;
    const secondary = dedupeSecondaryParts([breedLabel, cat.variantLabel, cat.defaultModel], displayName).join(' · ');
    return { catId, displayName, secondaryLabel: secondary || null };
  }
  function toTeamMemberRow(candidate, cat) {
    return {
      candidate,
      identity: buildTeamMemberIdentity(candidate.binding.catId, cat),
      capability: readTeamCapability(candidate),
      availability: readTeamAvailability(candidate.availability, candidate.dispatch),
    };
  }
  function matchesFilter(row, filter) {
    if (filter === 'attention') return row.availability.availability !== 'available';
    if (filter === 'absent') return row.capability.state === 'absent';
    return true;
  }
  function searchCorpus(row) {
    const fit = row.capability.state === 'applied' ? row.capability.fitSignals : [];
    return [
      row.identity.displayName,
      row.identity.catId,
      row.identity.secondaryLabel ?? '',
      row.capability.summary,
      ...fit,
    ]
      .join(' ')
      .toLocaleLowerCase();
  }
  function filterTeamMembers(rows, { query, filter }) {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => matchesFilter(row, filter) && (needle === '' || searchCorpus(row).includes(needle)));
  }
  function countTeamMembers(rows) {
    return {
      all: rows.length,
      attention: rows.filter((row) => matchesFilter(row, 'attention')).length,
      absent: rows.filter((row) => matchesFilter(row, 'absent')).length,
    };
  }

  // pure:packages/web/src/components/routing-context/routing-context-commands.ts
  function routingSubjectKey(subject) {
    if (subject.type === 'cat') return `cat:${subject.catId}`;
    if (subject.type === 'provider') return `provider:${subject.providerId}`;
    return `quota_pool:${subject.poolId}`;
  }
  function openRoutingSignalAssertions(events) {
    const closed = routingSignalClosures(events);
    return events.filter((event) => event.eventType === 'asserted' && !closed.has(event.eventId));
  }
  function openRoutingSignalsForSubject(events, subject) {
    const key = routingSubjectKey(subject);
    return openRoutingSignalAssertions(events).filter((event) => routingSubjectKey(event.subjectRef) === key);
  }
  function preferenceHeads(revisions) {
    const heads = /* @__PURE__ */ new Map();
    for (const revision of revisions) {
      const current = heads.get(revision.preferenceId);
      if (!current || revision.version > current.version) heads.set(revision.preferenceId, revision);
    }
    return [...heads.values()].sort((left, right) => right.validFrom - left.validFrom);
  }

  // pure:packages/web/src/pdl/useTeamBindings.ts

  // pure:packages/web/src/utils/signals-view.ts
  var categoryOrder = ['official', 'papers', 'research', 'engineering', 'community', 'other'];
  function groupSignalSourcesByTierAndCategory(sources) {
    const map = /* @__PURE__ */ new Map();
    for (const source of sources) {
      const key = `${source.tier}:${source.category}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          tier: source.tier,
          category: source.category,
          sources: [source],
        });
        continue;
      }
      map.set(key, {
        ...existing,
        sources: [...existing.sources, source],
      });
    }
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        sources: [...group.sources].sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => {
        if (left.tier !== right.tier) {
          return left.tier - right.tier;
        }
        return categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category);
      });
  }

  // pure:packages/web/src/utils/api-client.ts

  // pure:packages/web/src/components/capability-evolution/exploration/exploration-request-text.ts

  // pure:packages/web/src/components/capability-evolution/journey/evolution-progress-request.ts
  function progressRequestKey({ program }) {
    return `${program.workspaceId}:${program.programId}:${program.sequence}`;
  }

  // pure:packages/web/src/components/capability-evolution/evolution-version-view.ts
  function projectAssetVersions(projection, review) {
    const exactRefs = projection.program.currentAssetVersionRefs.filter(
      (ref) => isAssetRef(ref) && ref.version !== undefined,
    );
    const versions = /* @__PURE__ */ new Map();
    const sourceCurrent = new Set(review?.currentVersionRefs.map(refIdentity) ?? []);
    const adopted = new Set(exactRefs.map(refIdentity));
    const add = (ref) => {
      const key = refIdentity(ref);
      let version = versions.get(key);
      if (!version) {
        version = { ref, sourceCurrent: sourceCurrent.has(key), adopted: adopted.has(key), parents: [] };
        versions.set(key, version);
      }
      return version;
    };
    for (const cycle of projection.lineage?.cycles ?? []) {
      for (const change of cycle.changes) {
        add(change.targetVersionRef);
        if (!change.assetVersionRef || !change.interventionReceiptRef) continue;
        add(change.assetVersionRef);
      }
      if (cycle.decisionAssetVersionRef && cycle.executionReceiptRef) add(cycle.decisionAssetVersionRef);
    }
    for (const ref of exactRefs) add(ref);
    for (const version of review?.versions ?? []) {
      const entry = add(version.versionRef);
      entry.parents = version.parentEdges.map((edge) => edge.parentVersionRef);
      for (const parent of entry.parents) add(parent);
    }
    return [...versions.values()];
  }
  function currentVersionDiff(selected, catalog) {
    const diff = selected?.diff;
    return diff?.status === 'available' &&
      catalog?.currentVersionRefs.some((ref) => refIdentity(ref) === refIdentity(diff.comparedToVersionRef))
      ? diff
      : void 0;
  }

  // pure:packages/web/src/components/capability-evolution/evolution-change-commands.ts
  function canDecideChange(projection, current) {
    return (
      projection.program.lifecycle === 'active' &&
      projection.program.stage === 'deciding' &&
      current?.status === 'outcome' &&
      current.interventionReceiptRef !== void 0 &&
      current.assetVersionRef !== void 0 &&
      current.outcomeReceiptRef !== void 0 &&
      (current.interventionKind === 'no_change' || current.loadedRuntimeRef !== void 0) &&
      current.freshnessProofRef !== void 0
    );
  }

  // pure:packages/web/src/pdl/useEvolutionBindings.ts
  function explorationCase(owner, record, metrics) {
    const media = (record.mediaStatus ? [] : record.media).map((m, i) => {
      const q = new URLSearchParams({
        experimentRef: JSON.stringify(record.experimentRef),
        recordRef: JSON.stringify(record.recordRef),
      });
      return {
        id: 'evo-' + encodeURIComponent(refIdentity(record.recordRef)) + '-' + i,
        kind: m.kind,
        label: m.label,
        src: api.file(
          '/api/capability-evolution/programs/' +
            encodeURIComponent(owner.program.programId) +
            '/exploration-media/' +
            encodeURIComponent(m.mediaRef.version) +
            '?' +
            q,
        ),
        timeSpans: m.timeRange,
        duration: m.durationSeconds,
        sourceRef: m.sourceRecordRef,
      };
    });
    return {
      caseId: record.caseId,
      title: record.label,
      sub: record.result.label !== record.label ? record.result.label : '',
      result: record.result.status,
      expected: record.input,
      actual: record.output,
      source: record.sources,
      body: record.bodyMarkdown,
      fields: record.input
        .concat(record.output)
        .filter((f) => f.value !== record.label && f.value !== record.result.label)
        .map((f) => Object.assign({ field: 'content' }, f))
        .concat(
          metrics.map((m) => ({
            field: 'metric',
            label: m.label,
            value: record.values[m.key],
            unit: m.unit,
            measured: record.values[m.key] != null,
          })),
        ),
      media: media,
      trace: record.trace
        ? {
            key: 'evo-trace-' + encodeURIComponent(refIdentity(record.recordRef)),
            title: record.trace.label,
            xLabel: record.trace.xLabel,
            yLabel: record.trace.yLabel,
            unit: record.trace.unit,
            points: record.trace.points.map((p) => ({
              x: p.x,
              y: p.y,
              seekable: !!media.length && media[0].kind === 'video',
              mediaId: media.length ? media[0].id : '',
              seconds: p.seconds,
            })),
          }
        : null,
      sources: record.sources.map((s) => ({ title: s.label, linkKind: s.href ? 'url' : '', url: s.href, ref: s.ref })),
    };
  }
  function explorationModel(owner, workspace) {
    const { catalog, node, experiment, detail, reading, compareExperiment, compareDetail, comparison, resource } =
        workspace,
      publication = catalog?.publication,
      compared = comparison?.status === 'paired' || comparison?.status === 'unpaired',
      binding = reading.draft.binding;
    return {
      error:
        resource.error || workspace.publicationError || (detail && detail.status !== 'resolved' ? detail.reason : ''),
      catalog: catalog?.nodes.map((n) => ({ v: JSON.stringify(n.nodeRef), label: n.title })) ?? [],
      node: node ? JSON.stringify(node.nodeRef) : '',
      experiments: workspace.experiments.map((e) => ({ v: JSON.stringify(e.experimentRef), label: e.title })),
      experiment: experiment ? JSON.stringify(experiment.experimentRef) : '',
      comparison: reading.comparisonExperimentRef ? JSON.stringify(reading.comparisonExperimentRef) : '',
      comparisonOptions: [
        ...(catalog?.experiments.map((e) => ({ v: JSON.stringify(e.experimentRef), label: e.title })) ?? []),
      ],
      body: node && (node.bodyMarkdown || node.summary) !== node.title ? node.bodyMarkdown || node.summary : '',
      cases:
        detail?.status === 'resolved' && experiment
          ? detail.records.map((record) => explorationCase(owner, record, experiment.metrics))
          : [],
      selectedExperiment: experiment,
      unavailable: !!resource.error,
      publication: publication
        ? { changed: refIdentity(publication.selected.ref) !== refIdentity(publication.current.ref) }
        : null,
      compare: {
        subset:
          comparison?.status === 'scope_required' && compareExperiment && experiment
            ? {
                k: comparisonScopeKey(compareExperiment, experiment),
                count: comparison.pairs.length,
              }
            : null,
        hasError: !!reading.comparisonExperimentRef && !compared,
        errors:
          reading.comparisonExperimentRef && !compared
            ? comparison?.status === 'scope_required'
              ? ['differentSamples']
              : comparison?.reasons || ['comparisonUnavailable']
            : [],
        metrics:
          comparison?.status === 'paired' && experiment && compareExperiment
            ? comparison.pairs.map(({ left, right }) => ({
                title: left.label,
                fields: compareExperiment.metrics
                  .filter((a) =>
                    experiment.metrics.some(
                      (b) =>
                        a.key === b.key && a.unit === b.unit && refIdentity(a.sourceRef) === refIdentity(b.sourceRef),
                    ),
                  )
                  .map((m) => ({
                    field: 'comparison',
                    label: m.label,
                    left: left.values[m.key],
                    right: right.values[m.key],
                    leftMeasured: left.values[m.key] != null,
                    rightMeasured: right.values[m.key] != null,
                    unit: m.unit,
                  })),
              }))
            : [],
        left: {
          title: compareExperiment?.title,
          cases:
            compareDetail?.status === 'resolved' && compareExperiment
              ? (comparison?.status === 'paired' ? comparison.pairs.map((p) => p.left) : compareDetail.records).map(
                  (r) => explorationCase(owner, r, comparison?.status === 'paired' ? [] : compareExperiment.metrics),
                )
              : [],
        },
        right: {
          title: experiment?.title,
          cases:
            detail?.status === 'resolved' && experiment
              ? (comparison?.status === 'paired' ? comparison.pairs.map((p) => p.right) : detail.records).map((r) =>
                  explorationCase(owner, r, comparison?.status === 'paired' ? [] : experiment.metrics),
                )
              : [],
        },
      },
      request: {
        canRequest: owner.program.lifecycle === 'active' && !!owner.origin?.createdByCatId && !!node,
        intent: reading.draft.intent,
        draft: reading.draft.text,
        target: binding && node && refIdentity(binding.nodeRef) !== refIdentity(node.nodeRef) ? binding.title : '',
        intents: ((binding?.kind ?? node?.kind) === 'owner_version'
          ? ['explore', 'retest', 'adopt']
          : ['explore', 'retest']
        ).map((v) => ({ v })),
      },
    };
  }

  // pure:packages/web/src/config/command-registry.ts
  var COMMAND_CATEGORIES = ['general', 'memory', 'knowledge', 'task', 'vote', 'connector'];
  var COMMANDS = CORE_COMMANDS;

  // pure:packages/web/src/components/runtime-sessions/external-runtime-session-format.ts

  function sessionMatchesFilter(session, filter) {
    if (filter === 'all') return true;
    if (filter === 'active') return session.lifecycle.state === 'active';
    if (filter === 'sealed') return session.lifecycle.state === 'sealed';
    return session.lifecycle.state === 'runtime_seal_pending' || session.lifecycle.state === 'runtime_conflict_pending';
  }

  // pure:packages/web/src/components/hub-quota-pools.ts

  function builtinQuotaItems(clientId, quota) {
    switch (clientId) {
      case 'anthropic':
        return quota?.claude.usageItems ?? [];
      case 'openai':
        return quota?.codex.usageItems ?? [];
      case 'google':
        return quota?.gemini?.usageItems ?? [];
      case 'kimi':
        return quota?.kimi?.usageItems ?? [];
      default:
        return [];
    }
  }

  function managedQuotaIsCurrent(profile) {
    return (
      profile.codex?.status === 'ready' && accountQuotaOwnerMatches(profile.quota, profile.id, profile.codex.identity)
    );
  }

  // pure:packages/web/src/components/quota-data.ts
  function toUtilization(item) {
    return item.percentKind === 'remaining' ? 100 - item.usedPercent : item.usedPercent;
  }

  // pure:packages/web/src/components/observability-helpers.ts
  var TELEMETRY_CATEGORY = 'telemetry';

  function getTelemetryConfigVars(vars) {
    return vars.filter((v) => v.category === TELEMETRY_CATEGORY && v.runtimeEditable !== true);
  }
  function sumByPrefix(metrics2, prefix, filter) {
    let total = 0;
    for (const [key, value] of Object.entries(metrics2)) {
      if (!key.startsWith(prefix)) continue;
      if (filter && !key.includes(filter)) continue;
      total += value;
    }
    return total;
  }

  // pure:packages/web/src/pdl/useOpsBindings.ts
  function runtimeBody(page) {
    if ('messages' in page)
      return {
        raw: '',
        rows: page.messages.map((m) => ({
          id: String(m.eventNo),
          text: 'oversized' in m ? null : m.content,
          number: m.eventNo,
          role: m.role,
          timestamp: m.timestamp,
          oversized: 'oversized' in m,
          contentLength: m.contentLength,
        })),
      };
    if ('invocations' in page)
      return {
        raw: '',
        rows: page.invocations.map((i) => ({
          ...i,
          id: i.invocationId,
          text: i.invocationId,
          number: i.eventCount,
          events: i,
        })),
      };
    return { raw: JSON.stringify(page.events, null, 2), rows: [] };
  }
  var sections = ['quota', 'lb', 'obs', 'daemon', 'rt', 'gov', 'brake', 'cmd', 'rescue'];

  // pure:packages/web/src/components/shell/shell-copy.ts
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  }

  // pure:packages/web/src/components/paw-feel/paw-feel.shell-copy.ts

  // pure:packages/web/src/components/eval-workspace/eval-workspace.shell-copy.ts

  // pure:packages/web/src/components/eval-workspace/eval-detail.shell-copy.ts

  // pure:packages/web/src/components/eval-lifecycle-display.ts

  function currentEvalDueAt(item) {
    return item.lifecycle.availability === 'available' ? item.lifecycle.reevalDueAt : item.reeval.nextEvalAt;
  }

  // pure:packages/web/src/components/eval-workspace/evalWorkspaceEvents.ts
  function deriveEvalWorkspaceEvents(summary) {
    const domains = new Map(summary.domains.map((domain) => [domain.domainId, domain]));
    const activeVerdictIds = new Set(
      summary.domains.flatMap((domain) => (domain.latestVerdictId ? [domain.latestVerdictId] : [])),
    );
    return summary.items
      .filter((item) => activeVerdictIds.has(item.id))
      .map((item) => toWorkspaceEvent(item, requireDomainSummary(item, domains)))
      .sort(compareEvents);
  }
  function requireDomainSummary(item, domains) {
    const domain = domains.get(item.domainId);
    if (!domain) throw new Error(`Eval Hub item ${item.id} references unknown domain ${item.domainId}`);
    return domain;
  }
  function toWorkspaceEvent(item, domain) {
    const kind = deriveEventKind(item);

    const nextEvalAt = currentEvalDueAt(item);
    return {
      id: item.id,
      domainId: item.domainId,
      domainDisplayName: domain.displayName,
      kind,
      severity: severityFor(kind),
      verdict: item.verdict,
      title: item.operatorNarrative.headline,
      summary: item.operatorNarrative.summary,
      action: item.operatorNarrative.action,
      nextCheck: item.operatorNarrative.nextCheck,
      ...(nextEvalAt ? { nextEvalAt } : {}),
      ...(domain.metricGlossary ? { metricGlossary: domain.metricGlossary } : {}),
      lifecycle: item.lifecycle,
      stale: item.lifecycle.stale,
      source: item.source,
      systemThreadId: domain.systemThreadId,
    };
  }
  function deriveEventKind(item) {
    const status = item.lifecycle.closureStatus;
    if (
      status !== 'escalated' &&
      status !== 'resolved' &&
      status !== 'suppressed_with_reason' &&
      (item.lifecycle.stale || item.lifecycle.reevalStatus === 'pending' || item.reeval.status === 'pending_reeval')
    ) {
      return 'awaiting_reeval';
    }
    switch (status) {
      case 'escalated':
        return 'escalated';
      case 'resolved':
      case 'suppressed_with_reason':
        return 'resolved';
      case 'reeval_pending':
      case 'live_active':
        return 'awaiting_reeval';
      case 'monitoring':
        return item.lifecycle.reevalDebtStatus === 'due' || item.lifecycle.reevalDebtStatus === 'in_progress'
          ? 'awaiting_reeval'
          : 'watching';
      case 'open':
      case 'acknowledged':
      case 'action_planned':
      case 'fix_landed':
      case 'main_landed':
        return item.verdict === 'delete_sunset' ? 'needs_decision' : 'needs_action';
      case 'observing':
      case 'unavailable':
        if (item.verdict === 'delete_sunset') return 'needs_decision';
        if (item.verdict === 'fix' || item.verdict === 'build') return 'needs_action';
        return 'watching';
    }
  }
  function severityFor(kind) {
    if (kind === 'escalated') return 'critical';
    if (kind === 'needs_decision') return 'critical';
    if (kind === 'needs_action') return 'attention';
    if (kind === 'awaiting_reeval') return 'attention';
    return 'info';
  }
  function compareEvents(a, b) {
    const rank = {
      escalated: 0,
      needs_decision: 1,
      needs_action: 2,
      awaiting_reeval: 3,
      resolved: 4,
      watching: 5,
    };
    return rank[a.kind] - rank[b.kind] || a.domainDisplayName.localeCompare(b.domainDisplayName);
  }

  // pure:packages/web/src/components/workspace/trajectory/invocation-evidence-ref.ts
  function invocationIdFromEvidenceRef(value) {
    const match = /^inv:([^:\s]+)$/.exec(value.trim());
    return match?.[1];
  }

  // pure:packages/web/src/components/workspace-home/format.ts

  // pure:packages/web/src/pdl/useEvaluationBindings.ts

  // pure:packages/web/src/components/settings/service-ui-adapter.ts

  function adaptServiceState(home) {
    const installed = home.installed;
    const enabled = home.enabled;
    const running = home.status === 'healthy';
    let status;
    if (
      home.status === 'installing' ||
      home.status === 'starting' ||
      home.status === 'stopping' ||
      home.status === 'uninstalling'
    ) {
      status = home.status;
    } else if (!installed) {
      status = 'not_configured';
    } else if (!home.installable) {
      status = running ? 'running' : home.configured ? 'error' : 'not_configured';
    } else if (enabled && running) {
      status = 'running';
    } else if (enabled) {
      status = 'error';
    } else {
      status = 'stopped';
    }
    return {
      id: home.id,
      name: home.name,
      description: home.description,
      category: home.category,
      endpoint: home.endpoint,
      features: home.features,
      status,

      installed,
      enabled,
      selectedModel: home.selectedModel,
      port: home.port,
      installable: home.installable,
      running,
      prerequisites: home.prerequisites,
      error: (installed && enabled) || !home.installable ? home.error : void 0,
    };
  }

  // packages/web/src/utils/voice-terms.json
  var voice_terms_default = {
    _comment_cats: '=== 猫名 & 团队 ===',
    免因猫: '缅因猫',
    面因猫: '缅因猫',
    棉因猫: '缅因猫',
    绵因猫: '缅因猫',
    免疫猫: '缅因猫',
    先罗猫: '暹罗猫',
    暹逻猫: '暹罗猫',
    仙罗猫: '暹罗猫',
    暄罗猫: '暹罗猫',
    暄罗: '暹罗',
    产屎官: 'co-creator',
    铲史官: 'co-creator',
    铲是官: 'co-creator',
    不偶猫: '布偶猫',
    不偶: '布偶',
    献献: '宪宪',
    先先: '宪宪',
    嫌嫌: '宪宪',
    咸咸: '宪宪',
    现现: '宪宪',
    弦弦: '宪宪',
    险险: '宪宪',
    闲闲: '宪宪',
    严严: '砚砚',
    言言: '砚砚',
    烟烟: '砚砚',
    眼眼: '砚砚',
    艳艳: '砚砚',
    雁雁: '砚砚',
    燕燕: '砚砚',
    研研: '砚砚',
    岩岩: '砚砚',
    _comment_models: '=== AI 模型 & 品牌 ===',
    icp: 'MCP',
    克劳德: 'Claude',
    科德斯: 'Codex',
    科迪克斯: 'Codex',
    奥普斯: 'Opus',
    欧普斯: 'Opus',
    桑奈特: 'Sonnet',
    索奈特: 'Sonnet',
    海酷: 'Haiku',
    嗨库: 'Haiku',
    杰米尼: 'Gemini',
    杰明尼: 'Gemini',
    安索皮克: 'Anthropic',
    _comment_frameworks: '=== 框架 & 库 ===',
    法式的: 'Fastify',
    法斯特发一: 'Fastify',
    为的: 'void',
    那的js: 'Node.js',
    'type script': 'TypeScript',
    组单的: 'Zustand',
    锐的死: 'Redis',
    瑞迪斯: 'Redis',
    威士伯: 'Whisper',
    泰尔温: 'Tailwind',
    泰欧温德: 'Tailwind',
    太温的: 'Tailwind',
    优维康: 'uvicorn',
    尤维肯: 'uvicorn',
    _comment_tools: '=== 工具 & CLI ===',
    'cloud cold': 'Claude Code',
    'cloud code': 'Claude Code',
    QQ面试: 'Claude Code',
    克劳德code: 'Claude Code',
    克劳德cold: 'Claude Code',
    'work tree': 'worktree',
    're base': 'rebase',
    'fast api': 'FastAPI',
    'web socket': 'WebSocket',
    'web sockets': 'WebSocket',
    _comment_project: '=== 项目术语 ===',
    亨德赛特: 'Hindsight',
    海恩赛特: 'Hindsight',
    海因赛特: 'Hindsight',
  };

  // pure:packages/web/src/pdl/useVoiceBindings.ts
  function sourceOptions(sources) {
    return [
      ...sources.mics.map((x) => ({
        id: `mic:${x.index}`,
        name: x.name,
        input: { id: `mic-${x.index}`, source: 'mic', device: x.index, label: x.name },
      })),
      ...sources.apps.map((x) => ({
        id: `app:${x.id}`,
        name: x.name,
        input: { id: x.id, source: 'app', app_name: x.name, label: x.name },
      })),
    ];
  }

  // pure:packages/shared/src/profile-opening-reference.ts
  function splitProfileBody(content) {
    const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
    return match ? { prefix: match[0], body: content.slice(match[0].length) } : { prefix: '', body: content };
  }

  // pure:packages/web/src/pdl/useMemoryBindings.tsx
  var paths = {
    person: '/api/memory/people',
    profile: '/api/memory/profile',
    event: '/api/memory/events',
    entity: '/api/memory/entities',
    taste: '/api/memory/taste',
  };

  // pure:packages/web/src/components/memory/IndexStatus.tsx
  function parseIndexStatus(raw) {
    return {
      backend: raw.backend,
      healthy: raw.healthy,
      docsCount: raw.docs_count ?? 0,
      vectorsCount: raw.vectors_count ?? 0,
      threadsCount: raw.threads_count ?? 0,
      passagesCount: raw.passages_count ?? 0,
      passageVectorsCount: raw.passage_vectors_count ?? 0,
      passageVectorsSupported: raw.passage_vectors_supported ?? false,
      passageWarmupActive: raw.passage_warmup_active ?? false,
      edgesCount: raw.edges_count ?? 0,
      lastRebuildAt: raw.last_rebuild_at ?? null,
      lastDocumentUpdatedAt: raw.last_document_updated_at ?? null,
      embeddingModel: raw.embedding_model ?? null,
      reason: raw.reason,
      functionalStatus: raw.functionalStatus ?? 'ok',
      configWarnings: raw.configWarnings ?? [],
    };
  }

  // pure:packages/web/src/components/memory/graph-layout.ts
  function forceLayout(nodes, edges, center, width, height) {
    if (nodes.length === 0) return /* @__PURE__ */ new Map();
    const useHubLayout = usesReadableHubLayout(nodes, edges, center);
    const layoutHeight = useHubLayout ? readableHubLayoutHeight(nodes.length, height) : height;
    if (useHubLayout && center) return readableHubLayout(nodes, center, width, layoutHeight);
    const cx = width / 2;
    const cy = layoutHeight / 2;
    const sim = nodes.map((n, i) => {
      if (n.anchor === center) return { x: cx, y: cy, vx: 0, vy: 0 };
      const a = (2 * Math.PI * i) / Math.max(nodes.length, 1);
      return { x: cx + 120 * Math.cos(a), y: cy + 120 * Math.sin(a), vx: 0, vy: 0 };
    });
    const idx = /* @__PURE__ */ new Map();
    for (let i = 0; i < nodes.length; i++) idx.set(nodes[i].anchor, i);
    simulateForces(sim, edges, idx, width, layoutHeight, cx, cy);
    const result = /* @__PURE__ */ new Map();
    for (let i = 0; i < nodes.length; i++) result.set(nodes[i].anchor, { x: sim[i].x, y: sim[i].y });
    return result;
  }
  function simulateForces(sim, edges, idx, width, height, cx, cy) {
    for (let t = 0; t < 120; t++) {
      applyRepulsion(sim);
      applyEdgePull(sim, edges, idx);
      settle(sim, width, height, cx, cy);
    }
  }
  function applyRepulsion(sim) {
    for (let i = 0; i < sim.length; i++) {
      for (let j = i + 1; j < sim.length; j++) {
        const dx = sim[i].x - sim[j].x;
        const dy = sim[i].y - sim[j].y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const f = 5e3 / (d * d);
        sim[i].vx += (dx / d) * f;
        sim[i].vy += (dy / d) * f;
        sim[j].vx -= (dx / d) * f;
        sim[j].vy -= (dy / d) * f;
      }
    }
  }
  function applyEdgePull(sim, edges, idx) {
    for (const e of edges) {
      const ai = idx.get(e.from);
      const bi = idx.get(e.to);
      if (ai === void 0 || bi === void 0) continue;
      const dx = sim[bi].x - sim[ai].x;
      const dy = sim[bi].y - sim[ai].y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const disp = d - 160;
      sim[ai].vx += 0.01 * disp * (dx / d);
      sim[ai].vy += 0.01 * disp * (dy / d);
      sim[bi].vx -= 0.01 * disp * (dx / d);
      sim[bi].vy -= 0.01 * disp * (dy / d);
    }
  }
  function settle(sim, width, height, cx, cy) {
    const pad = 40;
    for (const p of sim) {
      p.vx = (p.vx + (cx - p.x) * 0.01) * 0.8;
      p.vy = (p.vy + (cy - p.y) * 0.01) * 0.8;
      p.x = Math.max(pad, Math.min(width - pad, p.x + p.vx));
      p.y = Math.max(pad, Math.min(height - pad, p.y + p.vy));
    }
  }
  function readableHubLayout(nodes, center, width, height) {
    const result = /* @__PURE__ */ new Map();
    const cx = width / 2;
    const cy = height / 2;
    result.set(center, { x: cx, y: cy });
    const outer = nodes.filter((node) => node.anchor !== center);
    const left = [];
    const right = [];
    for (let i = 0; i < outer.length; i++) {
      (i % 2 === 0 ? left : right).push(outer[i]);
    }
    assignColumnGroup(result, left, leftColumnXs(width), height);
    assignColumnGroup(result, right, rightColumnXs(width), height);
    return result;
  }
  var MIN_DENSE_ROW_GAP = 48;
  var DENSE_VERTICAL_PAD = 40;
  var DENSE_LANES_PER_SIDE = 1;
  function usesReadableHubLayout(nodes, edges, center) {
    if (!center || nodes.length <= 10) return false;
    const outerAnchors = new Set(nodes.filter((node) => node.anchor !== center).map((node) => node.anchor));
    if (outerAnchors.size === 0) return false;
    const centerNeighbors = /* @__PURE__ */ new Set();
    for (const edge of edges) {
      if (edge.from === center && outerAnchors.has(edge.to)) centerNeighbors.add(edge.to);
      if (edge.to === center && outerAnchors.has(edge.from)) centerNeighbors.add(edge.from);
    }
    const minimumHubDegree = Math.min(8, Math.ceil(outerAnchors.size * 0.6));
    return centerNeighbors.size >= minimumHubDegree && centerNeighbors.size / outerAnchors.size >= 0.6;
  }
  function readableHubLayoutHeight(nodeCount, baseHeight) {
    if (nodeCount <= 10) return baseHeight;
    const outerCount = Math.max(0, nodeCount - 1);
    const maxSideCount = Math.ceil(outerCount / 2);
    const rowsPerSide = Math.max(1, Math.ceil(maxSideCount / DENSE_LANES_PER_SIDE));
    const requiredHeight = DENSE_VERTICAL_PAD * 2 + (rowsPerSide - 1) * MIN_DENSE_ROW_GAP;
    return Math.max(baseHeight, requiredHeight);
  }
  function leftColumnXs(width) {
    return [width * 0.2];
  }
  function rightColumnXs(width) {
    return [width * 0.8];
  }
  function assignColumnGroup(result, nodes, xPositions, height) {
    if (nodes.length === 0) return;
    const top = DENSE_VERTICAL_PAD;
    const bottom = height - DENSE_VERTICAL_PAD;
    const maxRows = Math.max(1, Math.floor((bottom - top) / MIN_DENSE_ROW_GAP) + 1);
    const laneCount = Math.min(xPositions.length, Math.ceil(nodes.length / maxRows));
    const laneSize = Math.ceil(nodes.length / laneCount);
    for (let lane = 0; lane < laneCount; lane++) {
      const start = lane * laneSize;
      const laneNodes = nodes.slice(start, start + laneSize);
      assignColumn(result, laneNodes, xPositions[lane], height);
    }
  }
  function assignColumn(result, nodes, x, height) {
    if (nodes.length === 0) return;
    const top = DENSE_VERTICAL_PAD;
    const bottom = height - DENSE_VERTICAL_PAD;
    const step = nodes.length === 1 ? 0 : (bottom - top) / (nodes.length - 1);
    for (let i = 0; i < nodes.length; i++) {
      result.set(nodes[i].anchor, { x, y: nodes.length === 1 ? height / 2 : top + step * i });
    }
  }

  // pure:packages/web/src/components/memory/page/library-labels.ts

  // pure:packages/web/src/components/memory/page/memory-time.ts

  // pure:packages/web/src/components/memory/page/use-memory-read.ts

  // pure:packages/web/src/components/memory/page/brake-model.ts
  function groupHumanBrakes(events) {
    const groups = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    for (const event of events) {
      if (event.trigger !== 'human_brake' || event.confidence === 'low' || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      const key = event.threadId && event.messageId ? JSON.stringify([event.threadId, event.messageId]) : event.eventId;
      let row = groups.get(key);
      if (!row) {
        row = {
          key,
          sourceEventId: event.eventId,
          threadId: event.threadId,
          messageId: event.messageId,
          timestamp: event.timestamp,
          summary: event.summary,
          words: [],
          cats: [],
          rules: [],
        };
        groups.set(key, row);
      }
      row.words = [.../* @__PURE__ */ new Set([...row.words, event.type])];
      row.cats = [.../* @__PURE__ */ new Set([...row.cats, event.cat])];
      row.rules = [.../* @__PURE__ */ new Set([...row.rules, ...(event.relatedHarness ?? [])])];
      if (event.summary.length > row.summary.length) row.summary = event.summary;
      row.timestamp = Math.max(row.timestamp, event.timestamp);
    }
    return [...groups.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  // owner-projections.ts
  function ownerExplorationWorkspace(resource, owner) {
    const saved = CS.evolutionReading.current[owner.program.programId] || {},
      reading = saved.exploration || DEFAULT_EXPLORATION;
    const catalog = resource.catalog,
      node = resolveNode(catalog, reading.selectedNodeRef, saved.selectedVersionRef);
    const experiments = node
      ? (catalog?.experiments.filter((run) => refIdentity(run.nodeRef) === refIdentity(node.nodeRef)) || []).sort(
          (a, b) => (isHistoricalStep(node) ? a.conditions.window.label.localeCompare(b.conditions.window.label) : 0),
        )
      : [];
    const experiment =
      !reading.selectedExperimentRef && isHistoricalStep(node)
        ? experiments[0]
        : selectExperiment(catalog, experiments, reading.selectedExperimentRef);
    const detail = resource.review?.details.find(
      (entry) => refIdentity(entry.experimentRef) === (experiment && refIdentity(experiment.experimentRef)),
    );
    const records = detail?.status === 'resolved' ? detail.records : [];
    const compareExperiment = reading.comparisonExperimentRef
      ? catalog?.experiments.find(
          (run) => refIdentity(run.experimentRef) === refIdentity(reading.comparisonExperimentRef),
        )
      : void 0;
    const compareDetail = compareExperiment
      ? resource.review?.details.find(
          (entry) => refIdentity(entry.experimentRef) === refIdentity(compareExperiment.experimentRef),
        )
      : void 0;
    const comparison =
      experiment && compareExperiment && compareDetail?.status === 'resolved'
        ? compareExplorationRecords(
            { experiment: compareExperiment, records: compareDetail.records },
            { experiment, records },
            reading.comparisonScope,
            reading.comparisonScopeKey,
          )
        : void 0;
    return {
      resource,
      reading,
      catalog,
      node,
      experiments,
      experiment,
      detail,
      compareExperiment,
      compareDetail,
      comparison,
      publicationError: resource.publicationError,
    };
  }
  function projectTeam(raw = chatDataSnapshot.project.team) {
    const data = chatDataSnapshot.chat,
      ui = S.ws,
      model = raw.value;
    if (!model) return { teamPreferences: [], cafeWsTeam: { load: raw.error ? 'error' : 'loading' } };
    const heads = preferenceHeads(model.preferenceRevisions),
      fresh = model.resolution.state === 'fresh',
      candidates = fresh ? model.resolution.snapshot.candidates : [],
      rows = candidates.map((c) =>
        toTeamMemberRow(
          c,
          data.cats.find((m) => m.id === c.binding.catId),
        ),
      ),
      current = ui.teamByThread[data.threadId] ?? { q: '', f: 'all' };
    const member = (id) => {
      const c = data.cats.find((m) => m.id === id);
      return {
        id,
        name: c ? c.nickname || c.displayName : id,
        handle: c ? c.mentionPatterns[0] : '',
        breed: c && c.breedDisplayName,
        model: c && c.defaultModel,
      };
    };
    const row = (r) => ({
      ...member(r.identity.catId),
      who: r.identity.catId,
      availability: r.availability.availability,
      hasProfile: r.capability.state === 'applied',
      good: r.capability.state === 'applied' ? r.capability.fitSignals[0] : '',
      act: 'wsSub',
      args: { k: 'team', v: 'm:' + r.identity.catId },
    });
    const grouped = new Map();
    rows.forEach((r) => {
      const id = r.candidate.binding.providerId;
      grouped.set(id, [...(grouped.get(id) ?? []), r]);
    });
    const signal = (subject, affected) => ({
      subj: routingSubjectKey(subject),
      count: affected.length,
      affected: affected.map((r) => member(r.identity.catId)),
      rows: openRoutingSignalsForSubject(model.signalEvents, subject).map((e) => ({
        id: e.eventId,
        state: e.state,
        reason: e.reasonCode,
        until: e.validUntil ?? e.resetAt,
        expired: Math.min(e.validUntil ?? Infinity, e.resetAt ?? Infinity) <= model.observedAt,
      })),
    });
    const common = {
      load: raw.error ? 'stale' : raw.loading ? 'loading' : '',
      view: ui.teamV,
      ruleN: heads.filter((p) => p.lifecycle === 'active').length,
    };
    if (ui.teamSub) {
      const id = ui.teamSub.slice(2);
      if (!fresh) return { teamPreferences: heads, cafeWsTeam: { load: 'error' } };
      if (ui.teamSub.startsWith('p:')) {
        const list = grouped.get(id);
        return {
          teamPreferences: heads,
          cafeWsTeam: {
            ...common,
            detail: {
              p: { name: id, count: list.length, rows: list.map(row) },
              signal: signal({ type: 'provider', providerId: id }, list),
            },
          },
        };
      }
      const r = rows.find((r) => r.identity.catId === id),
        cap = r.capability;
      return {
        teamPreferences: heads,
        cafeWsTeam: {
          ...common,
          detail: {
            m: {
              ...member(id),
              to: 'member-' + id,
              av: r.candidate.availability,
              prof:
                cap.state === 'applied'
                  ? {
                      good: cap.fitSignals,
                      care: cap.watchOuts,
                      date: cap.revision.updatedAt,
                      hasDate: cap.revision.updatedAt > 0,
                    }
                  : null,
              techKey: 'tm-tech-' + id,
              tech: {
                provider: r.candidate.binding.providerId,
                hasProvider: !!r.candidate.binding.providerId,
                version: cap.state === 'applied' ? cap.revision.dossierRevision : null,
                evidence: cap.state === 'applied' ? cap.revision.relevantSignals.flatMap((s) => s.evidenceRefs) : [],
                reasons: r.candidate.reasons,
              },
            },
            signal: signal({ type: 'cat', catId: id }, [r]),
          },
        },
      };
    }
    if (ui.teamV === 'prefs')
      return {
        teamPreferences: heads,
        cafeWsTeam: {
          ...common,
          isPrefs: true,
          prefs: heads.map((p) => ({
            ...p,
            id: p.preferenceId,
            why: p.rationale,
            life: p.lifecycle,
            ver: p.version,
            active: p.lifecycle === 'active',
          })),
        },
      };
    if (ui.teamV === 'prov')
      return {
        teamPreferences: heads,
        cafeWsTeam: {
          ...common,
          isProv: true,
          prov: [...grouped].map(([id, list]) => ({
            name: id,
            count: list.length,
            bad: list.filter(
              (r) => r.availability.availability !== 'available' && r.availability.availability !== 'unknown',
            ).length,
            unknown: list.filter((r) => r.availability.availability === 'unknown').length,
            hasUnknown: list.some((r) => r.availability.availability === 'unknown'),
            act: 'wsSub',
            args: { k: 'team', v: 'p:' + id },
          })),
        },
      };
    if (ui.teamV === 'ledger')
      return {
        teamPreferences: heads,
        cafeWsTeam: {
          ...common,
          ledger: {
            eventCount: model.signalEvents.length,
            versionCount: model.preferenceRevisions.length,
            events: model.signalEvents.map((e) => ({
              ...e,
              provider: e.subjectRef.type === 'provider',
              ...member(e.subjectRef.catId || e.subjectRef.providerId),
              event: e.eventType,
              reason: e.reasonCode,
              by: e.source,
              until: e.validUntil ?? e.resetAt,
              id: e.eventId,
              duration: !!(e.validUntil || e.resetAt),
            })),
            versions: model.preferenceRevisions.map((p) => ({ ...p, initial: false, revision: p.revisionId })),
          },
        },
      };
    const counts = countTeamMembers(rows),
      visible = filterTeamMembers(rows, { query: current.q, filter: current.f === 'noProfile' ? 'absent' : current.f }),
      degraded = !fresh;
    return {
      teamPreferences: heads,
      cafeWsTeam: {
        ...common,
        roster: {
          thr: data.threadId,
          q: current.q,
          f: current.f,
          degraded,
          reason: degraded ? model.resolution.reason : null,
          affected: rows
            .filter((r) => r.availability.availability !== 'available')
            .slice(0, 2)
            .map((r) => member(r.identity.catId)),
          counts: { all: counts.all, attention: counts.attention, noProfile: counts.absent },
          items: degraded
            ? model.resolution.candidateBindings.map((b) => ({
                ...member(b.catId),
                who: b.catId,
                provider: b.providerId,
                degraded: true,
              }))
            : visible.map(row),
        },
      },
    };
  }
  globalThis.projectTeam = projectTeam;
  globalThis.projectMemberAvailability = (id) => {
    const model = chatDataSnapshot.project.team.value;
    if (!model || model.resolution.state !== 'fresh') return 'unknown';
    const candidate = model.resolution.snapshot.candidates.find((c) => c.binding.catId === id);
    return candidate ? candidate.availability : 'unknown';
  };
  function projectSignals(raw = chatDataSnapshot.project.signals) {
    const { read, detail, fetching, discussion, playing } = raw,
      ui = S.ws,
      common = { load: read.load, view: ui.sigView },
      base = { signalArticles: read.articles, signalSources: read.sources, signalDiscussion: discussion };
    if (ui.sigDetail) {
      const a = detail.article,
        meta = detail.meta;
      if (detail.id !== ui.sigDetail || !a || !meta || !detail.collections)
        return { ...base, cafeWsSignals: { load: detail.id === ui.sigDetail ? detail.load : 'loading' } };
      const pods = meta.artifacts.filter((p) => p.kind === 'podcast' && p.state === 'ready'),
        pod = detail.podcast;
      return {
        ...base,
        signalArticles: [a, ...read.articles.filter((x) => x.id !== a.id)],
        cafeWsSignals: {
          load: detail.load,
          detail: {
            id: a.id,
            title: a.title,
            source: read.sources.find((s) => s.id === a.source)?.name ?? a.source,
            state: a.status,
            tier: a.tier,
            time: a.publishedAt,
            year: new Date(a.publishedAt).getFullYear(),
            sum: a.summary,
            body: a.content,
            tags: a.tags.map((t) => ({ id: t, name: t })),
            note: a.note,
            study: meta.threads.length + meta.artifacts.length,
            lastStudyAt: meta.lastStudiedAt,
            links: meta.threads.map((t) => ({ id: t.threadId, thread: t.threadId, stale: t.stale, at: t.linkedAt })),
            notes: meta.artifacts
              .filter((n) => n.kind === 'note' && n.state === 'ready')
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((n) => ({ v: n.id, id: n.id, at: n.createdAt })),
            noteKey: 'signal-note-' + a.id + '-' + (detail.note?.id ?? ''),
            noteId: detail.note?.id ?? '',
            noteDoneAt: detail.note?.at,
            noteSum: detail.note?.content,
            reports: meta.artifacts
              .filter((r) => r.kind === 'research-report')
              .map((r) => ({
                id: r.id,
                title: typeof r.metadata?.title === 'string' ? r.metadata.title : r.id,
                state: r.state,
                at: r.createdAt,
              })),
            pods: pods.map((p, i) => ({ v: i, id: p.id, on: i === (ui.pod ?? 0) })),
            podGen: meta.artifacts.find((p) => p.kind === 'podcast' && p.state !== 'ready')?.state,
            pod: pod
              ? {
                  kind: pod.mode,
                  count: pod.segments.length,
                  minutes: pod.totalDuration / 60,
                  playing: ui.playAll,
                  segs: pod.segments.map((s, i) => ({
                    id: String(i),
                    i,
                    speaker: s.speaker,
                    text: s.text,
                    src: s.audioUrl ? api.file(s.audioUrl) : '',
                    playing: playing.index === i && playing.state === 'playing',
                  })),
                }
              : null,
            sets: detail.collections.filter((c) => c.articleIds.includes(a.id)).map((c) => ({ chip: c.name })),
            setOpts: detail.collections
              .filter((c) => !c.articleIds.includes(a.id))
              .map((c) => ({ v: c.id, label: c.name })),
          },
        },
      };
    }
    if (ui.sigView === 'sources')
      return {
        ...base,
        cafeWsSignals: {
          ...common,
          sources: {
            fetchRes: ui.fetchRes,
            groups: groupSignalSourcesByTierAndCategory(read.sources).map((g) => ({
              tier: g.tier,
              category: g.category,
              count: g.sources.length,
              rows: g.sources.map((s) => ({
                ...s,
                busy: fetching === s.id,
                method: s.fetch.method,
                frequency: s.schedule.frequency,
              })),
            })),
          },
        },
      };
    if (ui.sigView === 'timeline') {
      const groups = new Map();
      for (const e of read.timeline) {
        const day = e.lastStudiedAt.slice(0, 10);
        groups.set(day, [...(groups.get(day) ?? []), e]);
      }
      return {
        ...base,
        cafeWsSignals: {
          ...common,
          timeline: {
            days: ui.tlDays,
            empty: !read.timeline.length,
            groups: [...groups].map(([day, rows]) => ({
              day,
              rows: rows.map((e) => ({
                id: e.articleId,
                title: e.articleTitle,
                time: e.lastStudiedAt,
                source: e.source,
                artifacts: e.artifacts,
                threads: e.threads,
              })),
            })),
          },
        },
      };
    }
    return {
      ...base,
      cafeWsSignals: {
        ...common,
        list: {
          q: ui.sigQ,
          fst: ui.sigSt,
          ftier: ui.sigTier,
          fsrc: ui.sigSrc,
          srcs: read.sources.map((s) => ({ v: s.id, label: s.name })),
          nSel: Object.values(ui.sigSel).filter(Boolean).length,
          count: read.articles.length,
          today: read.stats?.todayCount,
          unread: read.stats?.unreadCount,
          week: read.stats?.weekCount,
          items: read.articles.map((a) => ({
            ...a,
            id: a.id,
            checked: !!ui.sigSel[a.id],
            selected: !!ui.sigSel[a.id],
            source: read.sources.find((s) => s.id === a.source)?.name ?? a.source,
            time: a.publishedAt,
            year: new Date(a.publishedAt).getFullYear(),
            state: a.status,
          })),
        },
      },
    };
  }
  globalThis.projectSignals = projectSignals;
  function projectEvolution(raw = chatDataSnapshot.project.evolution) {
    const { query, requests, explorationRequests } = raw;
    const ui = S.ws;
    const exact = raw.exact.id === ui.evoId ? raw.exact : { projection: null, loading: false, error: null };
    const assets = raw.assets.programId === ui.evoId ? raw.assets : { loading: false, error: null };
    const API_URL2 = api.file('/').slice(0, -1);
    const projection = () =>
      exact.projection?.program.programId === ui.evoId
        ? exact.projection
        : query.programs.find((p) => p.program.programId === ui.evoId) || null;
    const workspace =
      raw.exploration?.programId === ui.evoId && ownerExplorationWorkspace(raw.exploration, projection());
    const rows = query.programs.map((p) => ({
      id: p.program.programId,
      title: p.program.displayName,
      who: p.origin?.createdByCatId,
      lead: p.origin?.createdByCatId ? { who: p.origin.createdByCatId, form: 'avatar', size: 'm' } : null,
      stage: p.program.stage,
      lifecycle: p.program.lifecycle,
      origin: p.origin?.title,
      act: 'wsSub',
      args: { k: 'evolution', v: p.program.programId },
    }));
    const owner = projection();
    const request = owner ? requests.records[progressRequestKey(owner)] : null;
    const selected = assets.review?.status === 'resolved' ? assets.review.selected : void 0;
    const title = (ref) => assets.catalog?.versions.find((v) => refIdentity(v.versionRef) === refIdentity(ref))?.title;
    return {
      evolutionOwner: owner,
      evolutionExploration: owner && workspace ? explorationModel(owner, workspace) : null,
      evolutionAssets: {
        load: assets.error ? 'error' : assets.loading ? 'loading' : '',
        catalog: assets.catalog,
        error: assets.error,
        selected,
        selectedTitle: selected ? title(selected.versionRef) : void 0,
        versions: owner
          ? projectAssetVersions(owner, assets.catalog).map((v) => ({
              ...v,
              title: title(v.ref),
            }))
          : [],
        diff: currentVersionDiff(selected, assets.catalog),
      },
      evolutionCanDecide: owner ? canDecideChange(owner, owner.lineage?.current) : false,
      evolutionProgress: {
        state: request?.receipt?.status || '',
        error: owner
          ? requests.errors[progressRequestKey(owner)] ||
            Object.values(explorationRequests.records)
              .filter((record) => record.context.programId === owner.program.programId)
              .map((record) => explorationRequests.errors[record.clientMessageId])
              .find(Boolean)
          : null,
      },
      cafeWsEvo: {
        load: ui.evoId
          ? exact.error || assets.error
            ? 'error'
            : exact.loading || assets.loading
              ? 'loading'
              : ''
          : query.error || query.rejected
            ? 'error'
            : query.loading
              ? 'loading'
              : '',
        activeCount: rows.filter((p) => p.lifecycle !== 'terminal').length,
        active: rows.filter((p) => p.lifecycle !== 'terminal'),
        done: rows.filter((p) => p.lifecycle === 'terminal'),
      },
    };
  }
  globalThis.projectEvolution = projectEvolution;
  function projectOps(raw = chatDataSnapshot.project.ops) {
    const read = raw.read,
      data = { ...chatDataSnapshot.chat, threads: sidebarSnapshot.threads },
      ui = S.ws,
      { opsView, obsV, lbRange, toolCat, toolType, toolRange, rtView, rtTab = 'chat', rtPage = 1 } = ui,
      key = JSON.stringify([
        opsView,
        obsV,
        lbRange,
        toolCat,
        toolType,
        toolRange,
        data.threadId,
        rtView,
        rtTab,
        rtPage,
      ]),
      source = read.key === key ? read.value : undefined,
      common = { cur: opsView, sections: sections, load: read.key === key ? read.load : 'loading' };
    if (!source) return { cafeWsOps: common };
    const member = (id) => {
      const c = data.cats.find((c) => c.id === id);
      return { id, name: c ? c.nickname || c.displayName : id, handle: c ? c.mentionPatterns[0] : '' };
    };
    if (source.daemon)
      return {
        cafeWsOps: {
          ...common,
          daemon: {
            has: !!source.daemon.length,
            rows: source.daemon.map((s) => ({
              ...s,
              id: s.daemonShortId,
              attachCmd: 'claude attach ' + s.daemonShortId,
            })),
            diag: source.daemon.map((s) => ({ id: s.daemonShortId, detail: s.detail, state: s.state })),
          },
        },
      };
    if (opsView === 'cmd')
      return {
        cafeWsOps: {
          ...common,
          cmd: COMMAND_CATEGORIES.map((category) => ({
            category,
            items: COMMANDS.filter((c) => c.category === category).map((c) => ({
              command: c.usage,
              name: c.name,
              description: c.description,
            })),
          })),
        },
      };
    if (source.brake)
      return {
        opsBrakeSettings: source.brake,
        cafeWsOps: {
          ...common,
          brake: {
            on: source.brake.enabled,
            minutes: source.brake.thresholdMinutes,
            mode: source.brake.mode,
            hard: source.brake.mode === 'hardcore',
          },
        },
      };
    if (source.rescue)
      return {
        cafeWsOps: {
          ...common,
          rescue: {
            scanning: read.load === 'loading',
            found: !!source.rescue.length,
            count: source.rescue.filter((r) => ui.rescueSel?.[r.sessionId]).length,
            none: !source.rescue.some((r) => ui.rescueSel?.[r.sessionId]),
            rows: source.rescue.map((r) => ({ ...r, id: r.sessionId, selected: !!ui.rescueSel?.[r.sessionId] })),
            last: raw.rescueRun,
          },
        },
      };
    if (source.governance) {
      const selected = source.governance.find((p) => p.projectPath === ui.govPath),
        g = ui.gov || {},
        prev = raw.governance?.path === ui.govPath ? raw.governance : null;
      return {
        cafeWsOps: {
          ...common,
          gov: selected
            ? {
                d: {
                  path: selected.projectPath,
                  version: selected.packVersion,
                  status: selected.status,
                  uninstalled: selected.status === 'never-synced',
                  install: g,
                  noneChecked: !g.guide && !g.skills && !g.docs,
                  prev: prev
                    ? {
                        undo: prev.operation === 'cleanup',
                        count: prev.report.actions.filter((a) => a.action !== 'skipped').length,
                        rows: prev.report.actions.map((a) => ({ operation: a.action, path: a.file, reason: a.reason })),
                      }
                    : null,
                },
              }
            : {
                list: true,
                rows: source.governance.map((p) => ({
                  id: p.projectPath,
                  path: p.projectPath,
                  status: p.status,
                  version: p.packVersion,
                  at: p.lastSyncedAt,
                })),
              },
        },
      };
    }
    if (source.runtime) {
      const { session, page } = source.runtime;
      return {
        cafeWsOps: {
          ...common,
          facts: { rtEvents: page.total },
          rt: {
            d: {
              id: session.runtimeSessionId,
              member: member(session.catId),
              model: session.model,
              bind: session.binding,
              view: rtTab,
              ...runtimeBody(page),
              page: rtPage,
              pages: Math.ceil(page.total / 20),
              first: rtPage === 1,
              last: !page.nextCursor,
            },
          },
        },
      };
    }
    if (source.sessions)
      return {
        cafeWsOps: {
          ...common,
          rt: {
            filter: ui.rtF ?? 'all',
            rows: source.sessions
              .filter((s) => sessionMatchesFilter(s, ui.rtF ?? 'all'))
              .map((s) => ({
                ...s,
                id: s.sessionId,
                runtimeId: s.sessionId,
                status: s.lifecycle.state,
                bind: s.binding,
                cat: s.catId,
                at: s.lastObservedAt,
                conflict: s.lifecycle.state === 'conflict',
                hasReason: !!s.lifecycle.reason,
              })),
          },
        },
      };
    if (source.quota && source.profiles && source.usage && source.tools && source.thread) {
      const { quota, usage, tools, thread } = source,
        total = tools.summary.totalCalls,
        pct = (n) => Math.round((n / (total || 1)) * 100),
        max = Math.max(1, ...Object.values(tools.byCat).map((x) => x.native + x.mcp + x.skill)),
        review = !!thread.routingPolicy?.scopes?.review?.avoidCats?.includes('opus'),
        archive = !!thread.routingPolicy?.scopes?.architecture?.preferCats?.includes('opus');
      ui.rpReview = review;
      ui.rpArch = archive;
      return {
        cafeWsOps: {
          ...common,
          facts: { refreshedAt: quota.fetchedAt, usage: usage.grandTotal },
          quota: {
            writing: raw.writing,
            pools: source.profiles.map((profile) => ({
              id: profile.id,
              title: profile.displayName,
              items: (profile.codex
                ? managedQuotaIsCurrent(profile) && profile.quota.status === 'ok'
                  ? profile.quota.items
                  : []
                : builtinQuotaItems(profile.clientId, quota)
              ).map((item) => ({
                name: profile.displayName,
                members: data.cats.filter((c) => c.accountRef === profile.id).map((c) => c.id),
                percent: toUtilization(item),
                source: item.label,
                resetsAt: item.resetsAt,
              })),
            })),
            review,
            archive,
            constrained: review || archive,
            days: usage.daily
              .slice()
              .reverse()
              .map((d) => ({
                date: d.date,
                invocations: d.total.invocations,
                items: Object.entries(d.cats).map(([who, c]) => ({
                  who,
                  input: c.inputTokens,
                  output: c.outputTokens,
                  count: c.participations,
                })),
              })),
            cats: data.cats.map((c) => member(c.id)),
            hasToolcat: !!toolCat,
            hasTooltype: !!toolType,
            hasToolrange: !!toolRange,
            tf: toolCat,
            tt: toolType,
            tr: toolRange,
            toolStats: {
              total,
              native: tools.summary.byCategory.native,
              mcp: tools.summary.byCategory.mcp,
              skill: tools.summary.byCategory.skill,
              nativeShare: pct(tools.summary.byCategory.native),
              mcpShare: pct(tools.summary.byCategory.mcp),
              skillShare: pct(tools.summary.byCategory.skill),
            },
            bars: tools.daily.map((d) => ({ ...d, value: d.native + d.mcp + d.skill, part: d.mcp })),
            tools: tools.topTools.map((t, i, list) => ({
              ...t,
              rank: list.slice(0, i + 1).filter((p) => p.category === t.category).length,
            })),
            toolCats: Object.entries(tools.byCat).map(([who, x]) => ({
              who,
              ...x,
              count: x.native + x.mcp + x.skill,
              percent: ((x.native + x.mcp + x.skill) / max) * 100,
            })),
          },
        },
      };
    }
    if (source.lb) {
      const lb = source.lb,
        rows = (arr, kind) =>
          arr.map((x, i) => ({ ...x, rank: i + 1, kind, count: kind === 'streak' ? x.currentStreak : x.count })),
        sum = (arr) => arr.reduce((n, x) => n + x.count, 0);
      return {
        cafeWsOps: {
          ...common,
          lb: {
            range: lbRange,
            hasRange: !!lbRange,
            favorite: rows(lb.mentions.favoriteCat, 'mentions'),
            night: rows(lb.mentions.nightOwl, 'mentions'),
            chatty: rows(lb.mentions.chatty, 'chatty'),
            streak: rows(lb.mentions.streak, 'streak'),
            cvo: lb.cvoLevel ? [lb.cvoLevel] : [],
            workStats: {
              commits: sum(lb.work.commits),
              reviews: sum(lb.work.reviews),
              bugFixes: sum(lb.work.bugFixes),
            },
            gameStats: lb.games
              ? {
                  wins: lb.games.catKill.wins,
                  winner: member(lb.games.catKill.top),
                  shameCount: lb.games.whoSpy.shameCount,
                  spy: member(lb.games.whoSpy.top),
                }
              : null,
          },
        },
      };
    }
    if (opsView === 'obs') {
      const latest = source.metrics?.at(-1)?.metrics,
        h = source.health,
        a = source.auth,
        stats = a
          ? { total: a.recent24h.totalFailures, totalAll: a.totalFailures, cats: Object.keys(a.recent24h.byCat).length }
          : Object.assign(
              {},
              h ? { uptime: h.uptime, otelEnabled: h.otelEnabled, errorRate: h.errorRate } : {},
              latest
                ? {
                    ok30m: sumByPrefix(latest, 'cat_cafe_invocation_completed', 'status="ok"'),
                    failed: sumByPrefix(latest, 'cat_cafe_invocation_completed', 'status="error"'),
                    total: sumByPrefix(latest, 'cat_cafe_cat_invocation_count'),
                    active: sumByPrefix(latest, 'cat_cafe_invocation_active'),
                    snapshots: source.metrics.length,
                  }
                : {},
            );
      return {
        cafeWsOps: {
          ...common,
          obs: {
            view: obsV,
            telemetryOff: !!h && !h.otelEnabled,
            stats,
            xcap: !!ui.xcap,
            xcats: ui.xcats || [],
            members: data.cats.filter((c) => c.roster?.available !== false).map((c) => c.id),
            cfg: source.env
              ? getTelemetryConfigVars(source.env).map((v) => ({
                  name: v.name,
                  value: v.sensitive ? null : v.currentValue,
                  set: v.currentValue !== null,
                  description: v.description,
                  sensitive: v.sensitive,
                  allowedValues: v.allowedValues,
                  runtimeEditable: v.runtimeEditable,
                }))
              : [],
            ready: Object.entries(h?.readiness?.checks ?? {}).map(([name, c]) => ({ name, ...c })),
            persistence: source.system?.storage,
            storeRows: h?.traceStore?.spanCount,
            storeBytes: source.system?.storage?.bytes,
            reasons: a ? Object.entries(a.recent24h.byReason).map(([name, count]) => ({ name, count })) : [],
            tools: a ? Object.entries(a.recent24h.byTool).map(([name, count]) => ({ name, count })) : [],
            cats: a ? Object.entries(a.recent24h.byCat).map(([id, count]) => ({ ...member(id), count })) : [],
            samples: a ? a.recentSamples.map((s) => ({ ...s, name: member(s.catId).name, time: s.at })) : [],
            steps: source.steps,
          },
        },
      };
    }
    return { cafeWsOps: common };
  }
  globalThis.projectOps = projectOps;
  function projectEvaluation(raw = chatDataSnapshot.project.evaluation) {
    const source = raw.value,
      ui = S.ws,
      data = chatDataSnapshot.chat;
    if (!source) return { eval: { load: raw.load } };
    const member = (id) => {
        const c = data.cats.find((c) => c.id === id),
          r = source.cats.find((c) => c.catId === id);
        return { id, name: c ? c.nickname || c.displayName : id, handle: r?.handle ?? c?.mentionPatterns[0] };
      },
      events = deriveEvalWorkspaceEvents(source.summary),
      active = events.filter((e) => e.kind !== 'watching' && e.kind !== 'resolved'),
      settled = events.filter((e) => e.kind === 'watching' || e.kind === 'resolved'),
      path = (p) =>
        p.startsWith('/') ? p : source.summary.repoProjectPath ? source.summary.repoProjectPath + '/' + p : undefined,
      event = (e) => ({
        key: e.id,
        severity: e.severity,
        title: e.title,
        domain: e.domainDisplayName,
        verdict: e.verdict,
        stale: e.stale,
        owner: e.lifecycle.targetOwnerCatId,
        kind: e.kind,
        actions: { thread: e.systemThreadId },
        summary: e.summary,
        gloss: e.metricGlossary,
        action: e.action,
        nextCheck: e.nextCheck,
        nextAt: e.nextEvalAt,
        escalation: e.lifecycle.escalation,
        closure: e.lifecycle.closureStatus,
        ownerStatus: e.lifecycle.ownerResponseStatus,
        reeval: e.lifecycle.reevalStatus,
        taskId: e.lifecycle.taskId,
        trace: e.lifecycle.actionRefs
          ?.filter((r) => r.availability === 'available')
          .map((r) => invocationIdFromEvidenceRef(r.value))
          .find(Boolean),
        files: {
          verdict: path(e.source.verdictPath),
          snapshot: path(e.source.bundleDir + '/snapshot.json'),
          attribution: path(e.source.bundleDir + '/attribution.json'),
        },
      }),
      overdue = (b) => b.issue.resolution === 'open' && b.issue.ageMs >= 72 * 36e5,
      page = ui.pawSource?.page,
      sourceError = page && (page.error || page.unavailableReason),
      all = page ? (sourceError ? [] : page.bundles) : source.paw.bundles,
      bundles = all.filter(
        (b) =>
          ui.pawF === 'all' ||
          (ui.pawF === 'disposed'
            ? b.issue.resolution === 'resolved'
            : ui.pawF === 'overdue'
              ? overdue(b)
              : b.issue.resolution === 'open'),
      ),
      primary = CS.evalDuty.current.primary ?? source.duty?.primaryCatId,
      backup = CS.evalDuty.current.backup ?? source.duty?.backupCatId;
    return {
      eval: {
        load: raw.load,
        view: ui.evalView,
        counts: { act: active.length, settled: settled.length, stale: source.summary.counts.stale },
        ledger:
          ui.evalView === 'overview'
            ? {
                cats: source.cats.map((c) => member(c.catId)),
                domainCount: source.summary.domains.length,
                duty: { primary: member(primary), backup: member(backup), hasPrimary: !!primary, hasBackup: !!backup },
                domains: source.summary.domains.map((d) => ({
                  key: d.domainId,
                  id: d.domainId,
                  name: d.displayName,
                  frequency: d.frequency,
                  next: d.nextCronFireAt,
                  hasNext: !!d.nextCronFireAt,
                  cat: d.evalCatId,
                  catName: member(d.evalCatId).name,
                  catHandle: member(d.evalCatId).handle,
                  selId: 'op-dom-' + d.domainId,
                  verdict: d.latestVerdict,
                  stale: events.some((e) => e.domainId === d.domainId && e.stale),
                  enabled: d.enabled,
                  metrics: d.metricGlossary,
                })),
              }
            : null,
        paw: {
          source: ui.pawSource?.messageId,
          error: sourceError || '',
          filter: ui.pawF,
          counts: {
            active: all.filter((b) => b.issue.resolution === 'open').length,
            all: page ? all.length : source.paw.bundleCounts.total,
            overdue: all.filter(overdue).length,
            disposed: all.filter((b) => b.issue.resolution === 'resolved').length,
          },
          items: bundles.map((b) => ({
            key: b.bundleKey,
            resolution: b.issue.resolution,
            overdue: overdue(b),
            previews: b.members.map((m) => ({
              available: m.source.availability === 'available',
              text: m.source.availability === 'available' ? m.source.preview : m.source.reason,
            })),
            continuation: b.issue.continuation.kind,
            validExit: b.responsibility.validExit,
            responsibility: b.responsibility.state,
            count: b.rawSignalCount,
            basis: b.basis,
            actions: { thread: b.sourceThreadId },
            reportCount: b.rawSignalCount,
            basisLine: b.basis,
            reports: b.members.map((m) => ({
              cat: m.disposition.sourceCatId,
              at: m.sourceOccurredAt,
              msg: m.disposition.sourceMessageId,
              age: m.issue.ageMs / 1000,
              validExit: b.responsibility.validExit,
            })),
          })),
        },
        act: active.map(event),
        actCount: active.length,
        settled: settled.map(event),
        settledCount: settled.length,
        settledResolved: settled.some((e) => e.kind === 'resolved'),
        settledWatching: !!settled.length && !settled.some((e) => e.kind === 'resolved'),
      },
    };
  }
  globalThis.projectEvaluation = projectEvaluation;
  function projectVoice(raw = chatDataSnapshot.project.voice) {
    const { session, settings, services, capture, saved, call, transcript, share, error } = raw;
    const vad = { vadState: raw.vadState };
    const state = { current: CS.voice };
    const threadId = chatDataSnapshot.chat.threadId;
    const workspace = { worktrees: raw.worktrees };
    const fields = CS.f;
    const API_URL2 = api.file('/').slice(0, -1);
    const captureService = services.items.find((s) => s.id === 'audio-capture');
    const captureAvailable = !!captureService && adaptServiceState(captureService).status === 'running';
    const list = services.items.map(adaptServiceState);
    const service = (feature) => {
      const svc = list.find((s) => (feature === 'audio-capture' ? s.id === feature : s.features.includes(feature)));
      return svc && svc.status === 'running' ? null : { name: svc && svc.name, state: svc ? svc.status : 'none' };
    };
    const active = session?.boundThreadId === threadId,
      playback = active ? session.playbackState : 'idle';
    const voice = {
      active,
      service: service('voice-companion'),
      canStart: !service('voice-companion') && !active,
      playback: {
        state: playback,
        canPause: playback === 'playing',
        canResume: playback === 'paused',
        canSkip: playback !== 'idle',
      },
      interrupted: active && vad.vadState === 'listening' && playback === 'idle',
      state: error || (call && ['preparing', 'connecting', 'failed'].includes(call.state) ? call.state : ''),
      call,
      canCall: !call,
      canStop: !!call,
      canShare: call?.state === 'talking',
      allowHomeReads: state.current.allowHomeReads,
      share,
      load: services.load,
    };
    const pathInfo = (path) => {
      const wt = path && workspace.worktrees.find((w) => path.startsWith(`${w.root}/`));
      if (!path || !wt) return {};
      const relative = path.slice(wt.root.length + 1);
      return {
        open: { v: relative, w: wt.id },
        source: `${API_URL2}/api/workspace/file/download?${new URLSearchParams({ worktreeId: wt.id, path: relative })}`,
      };
    };
    const summary = saved && saved.owner === threadId && !capture.status.running ? saved.summary : void 0,
      locator = pathInfo(summary?.transcript_path);
    const paths2 = [
      .../* @__PURE__ */ new Set([
        ...Object.values(summary?.recording_paths ?? {}),
        ...(summary?.recording_path ? [summary.recording_path] : []),
      ]),
    ];
    return {
      composerVoice: voice,
      voiceAvailability: Object.fromEntries(
        ['voice-input', 'voice-output', 'voice-companion'].map((feature) => [feature, !service(feature)]),
      ),
      voiceState: state.current,
      voice: {
        load: services.load,
        svc: list.map((s, i) => ({
          i,
          key: s.id,
          name: s.name,
          state: s.status,
          impl: s.selectedModel ?? '',
          installPhase: s.installPhase,
          pending: s.pending,
          log: s.log,
          next: s.status === 'running' ? 'stopped' : 'running',
          canInstall: s.installable && !s.installed,
          canRetry: s.status === 'error',
          installed: s.installed,
          running: s.status === 'running',
          showMore: !!s.error,
          error: !!s.error,
          errorText: s.error,
          detailKey: 'svc-' + s.id,
          model: s.selectedModel,
          endpoint: s.endpoint,
        })),
        terms: settings.customTerms.map((t, i) => ({
          i,
          a: t.from,
          b: t.to,
          editing: state.current.termEdit === i,
        })),
        dict: Object.entries(voice_terms_default)
          .filter(([key]) => !key.startsWith('_'))
          .map(([a, b]) => ({ a, b })),
        dictCount: Object.keys(voice_terms_default).filter((key) => !key.startsWith('_')).length,
        sttLang: settings.language,
        prompt: settings.customPrompt ?? '',
      },
      cafeWsVoice: {
        advisoryMode: capture.status.advisory_mode,
        load: services.load || (captureAvailable ? capture.load : ''),
        service: service('audio-capture'),
        rec: capture.status.running,
        capture: {
          sourceOptions: sourceOptions(capture.sources).map((s) => [s.id, s.name]),
          sourceId: state.current.sourceId,
          phase: capture.status.running ? (capture.status.paused ? 'paused' : 'recording') : 'idle',
          elapsed: capture.status.duration_s,
          canStart:
            !service('audio-capture') &&
            !capture.status.running &&
            sourceOptions(capture.sources).some((s) => s.id === state.current.sourceId),
          savedTranscriptLocator: summary?.transcript_path,
          canPause: capture.status.running && !capture.status.paused,
          canResume: !!capture.status.paused,
          canOpen: !!locator.open,
          open: locator.open,
          share: capture.share.kind === 'available' ? capture.share : null,
        },
        items: paths2.map((path) => ({
          id: path,
          path: path,
          mediaId: path,
          source: pathInfo(path).source,
          canDownload: !!pathInfo(path).source,
        })),
        lines: (capture.status.thread_id === threadId || summary ? capture.lines : []).map((l) => ({
          lineId: l.chunk_num,
          title: l.text,
          speaker: l.speaker_label,
          speakerId: `voice-speaker-${l.chunk_num}`,
          canEdit: !!l.speaker_id,
          draft: fields[`voice-speaker-${l.chunk_num}`] ?? l.speaker_label,
        })),
        transcript: (capture.status.thread_id === threadId || summary ? capture.lines : [])
          .map((l) => l.text)
          .join('\n'),
        transcriptSource: { captureId: capture.status.meeting_id, threadId: saved?.owner ?? capture.status.thread_id },
        callTranscript: { load: error ? 'error' : '', items: transcript.messages.map((m) => ({ title: m.text })) },
      },
    };
  }
  globalThis.projectVoice = projectVoice;
  function projectDesktop(raw = chatDataSnapshot.project.desktop) {
    const read = raw;
    if (read.error) return {};
    const currentVersion =
      read.prompt?.kind === 'available'
        ? read.prompt.currentVersion
        : read.prompt?.kind === 'up-to-date' || read.prompt?.kind === 'check-failed'
          ? read.prompt.version
          : read.currentVersion;

    if (!read.available) return { desktopAvailable: false, desktopUpdateState: null, desktopSystem: null };
    const { prompt, progress, settings } = read;
    return {
      desktopAvailable: true,
      desktopUpdateState: { load: read.load, prompt, progress, settings: settings ? { ...settings } : null },
      desktopSystem: {
        load: read.load,
        app: { desktop: true, version: currentVersion },
        desktopAuto: settings?.autoCheck,
        update: {
          version: prompt?.version,
          failed: prompt?.kind === 'check-failed',
          canDownload: prompt?.kind === 'available' && !progress,
          canInstall: prompt?.kind === 'ready-to-install',
          sections: { progress: !!progress },
          progress: progress ? [{ value: progress.progress * 100, percent: progress.progress * 100 }] : [],
        },
      },
    };
  }
  globalThis.projectDesktop = projectDesktop;
  function projectGeneral(raw = chatDataSnapshot.project.general) {
    const snapshot = { current: raw.snapshot },
      error = { current: raw.error },
      viewError = { current: raw.viewError };
    if (error.current || viewError.current) return {};

    return {
      systemGeneral: {
        load: snapshot.current ? '' : 'loading',
        send: snapshot.current ? (snapshot.current.effective === 'continue_current' ? 'current' : 'next') : null,
      },
    };
  }
  globalThis.projectGeneral = projectGeneral;
  function projectMemory(raw = chatDataSnapshot.project.memory) {
    const m = CS.m,
      read = raw.reads[m.cat],
      page = read.data,
      entries = page?.entries ?? page?.events ?? [],
      d = raw.detail,
      e = d?.entry,
      doc = raw.document,
      exploration = projectMemoryExplore(raw.explore);
    const sources = (s) =>
      (s?.sources ?? []).map((r) => ({
        ...r,
        title: r.label ?? r.title ?? r.threadId,
        time: r.occurredAt,
        act: r.canOpen ? 'msgJump' : '',
        args: r.canOpen ? { t: r.threadId, mid: r.messageId } : {},
      }));
    const detail =
      d && e
        ? {
            id: d.id,
            owner: e,
            personId: e.personId,
            personRevision: e.personRevision,
            active: e.status === 'active',
            canRetire: e.status === 'active' && !['profile', 'person'].includes(d.family),
            retireEntity: d.family === 'event' ? 'memoryEvent' : 'memoryEntity',
            title: e.displayName ?? e.canonicalName ?? e.title ?? e.summary ?? e.type,
            state: e.status,
            family: d.family,
            revision: e.revision,
            fields: [],
            body: e.content ? splitProfileBody(e.content).body : (e.summary ?? e.scene),
            sources: d.family === 'person' ? null : sources(d.source),
            sourceStatus: d.source?.status,
            proposals: (e.proposals ?? []).map((r) => ({
              id: r.proposalId,
              title: r.rationale ?? r.displayName,
              state: r.status,
              act: r.approvalState === 'anchored' && r.approvalCardRef ? 'msgJump' : '',
              args:
                r.approvalState === 'anchored' && r.approvalCardRef
                  ? { t: r.approvalCardRef.threadId, mid: r.approvalCardRef.messageId }
                  : {},
            })),
            corrections: (e.correctionProposals ?? []).map((r) => ({
              ...r,
              id: r.proposalId,
              state: r.status,
              title: r.suggestedPatch.summary ?? r.suggestedPatch.takeaway ?? r.reason,
              canOpen: !!d.correctionCards[r.proposalId],
              args: d.correctionCards[r.proposalId]
                ? {
                    t: d.correctionCards[r.proposalId].threadId,
                    mid: d.correctionCards[r.proposalId].messageId,
                  }
                : {},
            })),
            error: raw.error,
          }
        : raw.load
          ? { unavailable: raw.load === 'error', error: raw.error }
          : null;
    if (detail && e) {
      if (d.family === 'person')
        detail.person = {
          ...e,
          canWrite: e.status === 'active',
          canForget: e.status === 'active',
          draft: CS.memoryEdit,
          forgetError: raw.error,
          claims: e.claims.map((c) => ({
            ...c,
            state: c.status,
            canRetire: c.status === 'current' && c.payload.kind !== 'redacted',
            sources: sources(d.sources[c.claimId]),
          })),
          interactions: e.interactions.map((c) => ({
            ...c,
            title: c.headline,
            state: c.status,
            canWrite: c.status === 'active',
            sources: sources(d.sources[c.eventId]),
          })),
        };
      if (d.family === 'profile')
        detail.profile = {
          ...e,
          canWrite: true,
          expectedRevision: e.revision,
          openingReference: d.openingReference,
          usage: d.usage ? { ...d.usage, recordedSince: d.usage.directReadRecordedSince } : null,
          usageRows: d.usage?.recent ?? [],
          draft: CS.memoryEdit,
          error: raw.error,
        };
      if (d.family === 'entity')
        detail.entity = {
          ...e,
          attributes: {
            entityType: e.entityType,
            aliases: e.aliases,
            stance: e.stance,
            visibilityScope: e.visibilityScope,
          },
          sources: detail.sources,
          canWrite: e.status === 'active',
          canRetire: e.status === 'active',
          draft: CS.memoryEdit,
        };
      if (d.family === 'event')
        detail.event = {
          ...e,
          body: e.summary,
          source: detail.sources,
          canWrite: e.status === 'active',
          canRetire: e.status === 'active',
          draft: CS.memoryEdit,
          error: raw.error,
        };
      if (d.family === 'taste') {
        detail.taste = {
          ...e,
          provenance: d.source,
          canWrite: e.status === 'active',
          canRetire: e.status === 'active',
          draft: CS.memoryEdit,
        };
        detail.candidate = e.takeawayCandidate?.basedOnRevision === e.revision ? e.takeawayCandidate : null;
        detail.fields = [
          { field: 'takeaway', value: e.takeaway },
          { field: 'quotes', value: e.quotes },
        ];
      }
    }
    return {
      memoryState: m,
      memoryDetail: d,
      memoryEdit: CS.memoryEdit.current,
      memoryCollections: exploration.memoryCollections,
      memoryLibraryForm: exploration.memoryLibraryForm,
      memoryServices: exploration.memoryServices,
      memoryRecallSources: m.recallSources,
      cafeMemory: {
        navHidden: !!CS.navHidden,
        q: m.q,
        view: doc ? 'source' : m.view,
        ...exploration,
        all:
          m.view === 'all'
            ? {
                cat: m.cat,
                sort: m.sort,
                load: read.loading ? 'loading' : read.error ? 'error' : '',
                cats: Object.keys(paths).map((v) => ({ v, active: m.cat === v })),
                items: entries
                  .filter((r) => !m.q || JSON.stringify(r).toLowerCase().includes(m.q.toLowerCase()))
                  .sort((a, b) =>
                    m.cat === 'taste' && m.sort === 'hits'
                      ? (b.recall?.search?.hits ?? 0) - (a.recall?.search?.hits ?? 0)
                      : 0,
                  )
                  .map((r) => ({
                    ...r,
                    key: r.personId ?? r.eventId ?? r.id,
                    title: r.displayName ?? r.canonicalName ?? r.title ?? r.summary ?? r.type,
                    state: r.status,
                    hits: r.recall?.search?.hits,
                    act: 'memOpen',
                    args: { family: m.cat, id: r.personId ?? r.eventId ?? r.id, revision: r.revision },
                  })),
                more: !!page?.meta?.hasMore,
                limitPath: 'cs.m.limits.' + m.cat,
              }
            : null,
        sdoc: doc ? { title: doc.title, project: doc.collection, paras: [doc.content] } : null,
        detail: m.view === 'all' && !doc ? detail : null,
      },
    };
  }
  globalThis.projectMemory = projectMemory;
  function projectMemoryExplore(raw = chatDataSnapshot.project.memory.explore) {
    const {
        catalog,
        feed,
        index,
        maintenance,
        healthReport,
        toolUsage,
        curation,
        flags,
        ledger,
        axes,
        services,
        serviceLogs,
      } = raw.reads,
      {
        recall,
        brakes,
        brakeSource,
        search,
        libraryScan,
        libraryCreated,
        libraryBusy,
        libraryError,
        graph,
        graphLoading,
        graphError,
        receipt,
        rebuild,
        rebuildError,
      } = raw,
      ui = CS.m,
      collections = catalog.data?.collections ?? [],
      pending = feed.data?.pending ?? [],
      events = recall.events;
    const failed =
      (ui.view === 'recall' && (recall.error || recall.moreError || ledger.error || axes.error)) ||
      (ui.view === 'library' && (rebuildError || [catalog, feed, index, maintenance].some((r) => r.error))) ||
      (ui.view === 'status' &&
        (rebuildError || [index, maintenance, flags, services, healthReport, toolUsage].some((r) => r.error))) ||
      (ui.view === 'graph' && graphError);
    const result = {
      load: failed
        ? 'error'
        : (ui.view === 'library' && [catalog, feed, index, maintenance].some((r) => r.loading)) ||
            (ui.view === 'status' &&
              [index, maintenance, curation, flags, services, healthReport, toolUsage].some((r) => r.loading)) ||
            (ui.view === 'recall' && (recall.loading || ledger.loading || axes.loading)) ||
            (ui.view === 'graph' && graphLoading)
          ? 'loading'
          : '',
      memoryCollections: collections,
      memoryServices: services.data?.services.filter((s) => s.features.includes('memory-semantic-search')) ?? [],
      memoryLibraryForm: {
        draft: CS.memoryLibraryDraft.current,
        scan: libraryScan,
        created: libraryCreated,
        busy: libraryBusy,
        error: libraryError,
      },
    };
    if (ui.view === 'search') {
      const key = JSON.stringify([ui.searched, ui.type, ui.depth, ui.limit]);
      result.search = {
        query: ui.searched,
        type: ui.type,
        depth: ui.depth,
        limit: ui.limit,
        items:
          search.key === key
            ? (search.data?.groups ?? []).flatMap((g) =>
                g.results.map((r) => {
                  const d = r.destination;
                  return {
                    ...r,
                    key: r.id,
                    kind: r.displayType,
                    title: r.title,
                    sub: r.snippet,
                    rank: r.rank,
                    relevance: r.relevance,
                    graph: r.graph,
                    act: !d
                      ? ''
                      : d.kind === 'document'
                        ? 'recallSource'
                        : d.kind === 'message'
                          ? 'msgJump'
                          : 'memOpen',
                    args: !d
                      ? {}
                      : d.kind === 'document'
                        ? { anchor: d.anchor, collection: d.collection }
                        : d.kind === 'message'
                          ? { t: d.threadId, mid: d.messageId }
                          : { family: 'taste', id: d.id, revision: d.revision },
                  };
                }),
              )
            : [],
      };
      result.load = search.key === key ? search.load : 'loading';
    }
    if (ui.view === 'recall')
      result.recall = {
        ledger: ledger.data,
        lifecycle: axes.data,
        wins: [7, 14, 30].map((v) => ({ v, active: Number(ui.win) === v })),
        src: ui.src,
        who: ui.who,
        whoOptions: [...new Set(events.map((e) => e.catId).filter(Boolean))].map((v) => ({ v, name: v })),
        kv: (ledger.data?.rows ?? [])
          .map((r) => ({
            v: r.presented,
            metric: { cat_search: 'catSearch', context_push: 'contextPush', taste_exact: 'tasteExact' }[r.surface],
          }))
          .concat(
            axes.data
              ? ['harmfulConsumption', 'unmetDemandLowerBound', 'attentionCost'].map((k) => ({
                  v: axes.data[k].value,
                  maturity: axes.data[k].maturity,
                  metric: k,
                }))
              : [],
          ),
        groups: [...new Set(events.map((e) => e.threadId))].map((id) => ({
          title: events.find((e) => e.threadId === id).threadTitle,
          threadId: id,
          items: events
            .filter((e) => e.threadId === id)
            .map((e) => ({
              key: e.id,
              who: e.catId,
              title: e.query,
              at: e.timestamp,
              searched: e.source === 'pull',
              deliveries: recallItems([e], id),
              mid: e.reply?.id ?? e.messageId,
              canLocate: !!(e.reply?.id ?? e.messageId),
              thread: id,
            })),
        })),
        more: recall.moreLoading,
        noMore: !recall.page?.nextCursor,
        top: [],
      };
    if (ui.view === 'brakes') {
      const all = groupHumanBrakes(brakes.events),
        rows = all.filter((r) => ui.brakeWord === 'all' || r.words.includes(ui.brakeWord)),
        selected = rows.find((r) => r.key === ui.brakeSel) ?? rows[0];
      result.brakes = {
        range: ui.brakeRange,
        load: brakes.error || brakeSource.load === 'error' ? 'error' : brakes.loading ? 'loading' : '',
        loading: brakes.loading,
        hasMore: brakes.hasMore && !brakes.error,
        words: [
          { v: 'all', count: all.length, active: ui.brakeWord === 'all' },
          ...[...new Set(all.flatMap((r) => r.words))].map((v) => ({
            v,
            label: v,
            count: all.filter((r) => r.words.includes(v)).length,
            active: ui.brakeWord === v,
          })),
        ],
        items: rows.map((r) => ({ ...r, k: r.key, cur: r.key === selected?.key, q: r.summary, time: r.timestamp })),
        sel: selected
          ? {
              canOpen: brakeSource.id === selected.sourceEventId && !brakeSource.load && brakeSource.canOpen,
              mid: brakeSource.messageId,
              thread: brakeSource.threadId,
              quote: selected.summary,
              rule: selected.rules,
            }
          : null,
      };
    }
    if (ui.view === 'library')
      result.library = {
        pending: ui.lib === 'pending',
        tab: ui.lib,
        candidateCount: pending.length,
        collectionCount: collections.length,
        evidence: index.data,
        maintenance: maintenance.data?.health ?? maintenance.data,
        error: libraryError,
        cands: pending.map((c) => {
          const id =
              ui.targets[c.id] ??
              (['public', 'internal'].includes(c.sourceVisibility) || c.sourceVisibility == null
                ? catalog.data?.defaultTargetCollectionId
                : null),
            target = collections.find((t) => t.id === id && t.status !== 'archived' && t.readStatus === 'ready'),
            levels = { restricted: 0, private: 1, internal: 2, public: 3 },
            widens = !!target && levels[target.visibility] > levels[c.sourceVisibility];
          return {
            id: c.id,
            revision: c.revision,
            title: c.content,
            state: c.state,
            visibility: c.sourceVisibility,
            why: c.content,
            selId: 'cand-' + c.id,
            targets: collections
              .filter((t) => t.readStatus === 'ready' && t.status !== 'archived')
              .map((t) => ({ v: t.id, label: t.name })),
            to: target?.id ?? '',
            canApprove: !!target,
            noTarget: !target,
            widens,
            targetVisibility: target?.visibility,
            confirmationRequired: widens,
          };
        }),
        done: (feed.data?.processed ?? []).map((d) => ({
          ...d,
          title: d.content,
          state: d.state,
          canUndo: ['approved', 'materialized', 'indexed'].includes(d.state),
          receipt: receipt?.id === d.id ? receipt : null,
          result:
            receipt?.id === d.id && receipt.materialized
              ? { path: receipt.materialized.outputPath, reindexed: !!receipt.materialized.reindexed }
              : null,
        })),
        colls: collections.map((c) => {
          const r = raw.documents[c.id],
            last = r?.pages.at(-1);
          return {
            k: c.id,
            id: c.id,
            name: c.name,
            type: c.kind,
            vis: c.visibility,
            docs: c.docCount,
            upd: c.lastDocumentUpdatedAt,
            archived: c.status === 'archived',
            rebuilding: rebuild?.status === 'running' || rebuild?.status === 'pending',
            indexStatus: c.status,
            documents: {
              id: 'mem-docs-' + c.id,
              load: !r ? 'loading' : r.error ? 'error' : r.loading ? 'loading' : '',
              hasMore: !!last && last.groups.some((g) => g.hasMore),
              groups:
                r && r.pages.length
                  ? r.pages[0].groups.map((g) => ({
                      title: g.kind,
                      count: last.groups.find((n) => n.kind === g.kind).count,
                      items: r.pages.flatMap((p) =>
                        p.groups
                          .filter((q) => q.kind === g.kind)
                          .flatMap((q) => q.documents.map((d) => ({ ...d, collection: c.id }))),
                      ),
                    }))
                  : [],
            },
          };
        }),
      };
    if (ui.view === 'graph') {
      const g = graph?.status === 'graph' ? graph.graph : null,
        edges = g?.edges.filter((e) => ui.rel[e.relation]) ?? [],
        positions = g ? forceLayout(g.nodes, edges, g.center, 680, 300) : new Map(),
        selected = g?.nodes.find((n) => n.anchor === ui.node);
      result.graph = {
        q: ui.graphQ,
        nodes:
          graph?.status === 'candidates'
            ? graph.candidates.map((c) => ({
                v: JSON.stringify([c.collectionId, c.anchor]),
                label: c.title,
                on: ui.node === JSON.stringify([c.collectionId, c.anchor]),
              }))
            : (g?.nodes ?? []).map((n) => ({ v: n.anchor, label: n.title, on: ui.node === n.anchor })),
        node: selected?.title,
        nodeDesc: [selected?.displayType ?? selected?.kind],
        rels: edges
          .filter((e) => e.from === ui.node || e.to === ui.node)
          .map((e) => ({
            value: e.relation,
            label: g.nodes.find((n) => n.anchor === (e.from === ui.node ? e.to : e.from))?.title,
          })),
        nodeCount: g?.nodes.length ?? 0,
        relationCount: edges.length,
        depth: g?.depth,
        rel: [...new Set(g?.edges.map((e) => e.relation))].map((v) => ({ v, label: v, on: ui.rel[v] })),
        graph: {
          edges: edges.map((e) => ({
            from: [positions.get(e.from).x, positions.get(e.from).y],
            to: [positions.get(e.to).x, positions.get(e.to).y],
          })),
          nodes: (g?.nodes ?? []).map((n) => ({
            id: n.anchor,
            x: positions.get(n.anchor).x,
            y: positions.get(n.anchor).y,
            selected: ui.node === n.anchor,
          })),
        },
      };
    }
    if (ui.view === 'status') {
      const stats = index.data?.healthy ? parseIndexStatus(index.data) : null,
        report = healthReport.data,
        health = maintenance.data?.health ?? maintenance.data,
        total = collections.filter((c) => c.status !== 'archived').reduce((n, c) => n + (c.docCount ?? 0), 0);
      result.status = {
        healthReport: report,
        toolUsage: toolUsage.data,
        rebuild: rebuild,
        curation: {
          ...curation.data,
          blocked: curation.loading || curation.error,
          error: curation.error,
          modelLabel: curation.data?.modelLabel,
        },
        svc: (services.data?.services ?? [])
          .filter((s) => s.features.includes('memory-semantic-search'))
          .map((s) => {
            const busy = ['installing', 'starting', 'stopping', 'uninstalling'].includes(s.status),
              installed = s.installed;
            return {
              id: s.id,
              name: s.name,
              state: s.status,
              status: s.status,
              port: s.port,
              model: s.selectedModel,
              busy,
              blocked: s.error,
              prerequisites: s.prerequisites,
              hasBlocked: !!s.error,
              canInstall: !busy && !installed && s.installable,
              canStart: !busy && installed && !s.enabled,
              canStop: !busy && installed && s.enabled,
              canConfigure: !busy && installed && !s.enabled,
            };
          }),
        logs: Object.entries(serviceLogs.data ?? {})
          .filter(([, lines]) => lines.length)
          .map(([id, lines]) => '── ' + id + ' ──\n' + lines.join('\n'))
          .join('\n\n'),
        warm: stats?.passageVectorsSupported && stats.passagesCount > stats.passageVectorsCount,
        passages: stats?.passageVectorsCount,
        vectors: stats?.vectorsCount,
        evidence: index.data,
        maintenance: health,
        distribution: collections
          .filter((c) => c.status !== 'archived')
          .map((c) => ({ type: c.kind, pct: total ? ((c.docCount ?? 0) / total) * 100 : 0 })),
        staleAnchors: report?.staleAnchors?.count,
        collectionCount: collections.length,
        archivedCount: collections.filter((c) => c.status === 'archived').length,
        hitRate: health?.searchHitRate,
        windowDays: health?.windowDays,
        replayDrift: report?.replayDrift,
        searches: health?.searches,
        reflections: health?.reflections,
        flags: flags.data
          ? [
              {
                id: 'F200_CONSUMPTION_RERANK',
                name: 'F200_CONSUMPTION_RERANK',
                states: ['off', 'shadow', 'on'],
                value: flags.data.f200.consumptionRerank,
                g: 0,
                selId: 'flag-0',
                locked: true,
                options: ['off', 'shadow', 'on'].map((value) => ({ value, locked: true })),
              },
            ]
          : [],
      };
    }
    return result;
  }
  globalThis.projectMemoryExplore = projectMemoryExplore;
  function projectTrash(raw = chatDataSnapshot.project.trash) {
    const read = raw;
    if (read.error) return {};

    return {
      cafeTrash: {
        items: read.threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          deleted: thread.deletedAt != null,
          deletedAt: thread.deletedAt,
          ctx: { id: thread.id },
        })),
      },
    };
  }
  globalThis.projectTrash = projectTrash;
})();
