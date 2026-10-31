// Isolated design fixture. Never reads tools, tokens, accounts or production endpoints.
export const VERSION = 3;
export const DEMO_PROMPT = '帮我写一句欢迎语，让第一次来猫咖的人看懂这里能做什么。';
export const CATS = {
  ragdoll: { name: '布偶猫', nick: '宪宪', color: '#9b7ebd', role: '架构设计与实现', head: [72, 62] },
  maine: { name: '缅因猫', nick: '砚砚', color: '#5b8c5a', role: '代码审阅与质量把关', head: [73, 59] },
  siamese: { name: '暹罗猫', nick: '烁烁', color: '#5b9bd5', role: '创意、设计与表达', head: [72, 69] },
};
export const TOOLS = {
  codex: {
    label: 'Codex',
    cat: 'maine',
    defaultModel: 'GPT-6.1',
    models: ['GPT-6.1', 'GPT-6'],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    login: true,
  },
  claude: {
    label: 'Claude Code',
    cat: 'ragdoll',
    defaultModel: 'Opus',
    models: ['Opus', 'Sonnet', 'Haiku'],
    efforts: ['low', 'medium', 'high'],
    login: true,
  },
  dsh: {
    label: 'DSH',
    cat: 'siamese',
    defaultModel: 'DeepSeek',
    models: ['DeepSeek'],
    efforts: ['off', 'high'],
    login: false,
  },
};
export const SCENARIOS = {
  one: '一个已配置工具',
  many: '多个工具 · 混合状态',
  none: '没有安装工具',
  login: '已安装 · 需要登录',
  unknown: '状态读取失败',
  partial: '部分创建失败',
  'reply-fail': '首条回复失败',
  existing: '已有成员的老用户',
};
const ready = (tool) => tool?.installed && tool.status === 'ready';
export const selected = (s) => Object.values(s.candidates).filter((c) => c.selected && ready(s.tools[c.tool]));
export const canCreate = (s) =>
  s.stage === 'setup' &&
  selected(s).length > 0 &&
  Object.values(s.candidates)
    .filter((c) => c.selected)
    .every((c) => ready(s.tools[c.tool]));
