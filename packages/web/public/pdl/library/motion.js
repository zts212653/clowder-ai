/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 节拍：所有状态循环（执行中、圆点、骨架、光标）共用的周期与相位 */
'use strict';

/* 全局节拍：状态循环是一组预设（关键帧名 mo-*：执行中的圈、行上的圆点、录音点、骨架、光标），
   同一个周期 --loop = 2 拍，各自在周期里脉冲固定的次数。相位不进 HTML（节点的“版本”就是它的 outerHTML），整个系统只算一次：
   - 诞生：新出现的循环马上动，接在共用周期现在的位置上（起点放在上一个 2 拍边界，唯一的一次计算）；
   - 同一个位置上的循环（整页重画换掉了节点、状态没变）：接着原来的起点走（照抄起点，不算）；
   - 状态变了（预设换了名字）：先接着放原来的预设（--mo-hold），新预设记在 data-preset-next，等这一圈放完（animationiteration，正好在 2 拍边界上）再换；
     换上的新预设照抄原来的起点，所以从格子上开始。
   “同一个位置”按树认：树键（treeKey，带身份的祖先一路串起来）+ 到最近的带身份祖先的序号 + 伪元素。 */
const BEAT_LIVE = [];
function loopKey(el, pseudo) {
  const p = [pseudo || ''];
  let n = el;
  for (; n && n !== document.body && !(n !== el && nodeId(n)); n = n.parentElement) p.push(n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) : 0);
  return p.join('/') + '@' + (n && n !== document.body ? treeKey(n) : '');
}
/* 不在页面上超过一个周期的记录才丢（同一次重画里换掉的节点要等新节点的 animationstart 来认领） */
RENDER_BEFORE.push(function () {
  const now = document.timeline.currentTime, L = ms('--beat') * 2;
  for (let i = BEAT_LIVE.length - 1; i >= 0; i--) { const x = BEAT_LIVE[i]; if (x.el.isConnected) x.gone = null; else if (x.gone == null) x.gone = now; else if (now - x.gone > L) BEAT_LIVE.splice(i, 1); }
});
function beatAnims(e) { return e.target.getAnimations().concat(e.pseudoElement ? e.target.getAnimations({ subtree: true }).filter(function (a) { return a.effect && a.effect.pseudoElement === e.pseudoElement; }) : []).filter(function (a) { return a.animationName === e.animationName; }); }
document.addEventListener('animationstart', function (e) {
  if (!e.target.getAnimations) return;
  const roll = e.animationName === 'roll-up';
  if (!/^mo-|^rot$/.test(e.animationName) && !roll) return;
  beatAnims(e).forEach(function (a) {
    if (a.__beat) return;
    a.__beat = 1;
    if (roll) {   /* 轮换的一行：时间原点是这个动作开始的时刻（data-at，数据）——过去了多久，动画就接在哪儿 */
      const at = +((e.target.closest('[data-at]') || {}).dataset || {}).at; if (at) a.startTime = at - performance.timeOrigin;
      return;
    }
    const key = loopKey(e.target, e.pseudoElement), i = BEAT_LIVE.findIndex(function (x) { return x.key === key && (x.el === e.target || !x.el.isConnected); }), was = i >= 0 ? BEAT_LIVE.splice(i, 1)[0] : null;
    if (!was) { const L = ms('--beat') * 2; a.startTime = Math.floor(document.timeline.currentTime / L) * L; }   /* 诞生：马上动，接在共用周期现在的位置上（起点是上一个 2 拍边界） */
    else {
      a.startTime = was.start;
      if (was.name !== e.animationName && !was.next && /^mo-/.test(was.name)) {   /* 状态变了：这一圈先放完原来的预设，新预设等着 */
        const t = e.target; t.style.setProperty('--mo-hold', was.name); t.setAttribute('data-preset-next', e.animationName);
        BEAT_LIVE.push({ el: e.target, key: key, name: was.name, start: was.start, gone: null });   /* 换回原来的预设会再来一次 animationstart，接着这个起点 */
        return;
      }
    }
    BEAT_LIVE.push({ el: e.target, key: key, name: e.animationName, start: a.startTime, gone: null });
  });
});
/* 一圈放完（正好在 2 拍边界上）：有等着的新预设就换上 */
document.addEventListener('animationiteration', function (e) {
  const t = e.target; if (!t.hasAttribute || !t.hasAttribute('data-preset-next') || !/^mo-/.test(e.animationName)) return;
  const key = loopKey(t, e.pseudoElement), x = BEAT_LIVE.find(function (r) { return r.el === t && r.key === key; });   /* 元素自己和它的伪元素各有一圈：按同一个键找 */
  if (!x || document.timeline.currentTime - x.start - e.elapsedTime * 1000 > ms('--beat') / 10) return;   /* 接上原来的起点时浏览器会补发一次“过了一圈”（不在边界上），那不是这一圈放完 */
  x.next = 1;
  t.style.removeProperty('--mo-hold'); t.removeAttribute('data-preset-next');
});
