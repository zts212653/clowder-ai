/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 消息：消息卡片、投递与已读、引用的回复 */
'use strict';
function msgDelivery(list, dir) {
  if (!list || !list.length) return '';
  const people = list.filter(function (d) { return !d.thread; }), threads = list.filter(function (d) { return d.thread; });
  return '<div class="msg-deliv' + (dir === 'left' ? ' end' : '') + '" aria-label="' + h(tc('delivery.label')) + '">' +
    /* 投递头像的执行状态由应用随投递数据给出（live）：组件只按它闪 / 停 */
    capStack(people.map(function (d) { const st = tcOr('delivery.' + d.state, 'delivery.delivered'), c = capWho(d, st, d.state); if (d.detail) c.tip += ' · ' + d.detail; if (d.open) { c.act = d.open.act; c.data = argAttrs(d.open.args); } return c; }), { dir: dir, label: tc('delivery.members') }) +
    '</div>';
}
/* 接收提示（B 的回复里，显示 A 的头像）：已收到 A · 时间 / 已读 A · 时间；悬停保留收到的正文，点一下跳到 A 的那条消息 */
/* 接收状态的字在文案包 delivery 里（received / read） */
function msgRecv(list) {
  if (!list || !list.length) return '';
  const people = list.filter(function (r) { return !r.thread; }), threads = list.filter(function (r) { return r.thread; });
  return '<span class="msg-recv">' + capStack(people.map(function (r) {
    const st = tc('delivery.' + (r.state === 'read' ? 'read' : 'received')), c = capWho(r, st, 'recv ' + r.state);
    return Object.assign(c, { act: 'msgJump', data: ' data-mid="' + h(r.mid || '') + '"', body: c.body + (r.excerpt ? '<span class="cap-ex">' + h(r.excerpt) + '</span>' : '') });
  }), { label: tc('delivery.received') }) + threads.map(function (r) { return capThread(r, 'right', tc('delivery.from')); }).join('') + '</span>';
}
/* 回复引用（一个组件）：这条消息回应的是哪一条。你引用成员的消息、成员回复收到的消息、A2A 里 B 回应 A 的通知，都是同一个含义、同一个组件：
   ↩ + 头像（共用头像组件，文字行高）+ 名字：内容。紧凑宽度（最多约 24em，且不超过作者行的 45%），超出省略，从不撑满一行。
   r = { mid, from, text, state: 'received' | 'read', busy, time }：回应的是收到的那条时，接收状态就挂在这个头像上（处理中是扩散圈），不再另画接收胶囊。点了跳到原文 */
