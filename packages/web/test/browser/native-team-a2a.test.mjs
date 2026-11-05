import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { requireCodexTestHistoryPolicy } from './native-codex-history-policy.mjs';
import { allA2AInvocationsDone, findA2AProof, validateA2AInvocations } from './native-team-a2a-proof.mjs';
import { settleOwnedThread } from './native-team-cleanup.mjs';
import { openLiveJourney, roleIdentity } from './native-team-live.harness.mjs';
import { assertLivePageHealthy } from './native-team-observers.mjs';
import { readNativeToolObservations } from './native-team-transcript-observation.mjs';

test(
  'real A2A: one initial target delegates to a configured peer and integrates its actual reply',
  { timeout: 300000 },
  async () => {
    const journey = await openLiveJourney();
    const { page, request, record, web, log } = journey;
    record.scenario = 'real-a2a-one-initial-target';
    record.explicitToolInstruction = process.env.CAT_CAFE_ONBOARDING_A2A_EXPLICIT === '1';
    let thread;
    try {
      const cats = (await request('/api/cats')).cats;
      const lead = cats.find((cat) => cat.id === (process.env.CAT_CAFE_ONBOARDING_A2A_LEAD ?? 'codex')),
        peer = cats.find((cat) => cat.id === (process.env.CAT_CAFE_ONBOARDING_A2A_PEER ?? 'pi'));
      assert.ok(lead && peer, 'Use the explicitly owned test roster; never create or reset roles here');
      assert.notEqual(lead.id, peer.id, 'A2A requires two different real partners');
      if ([lead, peer].some((cat) => cat.clientId === 'openai'))
        record.nativeHistoryPolicy = await requireCodexTestHistoryPolicy(
          process.env.CAT_CAFE_ONBOARDING_E2E_INSTANCE,
          process.env.CAT_CAFE_ONBOARDING_CODEX_HISTORY_POLICY,
        );
      record.roles = [lead, peer].map(roleIdentity);
      const token = randomUUID().slice(0, 8);
      const left = 3 + Math.floor(Math.random() * 10),
        right = 3 + Math.floor(Math.random() * 10);
      record.arithmetic = { left, right, expected: left * right };
      const peerKey = `A2A_PEER_${token}`,
        finalKey = `A2A_FINAL_${token}`;
      const peerMarker = `${peerKey}=${left * right}`,
        finalMarker = `${finalKey}=${left * right}`;
      thread = await request('/api/threads', { method: 'POST', body: JSON.stringify({ title: '真实 A2A 传球验收' }) });
      record.threadId = thread.id;
      const writes = [];
      page.on('request', (req) => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/messages') writes.push(req.postDataJSON());
      });
      await page.goto(new URL(`/thread/${thread.id}?shell=v2&lang=zh`, web).href);
      const input = page.locator('textarea').first();
      await input.waitFor();
      const delivery = record.explicitToolInstruction ? '通过 cat_cafe_post_message ' : '';
      await input.fill(
        `${lead.mentionPatterns[0]} 请与${peer.nickname || peer.displayName}（角色 ID ${peer.id}）完成一次真实协作：先${delivery}将计算 ${left}×${right} 的小任务交给它。没有收到伙伴真实消息前，禁止输出 ${finalKey} 或任何最终答案；不能自行伪造结果。伙伴必须以 ${peerKey}=实际结果 的格式回复并传回给你，收到后你审核并以 ${finalKey}=实际结果 的格式直接交付给当前用户，最终答案后不要再调用工具或再次唤醒伙伴。只做这次计算与传球，不运行系统命令、不改文件。`,
      );
      const accepted = page.waitForResponse(
        (res) => new URL(res.url()).pathname === '/api/messages' && res.request().method() === 'POST',
      );
      await input.press('Enter');
      assert.equal((await accepted).status(), 202);
      await log('single-initial-target-submitted', { lead: lead.id, peer: peer.id });
      const deadline = Date.now() + 240000;
      let messages = [],
        proof,
        trajectories = [];
      while (Date.now() < deadline) {
        messages = (await request(`/api/messages?threadId=${thread.id}&limit=100`)).messages;
        const observations = await readNativeToolObservations(
          process.env.CAT_CAFE_ONBOARDING_E2E_INSTANCE,
          thread.id,
          messages,
        );
        record.toolObservationSources = observations.sources;
        proof = findA2AProof(messages, {
          leadId: lead.id,
          peerId: peer.id,
          peerMarker,
          finalMarker,
          nativeToolEvents: observations.events,
        });
        if (proof) {
          trajectories = (await request(`/api/threads/${thread.id}/invocations?limit=30`)).invocations;
          if (allA2AInvocationsDone(trajectories)) break;
        }
        await page.waitForTimeout(1000);
      }
      record.initialBrowserMessageCount = writes.length;
      record.messageIds = messages.map((m) => m.id);
      record.assistantSequence = messages
        .filter((m) => m.type === 'assistant')
        .map((m) => ({ id: m.id, catId: m.catId }));
      assert.equal(writes.length, 1, 'The browser must not simulate another user message to wake the peer');
      const content = String(writes[0].content);
      assert.deepEqual(content.match(/@[a-z][a-z0-9-]*/g), [lead.mentionPatterns[0]]);
      record.causalProof = proof;
      assert.ok(proof, 'Persisted lifecycle must prove lead→peer→lead with a real peer result');
      assert.ok(allA2AInvocationsDone(trajectories), 'All actual invocations must finish naturally');
      record.invocations = trajectories.map((i) => ({ id: i.invocationId, catId: i.catId, status: i.status }));
      for (const id of [
        proof.initialInvocationId,
        proof.peerInvocationId,
        proof.returnInvocationId,
        proof.finalInvocationId,
      ])
        assert.ok(trajectories.some((i) => i.invocationId === id));
      const invocationValidation = validateA2AInvocations(messages, trajectories, {
        leadId: lead.id,
        peerId: peer.id,
        peerMarker,
        finalMarker,
        proof,
      });
      record.invocationValidation = invocationValidation;
      record.extraLeadInvocations = trajectories.filter((i) => i.catId === lead.id).length - 2;
      record.extraPeerInvocations = trajectories.filter((i) => i.catId === peer.id).length - 1;
      await page.reload();
      await page.getByText(peerMarker, { exact: false }).last().waitFor();
      await page.getByText(finalMarker, { exact: false }).last().waitFor();
      await journey.screenshot('real-a2a-complete');
      assert.ok(
        invocationValidation.ok,
        `Every extra invocation must be causally classified: ${JSON.stringify(invocationValidation.rejectedInvocations)}`,
      );
      assert.ok(
        trajectories.filter((invocation) => invocation.catId === peer.id).length >= 1,
        'A2A must include at least one real peer invocation',
      );
      assert.ok(trajectories.length >= 3, 'A2A must include lead, peer, and return invocations');
      assertLivePageHealthy(record);
      record.cleanup = await settleOwnedThread(request, thread.id, { cancel: false });
      await log('real-delegation-peer-answer-and-integration-passed');
    } catch (error) {
      record.failure = error.message;
      await journey.screenshot('real-a2a-failed');
      throw error;
    } finally {
      try {
        if (thread && record.failure) record.cleanup = await settleOwnedThread(request, thread.id);
      } finally {
        await journey.close();
      }
    }
  },
);
