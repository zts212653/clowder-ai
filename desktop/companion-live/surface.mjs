import { ConnectionEpoch } from './epoch.mjs';
import { VoicePeer } from './peer.mjs';
import { ScreenShare } from './screen-share.mjs';
import { TranscriptView } from './transcript-view.mjs';

const $ = (id) => document.getElementById(id);
let mode;
let peer;
const epoch = new ConnectionEpoch();
let active = false;
let expanded = false;
let muted = false;
let silent = false;
let deadline;
let meter;
let sharing = false;
let sharePending = false;
let screenShare;
let typedInput;
let sendingText = false;
const listeningStatus = () => (muted ? '麦克风已静音' : '正在听，直接说话就好');
const accessLabel = () =>
  mode.hostBacked
    ? `资料查询 · ${mode.documentsAllowed ? '开启' : '暂停'}`
    : `资料权限 · ${mode.documentsAllowed ? '已允许' : '未开放'}`;
const transcriptView = new TranscriptView($('transcript'));
const status = (text) => {
  $('status').textContent = text;
  $('status').title = text;
  $('orb').setAttribute('aria-label', text);
};
function append(role, text, chunk = false) {
  transcriptView.append(role, text, chunk);
}
function details(value) {
  expanded = value;
  $('details').hidden = !value;
  $('write').setAttribute('aria-expanded', String(value));
  $('write').querySelector('span').textContent = value ? '收起文字' : '文字';
  window.live.resize(value);
}
function audioControls() {
  for (const [id, off, labelOn, labelOff, description] of [
    ['mic', muted, '静音', '取消静音', '麦克风'],
    ['speaker', silent, '关声音', '开声音', '播音'],
  ]) {
    const button = $(id);
    button.setAttribute('aria-pressed', String(off));
    button.setAttribute('aria-label', `${off ? '开启' : '关闭'}${description}`);
    button.title = button.getAttribute('aria-label');
    button.querySelector('span').textContent = off ? labelOff : labelOn;
  }
}
async function end(message = '语音已结束 · 麦克风已关闭', reason = 'user-ended') {
  if (!active) return;
  window.live.record({ type: 'stopping', reason });
  const closing = peer;
  const endedEpoch = epoch.end();
  active = false;
  const stoppedScreen = screenShare?.stop().catch(() => {});
  peer = undefined;
  clearTimeout(deadline);
  clearInterval(meter);
  document.body.className = '';
  $('controls').hidden = true;
  $('share').hidden = true;
  $('idle').hidden = false;
  $('begin').disabled = true;
  $('documents').textContent = accessLabel();
  status(message);
  details(false);
  if (closing) {
    const audio = await closing.close();
    if (audio && mode.synthetic) await window.live.audioEvidence(audio);
  }
  await stoppedScreen;
  await window.live.stop().catch(() => {
    if (mode.hostBacked && epoch.value === endedEpoch) status('麦克风已关闭 · 连接收尾尚未确认');
  });
  window.live.record({ type: 'stopped', microphoneTracksLive: false });
  if (epoch.value === endedEpoch) $('begin').disabled = false;
}
async function begin({ preserveControls = false } = {}) {
  if (active) return;
  active = true;
  const current = epoch.begin();
  typedInput = undefined;
  transcriptView.reset();
  if (!preserveControls) {
    muted = false;
    silent = false;
  }
  $('idle').hidden = true;
  $('controls').hidden = false;
  audioControls();
  document.body.className = 'connecting';
  status('正在连接砚砚…');
  $('documents').textContent = mode.documentsAllowed ? '资料工具 · 连接中' : accessLabel();
  deadline = setTimeout(() => {
    if (epoch.current(current)) void end('连接超时 · 点击聊聊重试', 'start-timeout');
  }, 60000);
  const created = new VoicePeer((event) => {
    if (!epoch.current(current)) return;
    if (event.type === 'connected') {
      clearTimeout(deadline);
      document.body.className = 'connected';
      status(mode.synthetic ? '合成输入验证 · 未用麦克风' : listeningStatus());
      $('share').hidden = mode.synthetic;
      if (mode.synthetic)
        void window.live
          .fixture()
          .then((data) => created.playFixture(data))
          .catch((error) => void end(error.message, 'fixture-failed'));
      meter = setInterval(
        () =>
          void created
            .stats()
            .then((value) => window.live.record(value))
            .catch(() => {}),
        15000,
      );
    }
    if (event.type === 'transport') window.live.record(event);
    if (event.type === 'recovering') status('连接暂时中断 · 正在等待恢复');
    if (event.type === 'recovered') status(listeningStatus());
    if (event.type === 'transcript') {
      append(event.role, event.text, true);
      window.live.record(event);
    }
    if (event.type === 'turn-done') {
      window.live.record({ ...event, type: 'transcript-boundary' });
      transcriptView.finish(event);
      status(mode.synthetic ? '合成输入验证 · 未用麦克风' : listeningStatus());
    }
    if (event.type === 'error') {
      window.live.record(event);
      void end(event.message, event.reason || 'provider-data-error');
    }
  });
  peer = created;
  created.muteMic(muted);
  created.muteSpeaker(silent);
  try {
    await window.live.arm();
    if (!epoch.current(current)) return;
    const offer = await created.offer(mode.synthetic);
    if (!epoch.current(current)) {
      await created.close();
      return;
    }
    await window.live.start(offer);
  } catch (error) {
    if (epoch.current(current))
      await end(
        error.message.includes('Permission') ? '未获得麦克风权限 · 点击聊聊重试' : error.message,
        'start-failed',
      );
  }
}
if (!window.live) {
  status('请在原生猫猫球中使用');
  $('begin').disabled = true;
} else {
  mode = await window.live.info();
  $('connection-scope').textContent = mode.hostOrigin
    ? `实验资料库 · ${new URL(mode.hostOrigin).host}`
    : mode.hostBacked
      ? '实验资料库'
      : '实验资料库 · 功能文档';
  screenShare = new ScreenShare(window.live, (state) => {
    sharing = state.sharing;
    sharePending = state.pending === true;
    $('share').textContent = sharing ? '停止共享' : sharePending ? '取消选屏' : '共享屏幕';
    $('share').setAttribute('aria-pressed', String(sharing));
    $('screen-status').hidden = !active || (!sharing && !sharePending && state.message === '未共享屏幕');
    $('screen-status').textContent = sharing ? `正在共享：${state.label}` : state.message;
    $('screen-status').dataset.state = sharing ? 'sharing' : sharePending ? 'pending' : 'stopped';
  });
  $('share').onclick = () => {
    if (sharing || sharePending) void screenShare.stop('屏幕共享已停止');
    else void screenShare.start();
  };
  $('documents').hidden = mode.synthetic && !mode.hostBacked;
  $('documents').textContent = accessLabel();
  $('documents').onclick = async () => {
    $('documents').disabled = true;
    try {
      const result = await window.live.documents();
      mode.documentsAllowed = result.allowed;
      $('documents').textContent = accessLabel();
      if (result.changed && active) {
        await end('资料权限已更新', 'document-access-changed');
        if (result.allowed) await begin({ preserveControls: true });
      }
    } catch (error) {
      status(error.message);
    } finally {
      $('documents').disabled = false;
    }
  };
  if (mode.synthetic) {
    $('begin').textContent = '验证语音与工具';
    status('合成输入验证 · 未用麦克风');
  }
  window.live.onEvent((event) => {
    if (event.type === 'screen-stopped') {
      void screenShare.stop();
      return;
    }
    if (event.type === 'document-access-revoked') {
      mode.documentsAllowed = false;
      $('documents').textContent = accessLabel();
      if (active) void end('资料访问已撤回 · 麦克风已关闭', 'document-access-revoked');
      return;
    }
    if (!active) return;
    if (event.type === 'tools-ready')
      $('documents').textContent = event.state === 'connected' ? '资料工具 · 已连接' : '资料工具 · 未连接';
    if (event.type === 'tools-unavailable') $('documents').textContent = '资料工具 · 连接失败';
    if (event.type === 'answer')
      void peer?.answer(event.sdp).catch((error) => void end(error.message, 'answer-failed'));
    if (event.type === 'failure') void end(event.message, 'native-failure');
    if (event.type === 'closed') void end('连接已结束 · 点击聊聊继续', 'native-closed');
    if (event.type === 'tool') {
      const names = {
        cat_cafe_search_evidence: '查家里的资料',
        cat_cafe_graph_resolve: '查功能关联',
        cat_cafe_list_recent: '看最近的记录',
        cat_cafe_read_file_slice: '读原文',
      };
      const label = names[event.name] || '查资料';
      status(
        event.phase === 'item/started'
          ? `${label}，你可以继续说`
          : event.status === 'failed'
            ? '这次没有查到'
            : '查到了，正在接着说',
      );
      if (event.phase === 'item/completed')
        append('tool', `${label} · ${event.status === 'failed' ? '未成功' : '已返回'}`);
    }
  });
  $('begin').onclick = begin;
  $('end').onclick = () => void end();
  $('write').onclick = () => details(!expanded);
  $('collapse').onclick = () => details(false);
  $('mic').onclick = () => {
    muted = !muted;
    peer?.muteMic(muted);
    audioControls();
    status(listeningStatus());
  };
  $('speaker').onclick = () => {
    silent = !silent;
    peer?.muteSpeaker(silent);
    audioControls();
  };
  $('compose').onsubmit = async (event) => {
    event.preventDefault();
    const text = $('message').value.trim();
    if (!text || !active || sendingText) return;
    if (!typedInput || typedInput.text !== text) typedInput = { text, id: crypto.randomUUID() };
    const submitted = typedInput;
    const current = epoch.value;
    sendingText = true;
    try {
      await window.live.text(text, submitted.id);
      if (!epoch.current(current)) return;
      append('user', text);
      if ($('message').value.trim() === text) $('message').value = '';
      if (typedInput === submitted) typedInput = undefined;
    } catch (error) {
      if (epoch.current(current)) status(error.message);
    } finally {
      sendingText = false;
    }
  };
  window.addEventListener('beforeunload', () => {
    void peer?.close();
    void window.live.stop();
  });
}
