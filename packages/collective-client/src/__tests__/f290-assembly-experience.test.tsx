import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { F290AssemblyExperience, persistF290AssemblyCandidateState } from '../F290AssemblyExperience.js';
import {
  addF290AssemblyHostResult,
  addF290AssemblyMessage,
  admitF290AssemblyCat,
  f290AssemblyDefaultState,
  respondToF290AssemblyMessage,
  revokeF290AssemblyParticipation,
  setF290AssemblyConnection,
} from '../f290-assembly-state.js';

describe('F290 whole-page assembly candidate', () => {
  it('refuses membership admission whenever the candidate cannot interact', () => {
    const offline = setF290AssemblyConnection(f290AssemblyDefaultState, 'offline');
    const revoked = revokeF290AssemblyParticipation(f290AssemblyDefaultState);

    expect(admitF290AssemblyCat(offline, 'xian')).toEqual(offline);
    expect(admitF290AssemblyCat(revoked, 'xian')).toEqual(revoked);
  });

  it('does not classify a Host result as a new request for attention', () => {
    const result = addF290AssemblyHostResult(f290AssemblyDefaultState, 'work_demo_product-brief', 1);

    expect(result.messages).toEqual([
      expect.objectContaining({
        expectation: 'unspecified',
        status: 'result',
      }),
    ]);
  });

  it('does not let a revoked candidate respond to an old pending message', () => {
    const pending = {
      ...f290AssemblyDefaultState,
      messages: [
        {
          id: 'pending-message',
          channelId: 'product-direction' as const,
          body: '请回应',
          expectation: 'request' as const,
          responderId: 'yan' as const,
          status: 'pending' as const,
        },
      ],
    };
    const revoked = revokeF290AssemblyParticipation(pending);

    expect(addF290AssemblyMessage(revoked, '再次请求', 'request', 1)).toEqual(revoked);
    expect(respondToF290AssemblyMessage(revoked, 'pending-message')).toEqual(revoked);
    expect(respondToF290AssemblyMessage(pending, 'pending-message').messages[0]?.status).toBe('responded');
  });

  it('keeps an unmentioned request pending without silently assigning a named responder', () => {
    const next = addF290AssemblyMessage(f290AssemblyDefaultState, '谁家在做这件事？', 'request', 2);

    expect(next.messages).toEqual([
      expect.objectContaining({
        expectation: 'request',
        recipient: undefined,
        responderId: undefined,
        status: 'pending',
      }),
    ]);
  });

  it('keeps the candidate usable when browser storage refuses a persistence write', () => {
    expect(() =>
      persistF290AssemblyCandidateState(f290AssemblyDefaultState, {
        setItem: () => {
          throw new Error('quota exceeded');
        },
      }),
    ).not.toThrow();
  });

  it('keeps one canonical Client shell while direct entry is honest about the absent Café', () => {
    const html = renderToStaticMarkup(<F290AssemblyExperience embedded={false} />);

    expect(html).toContain('data-spatial-role="global-rail"');
    expect(html).toContain('data-spatial-role="destination-pane"');
    expect(html).toContain('data-spatial-role="primary-scene"');
    expect(html).toContain('体验候选 · 演示数据');
    expect(html).toContain('连接你的 Café 后可见');
    expect(html).not.toContain('打开我的 Café');
    expect(html).not.toContain('私人 Thread ID');
  });

  it('keeps embedded private work behind an explicit Host handoff instead of a duplicate Client panel', () => {
    const html = renderToStaticMarkup(<F290AssemblyExperience embedded hostOrigin="http://host.test" />);

    expect(html).not.toContain('data-spatial-role="global-rail"');
    expect(html).toContain('打开我的 Café');
    expect(html).toContain('同一逻辑上下文位置');
    expect(html).toContain('work_demo_product-brief');
    expect(html).not.toContain('privateThreadId');
  });
});
