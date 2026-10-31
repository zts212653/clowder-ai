// Real legal source preparation shared by comparison and frozen natural-task consumers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSummary } from '../dist/domains/memory/CatCafeScannerParsing.js';
import { prepareReleaseSource } from './f321-release-source.mjs';

export async function prepareExperienceSources(env, out, { genericCheck, baselineL0, frozenBuild }) {
  const probe = [];
  for (const query of ['把修好的插件发出去 先前发布经验', '插件 发布 npm workflow', 'npm']) {
    const response = await env.app.inject(
      `/api/evidence/search?q=${encodeURIComponent(query)}&scope=docs&mode=hybrid&limit=5&include_expansion=false`,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().degraded, false, 'document-summary hybrid must use a healthy normal path');
    probe.push({ query, status: response.statusCode, body: response.json() });
  }
  const release = prepareReleaseSource(env);
  const releaseTask = release.task;
  const bookPath = 'runbooks/retrieval-observations.md';
  const header =
    '---\ntitle: 项目资料发现与当前依据\ndoc_kind: runbook\ncreated: 2026-10-20\ntopics: [资料, 检索, 索引, 回源, 经验]\n---\n\n# 项目资料发现与当前依据\n\n';
  const observation = `本轮实际复验：新建索引 ${env.initialIndex.docsIndexed} 项。长自然句查询返回 ${probe[0].body.results?.length} 项；缩短为 npm 后 ${probe[2].body.results?.some((item) => item.anchor === 'F202') ? '找到已有发布流程' : '仍未找到发布流程'}。来源是本轮真实 evidence/search 请求，完整输入与结果另存作者取证，未用手选 search 回答。\n\n`;
  const lesson =
    '当前适用经验：本项目资料搜索为空时，不把它当作资料不存在。先核覆盖范围和索引是否已更新；确认已覆盖且当前后，再改写或缩短检索语句，回读找到的当前原文后采用。若仍无依据就说明缺口，不要求用户凭空再讲一遍。历史批次回执不能提供当前任务授权。\n';
  const experienceSource = env.append(
    observation + '处理结果：更换查询后已定位到正式发布步骤；记录适用的排查顺序，避免下一次把空命中当作没有资料。',
  );
  const knowledge = header + lesson + `\n来源：${env.sourceThreadId}#${experienceSource.id}\n\n` + observation;
  const representation = { before: extractSummary(header + observation + lesson), after: extractSummary(knowledge) };
  const retained = await env.recordProject(bookPath, knowledge);
  // The original domain entry already owns this subject. Link to one current record,
  // rather than leaving a second unconnected knowledge location for the consumer to guess.
  const domainEntry = 'features/F102-memory-adapter-refactor.md';
  const existingEntry = readFileSync(join(env.docs, domainEntry), 'utf8');
  const parentLink = await env.recordProject(
    domainEntry,
    existingEntry.replace(
      /(^# .+\n)/m,
      '$1\n当前项目运行经验：[资料发现与索引更新](../runbooks/retrieval-observations.md)。当前步骤与更正只维护在该原文；下文保留架构经过。\n',
    ),
  );
  const proposal = env.append('叫你「溪灯」，咱们是夜读搭子，好吗？');
  const acceptance = env.append('好，我接住溪灯和夜读搭子。', 'codex61-sol');
  const profile = await env.legalProfile(
    `当前约定：主体 codex61-sol，小名溪灯，角色夜读搭子。对 owner 的当前称呼是 You；协作来信中的称呼不改变这份批准约定。原提议 ${env.sourceThreadId}#${proposal.id}；原回应 ${env.sourceThreadId}#${acceptance.id}。登记出处不是起源，未证明全史首次。其他猫的角色不归本猫。`,
  );
  const readerAuth = await env.registry.create('trial-owner', 'codex61-sol', env.consumerThreadId);
  const readerHeaders = { 'x-invocation-id': readerAuth.invocationId, 'x-callback-token': readerAuth.callbackToken };
  const originalMessages = [];
  for (const message of [proposal, acceptance]) {
    const response = await env.app.inject({
      url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`,
      headers: readerHeaders,
    });
    assert.equal(response.statusCode, 200, 'normal message drill must be available before a consumer starts');
    originalMessages.push(response.json().message);
  }
  const messageSearchHealth = await env.app.inject({
    url: '/api/callbacks/search-evidence?q=%E6%BA%AA%E7%81%AF&resultUnit=message&scope=threads&mode=lexical',
    headers: readerHeaders,
  });
  assert.equal(messageSearchHealth.statusCode, 200, 'normal message search must be mounted');
  const threadContextHealth = await env.app.inject({
    url: `/api/callbacks/thread-context?threadId=${env.sourceThreadId}&responseMode=full&limit=50`,
    headers: readerHeaders,
  });
  assert.equal(threadContextHealth.statusCode, 200, threadContextHealth.body);
  assert.ok(threadContextHealth.body.includes(release.sourceMessageId), 'current Task authorization must be drillable');
  const taskReadHealth = await env.app.inject({ url: '/api/callbacks/list-tasks', headers: readerHeaders });
  assert.equal(taskReadHealth.statusCode, 200, taskReadHealth.body);
  assert.ok(taskReadHealth.body.includes(release.task.id), 'normal Task read must include this batch');
  writeFileSync(
    join(out, 'source-preparation.json'),
    JSON.stringify(
      {
        planRevision: '4c6241c784f08d17ee4142ef1c318bbe1cc34c84',
        sourceHead: env.git('rev-parse', 'HEAD'),
        sourceCount: env.initialIndex,
        retrievalHealth: env.retrievalHealth,
        frozenBuild,
        release,
        probe,
        retained,
        parentLink,
        experienceSourceMessageId: experienceSource.id,
        representation,
        profile,
        originalMessages,
        messageSearchHealth: messageSearchHealth.json(),
        threadContextHealth: threadContextHealth.json(),
        taskReadHealth: taskReadHealth.json(),
        releaseTask,
        genericCheck,
        bootstrapL0Sha256: createHash('sha256').update(baselineL0).digest('hex'),
        corpusScope:
          'controlled canonical project features/decisions/design/runbooks; no evaluation plans or answer reports',
        selectionPurpose:
          'Astra integration owner decides whether the shared normal entry needs the generic prerequisite-check guidance; deterministic source validity remains verifier-owned',
      },
      null,
      2,
    ),
  );
  return { bookPath, header, observation, release };
}
