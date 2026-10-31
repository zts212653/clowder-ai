// Isolated design fixture. This is not Host task, message, or capture authority.
export const initialState = () => ({
  installed: false,
  enabled: false,
  connected: false,
  sharing: false,
  target: 'B站窗口',
  follow: false,
  generation: 0,
  thinking: null,
  point: null,
  messages: [],
  moments: [],
  notice: '',
  view: 'setup',
});

export function reduce(state, action) {
  const next = { ...state, notice: '' };
  switch (action.type) {
    case 'install':
      return { ...next, installed: true };
    case 'enable':
      return state.installed ? { ...next, enabled: true, view: 'companion' } : state;
    case 'disable':
      return { ...next, enabled: false, connected: false, sharing: false, point: null, view: 'setup' };
    case 'start':
      return state.enabled ? { ...next, connected: true, sharing: true, view: 'companion' } : state;
    case 'pause':
      return { ...next, sharing: false, point: null, notice: '已暂停共享，已承接的思考仍可继续。' };
    case 'end':
      return {
        ...next,
        connected: false,
        sharing: false,
        point: null,
        notice: '这段陪伴先到这里，交流与记下的片刻仍在。',
      };
    case 'disconnect':
      return {
        ...next,
        connected: false,
        sharing: false,
        point: null,
        notice: '连接中断。内容还在，重新连接后由你恢复共享。',
      };
    case 'reconnect':
      return state.enabled
        ? { ...next, connected: true, sharing: false, notice: '已重新连接。确认当前窗口后再恢复共享。' }
        : state;
    case 'view':
      return ['setup', 'companion', 'moments'].includes(action.view) ? { ...next, view: action.view } : state;
    case 'follow':
      return typeof action.value === 'boolean' ? { ...next, follow: action.value } : state;
    case 'target':
    case 'point':
      return updatePointing(state, action);
    case 'clear-point':
      return { ...next, point: null };
    case 'say':
    case 'think':
    case 'answer':
    case 'remember':
      return updateConversation(state, action);
    default:
      return state;
  }
}

function updateConversation(state, action) {
  const next = { ...state, notice: '' };
  const text = typeof action.text === 'string' ? action.text.trim().slice(0, 2000) : '';
  switch (action.type) {
    case 'say':
      if (!text) return state;
      return {
        ...next,
        generation: state.generation + 1,
        messages: [...state.messages, { speaker: '你', text, target: state.target }],
        notice: state.thinking ? '补充已进入当前思考；旧结论会先核对。' : '',
      };
    case 'think':
      return {
        ...next,
        thinking: { generation: state.generation, target: state.target },
        notice: '我在核对这处阴影，你继续说。',
      };
    case 'answer':
      if (!text) return state;
      if (action.generation !== state.generation)
        return { ...next, notice: '这条回答依据旧画面，未播出，需按当前目标核对。' };
      return {
        ...next,
        messages: [...state.messages, { speaker: '砚砚', text, target: state.target }],
        thinking: action.question ? state.thinking : null,
      };
    case 'remember':
      if (!text) return { ...next, notice: '先写一句你想留下的内容。' };
      return {
        ...next,
        moments: [...state.moments, { text, target: state.target, point: state.point }],
        notice: '已记下这句话。体验稿只保存文字与指点坐标，不保存画面。',
      };
    default:
      return state;
  }
}

function updatePointing(state, action) {
  const next = { ...state, notice: '' };
  switch (action.type) {
    case 'target':
      if (!['B站窗口', 'Blender窗口', '会议窗口', '只聊一会儿'].includes(action.target)) return state;
      {
        const follows =
          state.follow &&
          state.sharing &&
          ['B站窗口', 'Blender窗口'].includes(state.target) &&
          ['B站窗口', 'Blender窗口'].includes(action.target);
        return {
          ...next,
          target: action.target,
          sharing: follows,
          point: null,
          generation: state.generation + 1,
          notice: follows ? '仍在这次选定的范围内，接着一起看。旧指点已清除。' : '话题跟着你。新窗口需你确认后才共享。',
        };
      }
    case 'point':
      if (!state.sharing || !Number.isFinite(action.x) || !Number.isFinite(action.y)) return state;
      return {
        ...next,
        point: { x: Math.round(action.x), y: Math.round(action.y), target: state.target, generation: state.generation },
      };
    default:
      return state;
  }
}

export function restore(saved) {
  return {
    ...initialState(),
    ...saved,
    connected: false,
    sharing: false,
    point: null,
    notice: '交流已找回。当前没有共享，确认后再开始。',
  };
}