export function initial(fixture = 'one') {
  const tools = Object.fromEntries(
    Object.keys(TOOLS).map((id) => [id, { installed: false, status: 'missing', auth: 'native' }]),
  );
  if (fixture !== 'none')
    tools.codex = {
      installed: true,
      status: fixture === 'login' ? 'login' : fixture === 'unknown' ? 'unknown' : 'ready',
      auth: 'native',
    };
  if (fixture === 'many' || fixture === 'partial') {
    tools.claude = { installed: true, status: fixture === 'partial' ? 'ready' : 'login', auth: 'native' };
    if (fixture === 'many') tools.dsh = { installed: true, status: 'ready', auth: 'native-api' };
  }
  const candidates = Object.fromEntries(
    Object.entries(TOOLS).map(([id, tool]) => [
      id,
      {
        id: `preview-${id}`,
        key: id,
        tool: id,
        cat: tool.cat,
        name: CATS[tool.cat].name,
        nickname: CATS[tool.cat].nick,
        role: CATS[tool.cat].role,
        selected: ready(tools[id]),
        choice: false,
        model: '',
        effort: '',
        account: 'native',
      },
    ]),
  );
  const s = {
    v: VERSION,
    fixture,
    stage: 'welcome',
    view: 'journey',
    scene: 0,
    demoTyped: 0,
    paused: true,
    narrator: 'maine',
    demoStatus: 'unhandled',
    tools,
    candidates,
    members: [],
    accounts: [],
    messages: [],
    draft: '',
    exchange: 'none',
    guide: 'unhandled',
    pins: ['members', 'accounts'],
    pinPolicy: 'original',
    error: '',
    loginId: '',
    editorId: '',
    returnView: 'journey',
    createAttempt: 0,
    replyAttempt: 0,
  };
  if (fixture === 'existing') {
    Object.assign(candidates.codex, { id: 'existing-member', name: '我的审阅伙伴' });
    s.members = [{ ...candidates.codex }];
    Object.assign(s, { stage: 'chat', guide: 'not-needed', demoStatus: 'not-needed', pins: [] });
  }
  return s;
}
export function reduce(state, a) {
  const s = structuredClone(state);
  const tool = s.tools[a.id];
  const candidate = s.candidates[a.id];
  switch (a.type) {
    case 'start':
      Object.assign(s, { stage: 'demo', scene: 0, demoTyped: 0, paused: false });
      break;
    case 'pause':
      s.paused = !s.paused;
      break;
    case 'scene':
      s.scene = Math.max(0, Math.min(4, s.scene + a.delta));
      s.paused = true;
      break;
    case 'tick':
      if (s.stage === 'demo' && !s.paused) {
        s.scene = Math.min(4, s.scene + 1);
        if (s.scene === 4) {
          s.paused = true;
          s.demoStatus = 'completed';
        }
      }
      break;
    case 'setup':
      Object.assign(s, {
        stage: 'setup',
        view: 'journey',
        paused: true,
        demoStatus: s.scene === 4 ? 'completed' : 'skipped',
      });
      break;
    case 'typeChar':
      if (s.stage === 'demo' && !s.paused) s.demoTyped = Math.min(DEMO_PROMPT.length, (s.demoTyped || 0) + 1);
      break;
    case 'toggle':
      if (candidate && (candidate.selected || ready(s.tools[candidate.tool]))) {
        candidate.selected = !candidate.selected;
        candidate.choice = true;
      }
      break;
    case 'edit':
      if (candidate) Object.assign(candidate, a.patch);
      break;
    case 'selectTool':
      if (candidate && TOOLS[a.tool]) {
        candidate.toolDrafts = {
          ...candidate.toolDrafts,
          [candidate.tool]: { model: candidate.model, effort: candidate.effort, account: candidate.account },
        };
        Object.assign(candidate, candidate.toolDrafts[a.tool] || { model: '', effort: '', account: 'native' });
        candidate.tool = a.tool;
      }
      break;
    case 'openEditor':
      s.editorId = a.id;
      s.editorBaseline = structuredClone(candidate);
      s.returnView = s.view;
      s.view = 'editor';
      break;
    case 'closeEditor':
      s.view = s.returnView;
      s.editorId = '';
      break;
    case 'navigate':
      s.view = a.view;
      s.error = '';
      break;
    case 'login':
      if (tool?.installed && tool.status !== 'ready') {
        tool.status = 'pending';
        s.loginId = a.id;
        s.accountReturn = s.view;
        s.view = 'accounts';
      }
      break;
    case 'cancelLogin':
      if (tool?.status === 'pending') tool.status = 'login';
      break;
    case 'loginResult':
      if (tool?.status === 'pending') {
        tool.status = a.status;
        if (a.status === 'ready' && !candidate.choice) candidate.selected = true;
      }
      break;
    case 'detected':
      if (tool) {
        tool.installed = true;
        tool.status = a.status;
        if (!candidate.choice) candidate.selected = a.status === 'ready';
      }
      break;
    case 'create': {
      if (!canCreate(s)) break;
      const choices = selected(s);
      s.createAttempt += 1;
      for (let i = 0; i < choices.length; i++) {
        if (s.fixture === 'partial' && s.createAttempt === 1 && i === 1) continue;
        if (!s.members.some((m) => m.id === choices[i].id)) s.members.push({ ...choices[i] });
      }
      const complete = choices.every((c) => s.members.some((m) => m.id === c.id));
      s.error = complete ? '' : '有 1 位伙伴暂时未保存。已加入的伙伴会保留，重试不会重复创建。';
      if (complete) s.stage = 'handoff';
      break;
    }
    case 'useCreated':
      if (s.members.length) {
        s.stage = 'handoff';
        s.error = '';
      }
      break;
    case 'chat':
      if (s.members.length) {
        s.stage = 'chat';
        s.view = 'journey';
      }
      break;
    case 'draft':
      s.draft = a.text;
      break;
    case 'send':
      if (s.stage === 'chat' && s.draft.trim() && s.exchange !== 'sent') {
        s.messages.push({ from: 'user', text: s.draft.trim() });
        s.draft = '';
        s.exchange = 'sent';
      }
      break;
    case 'reply':
      if (!['sent', 'failed'].includes(s.exchange)) break;
      s.replyAttempt += 1;
      if (s.fixture === 'reply-fail' && s.replyAttempt === 1) s.exchange = 'failed';
      else {
        const text = s.messages.filter((m) => m.from === 'user').at(-1)?.text ?? '';
        s.messages.push({
          from: 'cat',
          text: text.includes('整理任务')
            ? '先确认三个问题：\n1. 团队有几个人，谁负责分配任务？\n2. 现在最容易遗漏的是截止时间，还是进度更新？\n3. 第一版需要接入现有工具吗？\n\n第一版可以先做：创建任务、明确负责人、查看进度。等你回答后，我们再一起收窄范围。'
            : `我收到你的想法了：“${text}”\n\n我们可以先明确你想得到的结果，再把第一步拆小。你希望最后得到一份方案、一段代码，还是一份修改建议？`,
          simulated: true,
        });
        s.exchange = 'replied';
      }
      break;
    case 'guide':
      s.guide = a.status;
      break;
    case 'pin':
      s.pins = s.pins.includes(a.id) ? s.pins.filter((x) => x !== a.id) : [...s.pins, a.id];
      break;
    case 'pinPolicy':
      s.pinPolicy = a.policy;
      s.pins = a.policy === 'original' ? ['members', 'accounts'] : [];
      break;
    case 'addAccount':
      if (!s.accounts.some((x) => x.status === 'pending'))
        s.accounts.push({ id: `extra-${s.accounts.length + 1}`, name: a.name, status: 'pending', used: false });
      break;
    case 'accountResult': {
      const account = s.accounts.find((x) => x.status === 'pending');
      if (account) account.status = a.status;
      break;
    }
    case 'retryAccount': {
      const account = s.accounts.find((x) => x.id === a.id);
      if (account) account.status = 'pending';
      break;
    }
    default:
      break;
  }
  return s;
}
export function restore(raw) {
  try {
    const s = JSON.parse(raw);
    if (s?.v !== VERSION || !s.tools || !s.candidates || !Array.isArray(s.members) || !Array.isArray(s.messages))
      return null;
    if (!['welcome', 'demo', 'setup', 'handoff', 'chat'].includes(s.stage)) return null;
    return s;
  } catch {
    return null;
  }
}
