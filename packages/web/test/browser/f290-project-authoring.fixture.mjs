export async function seedAnotherHumanTodo(store, seeded, title) {
  const project = await store.createCollectiveProject(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'all-todos-owner-project',
    channelId: '产品方向',
    title: '另一成员的待办项目',
    purpose: '证明“全部待办”会显示其他成员仍需处理的事项。',
  });
  return store.createCollectiveProjectTask(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'all-todos-owner-task',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: '产品方向',
    title,
    intendedOutcome: 'You 的未分配任务只在全部待办或 You 视图出现。',
    accountability: 'unassigned',
  });
}

export async function seedHumanSelfExecutedTask(store, seeded, roadmap) {
  const created = await store.createCollectiveProjectTask(seeded.owner.sessionToken, {
    ...seeded.coordinates,
    requestId: 'project-authoring-self-executor-task',
    roadmapId: roadmap.roadmapId,
    expectedRoadmapRevision: roadmap.revision,
    channelId: '产品方向',
    title: '由吴浪本人推进的任务',
    intendedOutcome: '项目列表同时显示 Human 本人和 Cat 执行者。',
    accountability: 'unassigned',
    requestedAccountableHumanId: seeded.member.human.humanId,
  });
  const request = created.work.accountabilityRequests?.[0];
  if (!request) throw new Error('Expected the Human self-execution fixture to create an accountability request');
  return store.respondCollectiveWorkAccountability(seeded.member.sessionToken, {
    ...seeded.coordinates,
    requestId: 'project-authoring-self-executor-acceptance',
    workId: created.work.workId,
    expectedRevision: created.work.revision,
    accountabilityRequestId: request.accountabilityRequestId,
    decision: 'accept',
  });
}
