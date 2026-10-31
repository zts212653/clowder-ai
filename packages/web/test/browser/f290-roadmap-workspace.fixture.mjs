export async function seedRoadmaps(store, seeded) {
  let sequence = 0;
  const post = (body, channelId = '产品方向', replyToEventId) =>
    store.postHumanMessage(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      clientEventId: `u3-roadmap-source-${++sequence}`,
      body,
      location: { channelId },
      recipient: { kind: 'channel' },
      ...(replyToEventId ? { replyToEventId } : {}),
    });
  const propose = (sourceEventId, label) =>
    store.proposeCollectiveWork(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      requestId: `u3-propose-${label}`,
      sourceEventId,
    });
  const commit = (proposal, label, assigned = false) =>
    store.commitCollectiveWork(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      requestId: `u3-commit-${label}`,
      workId: proposal.workId,
      expectedRevision: proposal.revision,
      ...(assigned
        ? {
            assignment: {
              connectionId: seeded.connection.connectionId,
              catId: 'codex-astra',
              participationRevision: 1,
            },
          }
        : {}),
    });

  const prerequisiteSource = await post('先把正式入口与恢复路径接稳。');
  const activeSource = await post('砚砚继续推进完整可用版本。');
  const executingSource = await post('砚砚正在整理跨项目执行清单。');
  const pluginRoot = await post('插件频道需要一条移动端发布路径。', '插件共建');
  const mobileSource = await store.postHumanMessage(seeded.member.sessionToken, {
    ...seeded.coordinates,
    clientEventId: 'u3-roadmap-topic-source',
    target: { kind: 'message', eventId: pluginRoot.eventId },
    replyToEventId: pluginRoot.eventId,
    body: '移动端发布要等正式入口稳定后再开始。',
  });
  const completedSource = await post('安全 Markdown 已经合入并保留原始来源。');
  const unassignedSource = await post('先把跨项目接口治理纳入计划，负责人稍后认领。');

  const prerequisite = await commit(await propose(prerequisiteSource.eventId, 'prerequisite'), 'prerequisite');
  const active = await commit(await propose(activeSource.eventId, 'active'), 'active', true);
  const executing = await commit(await propose(executingSource.eventId, 'executing'), 'executing', true);
  if (!active.assignmentEventId) throw new Error('Expected the active Work to have an assignment event');
  if (!executing.assignmentEventId) throw new Error('Expected the executing Work to have an assignment event');
  await store.postAgentMessage(seeded.connection.endpointCredential, {
    ...seeded.coordinates,
    connectionId: seeded.connection.connectionId,
    clientEventId: 'u3-executing-progress',
    agent: {
      agentId: 'codex-astra',
      catId: 'codex-astra',
      displayName: '小星星 · 砚砚',
      sessionRef: 'u3-roadmap-browser-fixture',
    },
    target: { kind: 'message', eventId: executingSource.eventId },
    location: { channelId: '产品方向', rootEventId: executingSource.eventId },
    recipient: { kind: 'channel' },
    participationRevision: 1,
    replyToEventId: executing.assignmentEventId,
    workProgressIntent: {
      assignmentEventId: executing.assignmentEventId,
      participationRevision: 1,
      executionRevision: 1,
      resultRevision: 1,
    },
    body: '跨项目执行清单正在整理，已核对第一批负责人。',
  });
  await store.postAgentMessage(seeded.connection.endpointCredential, {
    ...seeded.coordinates,
    connectionId: seeded.connection.connectionId,
    clientEventId: 'u3-active-result',
    agent: {
      agentId: 'codex-astra',
      catId: 'codex-astra',
      displayName: '小星星 · 砚砚',
      sessionRef: 'u3-roadmap-browser-fixture',
    },
    target: { kind: 'message', eventId: activeSource.eventId },
    location: { channelId: '产品方向', rootEventId: activeSource.eventId },
    recipient: { kind: 'channel' },
    participationRevision: 1,
    replyToEventId: active.assignmentEventId,
    workResultIntent: {
      assignmentEventId: active.assignmentEventId,
      participationRevision: 1,
      resultRevision: 1,
    },
    body: '完整可用版本的首轮实现已回到共同路线，等待负责人确认。',
  });
  const mobileCommitted = await commit(await propose(mobileSource.eventId, 'mobile'), 'mobile', true);
  const mobile = await store.setCollectiveWorkDependencies(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-mobile-dependency',
    workId: mobileCommitted.workId,
    expectedRevision: mobileCommitted.revision,
    dependencyWorkIds: [prerequisite.workId],
  });
  const completedCommitted = await commit(await propose(completedSource.eventId, 'completed'), 'completed');
  const completed = await store.completeCollectiveWork(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-complete-markdown',
    workId: completedCommitted.workId,
    expectedRevision: completedCommitted.revision,
  });
  const unassignedProposal = await propose(unassignedSource.eventId, 'unassigned');
  const unassigned = await store.commitCollectiveWork(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-accept-unassigned',
    workId: unassignedProposal.workId,
    expectedRevision: unassignedProposal.revision,
    accountability: 'unassigned',
  });

  const created = await store.createCollectiveRoadmap(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-create-primary-roadmap',
    sourceEventId: seeded.first.eventId,
    title: '完整可用版本',
    purpose: '让基础能力、体验修整和真实验收沿同一批任务继续。',
    workIds: [completed.workId],
  });
  const closed = await store.setCollectiveRoadmapStatus(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-close-primary-roadmap',
    roadmapId: created.roadmapId,
    expectedRevision: created.revision,
    status: 'completed',
    note: '首个可交付切片已验收。',
  });
  const reopened = await store.setCollectiveRoadmapStatus(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-reopen-primary-roadmap',
    roadmapId: closed.roadmapId,
    expectedRevision: closed.revision,
    status: 'active',
    note: '继续完整版本路线。',
  });
  const primary = await store.setCollectiveRoadmapWorks(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-expand-primary-roadmap',
    roadmapId: reopened.roadmapId,
    expectedRevision: reopened.revision,
    workIds: [completed.workId, active.workId, executing.workId, mobile.workId, unassigned.workId],
  });

  const foundation = await store.createCollectiveRoadmap(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-create-foundation-roadmap',
    sourceEventId: prerequisiteSource.eventId,
    title: '基础设施底座',
    purpose: '让其他项目依赖的基础任务保留独立归属与来源。',
    workIds: [prerequisite.workId],
  });

  const followupCreated = await store.createCollectiveRoadmap(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-create-followup-roadmap',
    sourceEventId: completedSource.eventId,
    title: '发布后跟进',
    purpose: '保留已完成任务的后续观察。',
    workIds: [completed.workId],
  });
  const followup = await store.setCollectiveRoadmapStatus(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'u3-close-followup-roadmap',
    roadmapId: followupCreated.roadmapId,
    expectedRevision: followupCreated.revision,
    status: 'completed',
  });
  return {
    primary,
    foundation,
    followup,
    prerequisite,
    active,
    executing,
    mobile,
    completed,
    unassigned,
    mobileSource,
  };
}