function replyRef(r) {
  if (!r) return '';
  if (typeof r.time === 'number') r = Object.assign({}, r, { time: FORMATS.hm(r.time) });
  const st = r.state ? tc('delivery.' + (r.state === 'read' ? 'read' : 'received')) : '', name = r.from ? who(r.from, 'text') : '';
  const inner = icon('jump', 13) + (r.from ? whoAva(r.from, { size: 'xs', tip: false }) + '<b class="reply-n">' + h(tc('reply.name', name)) + '</b>' : '') + '<span class="reply-t">' + h(r.text) + '</span>';
  const tip = (r.mid ? tc('reply.jump') : '') + (st ? (r.mid ? ' · ' : '') + (name ? name + ' ' : '') + st + (r.time ? ' ' + r.time : '') : '');
  return r.mid ? '<button type="button" class="reply-ref' + (r.state ? ' ' + r.state : '') + '" data-act="msgJump" data-mid="' + h(r.mid) + '" data-tip="' + h(tip) + '">' + inner + '</button>' : '<span class="reply-ref">' + inner + '</span>';
}
function msgFrame(o) {
  const n = o.notes || {}, note = function (k) { return n[k] ? ' data-note="' + n[k] + '"' : ''; };
  if (o.frame === 'day') return '<div class="day">' + h(o.text) + '</div>';
  if (o.frame === 'bare') return o.body;
  /* 发送者：成员、你、插件、系统同一个 from 结构（没有 from 时用 who） */
  const m = o.side === 'right' ? null : o.from || o.who || null, w = m ? whoInfo(m, o.source) : null;   /* 右边只会是你：不画自己的头像和名字 */
  /* 作者行的头部：名字（成员带 @handle）· 标签（悄悄话、引导）· 时间，都在同一行；你的消息不画自己的头像和名字 */
  const tags = (o.tags || []).map(function (t) { return '<span class="cafe-tagt">' + (t.icon ? icon(t.icon, 12) : '') + (t.parts != null ? t.parts : h(t.text)) + '</span>'; }).join('');
  const head = w || tags || o.time ? '<div class="msg-head"' + note('head') + '>' + (w ? '<b class="msg-name"' + whoHover(w, 'author') + '>' + h(w.name) + '</b>' + (w.handle ? '<span class="h">' + h(w.handle) + '</span>' : '') : '') + tags + (o.time ? '<span class="time num">' + h(o.time + (o.receivedAt && o.receivedAt !== o.time ? tc('message.receivedAt', o.receivedAt) : '')) + '</span>' : '') + '</div>' : '';
  const right = o.side === 'right', isMsg = o.frame === 'msg';
  const open = '<div class="cafe-m' + (o.emph || (o.mid && landed(o.mid)) ? ' emph' : '') + (o.picking ? ' picking' : '') + '" data-mid="' + (o.running ? 'typing' : h(o.mid)) + '"' + (o.running && o.mid ? ' data-run="' + h(o.mid) + '"' : '') + '>' + (o.picking && isMsg && !o.running ? cafeCheck(o.picked === 'mixed' ? 'mixed' : !!o.picked, '<span class="sr">' + h(tc('message.select')) + '</span>', 'cafePick', ' data-mid="' + h(o.mid) + '"') : '') + '<div class="cafe-m-in">';
  if (o.frame === 'plain') return open + o.body + '</div></div>';
  if (o.frame === 'line') return open + '<div class="cafe-sysc">' + icon(o.icon || 'info', 14) + '<div class="grow">' + (o.title ? '<b>' + h(o.title) + '</b>' : '') + o.body + '</div>' + (o.time ? '<span class="faint num vw-12">' + h(o.time) + '</span>' : '') + '</div></div></div>';
  /* 消息（一个模板）：你、成员、插件、系统、定时任务都一样——作者行（头像 · 名字 · 时间 + 接收胶囊 + 引用）→ 标签 / 引用的上下文 → 正文 → 卡片下方（执行记录、补充消息）→ 投递胶囊 → 工具条。
     只有两处不同：side（你的在右、别人的在左，作者行、胶囊展开方向、工具条位置都按这一侧镜像；展开时头像在贴住的那一端，文字本身不镜像）
     和 surface（bubble 气泡 | bar 左竖线 | none 正文块自己就是卡片）。其余部分有数据才画。 */
  const surface = o.surface || 'bar';
  const chips = function (l) { return l && l.length ? '<div class="chips">' + l.map(function (c) { return chipHtml({ icon: c.icon, kind: c.kind ? h(c.kind) : '', label: h(c.label) }); }).join('') + '</div>' : ''; };
  const body = surface === 'none' || !o.body ? o.body || '' : '<div class="' + (surface === 'bubble' ? 'bubble' : 'cat-bubble') + (o.running ? ' msg-body typing' : '') + '">' + o.body + '</div>';   /* 还没有正文（正在回复、还没出第一个字）：不画空的正文块，只剩作者行 + 那一行 */
  return open + '<div class="msg ' + (right ? 'user-msg' : 'cat') + '" data-side="' + (right ? 'right' : 'left') + '" data-surface="' + surface + '"' + (o.jump ? ' data-act="msgJump" data-mid="' + h(o.jump.mid) + '" data-t="' + h(o.jump.thread) + '" data-tip="' + h(o.jump.tip || tc('message.jumpSource')) + '"' : '') + ' style="' + whoVar(m, o.source) + (right ? whoMeBubble() : '') + '">' +
    '<div class="author-row">' + (m ? whoAva(m, { size: 'l', click: !right, source: o.source, turn: o.mid || '', place: 'author' }) : '') + head + msgRecv(o.recv) + replyRef(o.quote) + '</div>' + (o.chips || []).map(chips).join('') +
    body + (o.below || '') + msgDelivery(o.delivery, right ? 'left' : 'right') + (o.acts || '') + '</div></div></div>';
}
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  msgAuthor: { g: 'message', via: ['prop:frame'], ex: function (s) { return msgFrame({ frame: 'msg', side: 'left', surface: 'bar', who: s.author.who, time: s.author.time, quote: s.reply, body: '<div class="msg-body">' + h(s.sub) + '</div>' }); } },
  replyRef: { g: 'message', inline: true, via: ['type:reply', 'prop:quote'], ex: function (s) { return replyRef(s.reply); } },
  msgDelivery: { g: 'message', inline: true, via: ['prop:delivery'], ex: function (s) { return msgDelivery(s.delivery, 'left'); } },
  msgRecv: { g: 'message', inline: true, via: ['prop:recv'], ex: function (s) { return msgRecv(s.recv.map(function (r) { return Object.assign({ excerpt: s.sub }, r); })); } }
});
