import { CLIENT_REQUEST_DIAGNOSTIC_HEADER } from '@cat-cafe/shared';
/** Isolated HTTP boundary fixtures. Always use the original client fetcher/adapter/engine. No Redis or provider. */
export function createReplayFixture() {
  const t = Date.parse('2026-10-04T08:00:00Z');
  const requests = [];
  const cats = [
    {
      id: 'codex61-sol',
      displayName: '缅因猫 Sol（GPT-6.1 Sol）',
      carrier: 'cli',
      clientId: 'openai',
      defaultModel: 'gpt-6.1-sol',
      avatar: '/avatars/codex.png',
      color: { primary: '#587d50', secondary: '#e5eee0' },
      mentionPatterns: ['@codex61-sol'],
    },
    {
      id: 'opus55',
      displayName: '布偶猫',
      carrier: 'cli',
      clientId: 'claude',
      defaultModel: 'claude-opus-5-5',
      avatar: '/avatars/opus.png',
      color: { primary: '#8d68a6', secondary: '#eadcf2' },
      mentionPatterns: ['@opus55'],
    },
  ];
  const messages = [
    {
      from: { kind: 'user', userId: 'default-user' },
      id: 'replay-user-1',
      type: 'user',
      timestamp: t,
      content: '从这条对话里找回我们当时做了什么。',
    },
    {
      from: { kind: 'agent', catId: 'codex61-sol' },
      id: 'replay-sol-1',
      type: 'assistant',
      timestamp: t + 1200,
      catId: 'codex61-sol',
      content: '我先核当前代码，再把实际证据放回这条对话。',
      thinking: '保留真实来源，不能把夹具当成真实验收。',
      toolEvents: [
        { type: 'tool_use', toolUseId: 'read-1', label: 'Read', detail: 'README.md' },
        { type: 'tool_result', toolUseId: 'read-1', status: 'completed', detail: '已读取原始合同。' },
      ],
    },
    {
      from: { kind: 'agent', catId: 'opus55' },
      id: 'replay-opus-1',
      type: 'assistant',
      timestamp: t + 4000,
      catId: 'opus55',
      content: '原来的播放 owner 和完整记录都在，先走一遍实际操作。',
    },
    {
      from: { kind: 'user', userId: 'default-user' },
      id: 'replay-user-2',
      type: 'user',
      timestamp: t + 16000,
      content: '窄栏里也要能读和操作。',
    },
    {
      from: { kind: 'agent', catId: 'codex61-sol' },
      id: 'replay-sol-2',
      type: 'assistant',
      timestamp: t + 736000,
      catId: 'codex61-sol',
      content: '@opus55\n\n内容和控制仍在同一个播放器里；缩窄不会另开一份。',
    },
    {
      from: { kind: 'agent', catId: 'opus55' },
      id: 'replay-opus-2',
      type: 'assistant',
      timestamp: t + 740000,
      catId: 'opus55',
      content: '我会核跳转、速度和返回位置。',
    },
  ].map((message) => ({ ...message, extra: { stream: { turnInvocationId: `child-${message.id}` } } }));
  const transcript = [
    {
      v: 1,
      t: t + 6000,
      threadId: 'fixture-replay',
      catId: 'codex61-sol',
      sessionId: 'sealed-fixture',
      cliSessionId: 'native-fixture',
      eventNo: 0,
      event: { type: 'system_info', content: '原封存记录补充信息' },
    },
  ];
  function reply(req, res, status, body) {
    const origin = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin ?? '')
      ? req.headers.origin
      : 'http://localhost:51184';
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': `Content-Type,X-Cat-Cafe-User,${CLIENT_REQUEST_DIAGNOSTIC_HEADER}`,
      'Access-Control-Allow-Methods': 'GET,OPTIONS,PUT',
    });
    res.end(JSON.stringify(body));
  }
  function handler(req, res) {
    const url = new URL(req.url, 'http://localhost:51185');
    const send = (status, body) => reply(req, res, status, body);
    requests.push({ method: req.method, path: url.pathname, search: url.search });
    if (req.method === 'OPTIONS') return send(200, {});
    if (url.pathname === '/fixture/requests') return send(200, { requests });
    if (url.pathname === '/api/cats') return send(200, { cats });
    if (url.pathname === '/api/threads/fixture-denied/sessions') return send(403, { error: 'fixture access denied' });
    if (url.pathname === '/api/threads/fixture-empty/sessions') return send(200, { sessions: [] });
    if (url.pathname === '/api/threads/fixture-replay/sessions')
      return send(200, {
        sessions: [
          { id: 'sealed-fixture', status: 'sealed' },
          { id: 'active-fixture', status: 'active' },
        ],
      });
    if (url.pathname === '/api/messages')
      return send(200, {
        messages: url.searchParams.get('threadId') === 'fixture-empty' ? [] : messages,
        hasMore: false,
      });
    if (url.pathname === '/api/sessions/sealed-fixture/events') return send(200, { events: transcript });
    if (url.pathname === '/api/config') return send(200, { catOrder: cats.map((cat) => cat.id) });
    if (url.pathname === '/api/threads') return send(200, { threads: [] });
    if (url.pathname === '/api/preferences') return send(200, { preferences: {} });
    if (
      ['/api/session', '/api/config/cat-order', '/api/config/co-creator', '/api/concierge/config'].includes(
        url.pathname,
      )
    )
      return send(200, {});
    return send(404, { error: `No isolated fixture for ${url.pathname}` });
  }
  return { handler, requests };
}
