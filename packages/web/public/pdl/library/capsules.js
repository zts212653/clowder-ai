/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 胶囊：执行道和状态的胶囊、胶囊堆 */
'use strict';


/* 胶囊：收起时范围刚好是一个圆（只露 lead），悬停展开成两端半圆的长条，露出 body。
   lead 和 body 都是内容（通常是身份 + 状态 + 操作），由使用方按胶囊的规则选择：收起时只给头像。
   展开浮在上层，不挤开旁边的元素；离开后停 --reveal-hold 再收回。
   o: { lead, body, act, data, tip, cls, style } */
function capsule(o) {
  /* dir: 'right'（默认，向右展开）| 'left'（底贴住右边，内容从头像左侧长出来）——胶囊朝它所在的那一侧展开；
     有展开内容时不再加原生提示（展开的内容就是提示），只留给读屏的 aria-label */
  const tipAttr = o.tip ? (o.body ? ' aria-label="' + h(o.tip) + '"' : ' data-tip="' + h(o.tip) + '"') : '';
  const st = o.style || '';
  return '<div class="cap' + (o.dir === 'left' ? ' cap-left' : '') + (o.cls ? ' ' + o.cls : '') + '"' + (st ? ' style="' + st + '"' : '') + ' tabindex="0"' + (o.act ? ' role="button" data-act="' + o.act + '"' + (o.data || '') : '') + tipAttr + '>' +
    '<span class="cap-pill"><span class="cap-lead">' + o.lead + '</span>' + (o.body ? '<span class="cap-x">' + o.body + '</span>' : '') + '</span></div>';
}

/* 胶囊堆叠：几个胶囊叠在一起，每项占一个固定的位、压住相邻一项的一半，只露头像。向右长的（输入框、左边消息下面）后一项压前一项，生长端的最后一项完整露出；
   向左长的（你的消息下面，dir: 'left'）镜像：前一项压后一项。悬停一项：它升到最上层、只有它自己向生长方向打开文字（名字 状态 时间；头像在贴住的那一端，向左长的头像在右——布局镜像，文字仍从左往右读），
   盖住生长方向上的邻居；位置不重排，同一时刻只有一项展开。
   展开的层浮在上面（浮层层级），可以盖住旁边的元素；静止时按正常排版占位，不和邻居重叠。size：s（消息下面）| m（输入框上） */
function capStack(items, o) {
  o = o || {}; if (!items.length) return '';
  return '<span class="rstack' + (o.dir === 'left' ? ' end' : '') + (o.size === 'm' ? ' m' : '') + '" style="--n:' + items.length + '"' + (o.label ? ' aria-label="' + h(o.label) + '"' : '') + '><span class="rstack-in">' +
    items.map(function (it, i) { return capsule(Object.assign({}, it, { dir: o.dir, style: (it.style ? it.style + ';' : '') + '--z:' + (o.dir === 'left' ? items.length - i : i + 1) })); }).join('') + '</span></span>';
}

/* 横向滚动道里的胶囊（组件库）：道会裁掉展开层，所以悬停时把胶囊本体（.cap-pill）作为 popover 显示在顶层，锚在自己的胶囊上——节点不搬、不留占位。
   展开态是胶囊本体上的 data-hot（指针在上面），展开 / 收起的过渡照常由样式驱动；离开后去掉 data-hot（样式里收起先停 --reveal-hold），收完再退出顶层。
   最后悬停的在最上层（重新进入顶层）。悬停中的胶囊按位置键（loopKey，和节拍同一个）记在 CAP_HOT，收回的计时按键找到当时的那个胶囊。
   整页重画把节点移出过文档时浏览器会关掉它的顶层状态（不发事件）：没在顶层的本体就是普通的胶囊本体（样式不藏它），指针一动就重新进入顶层 */
const CAP_TOP = '.scroll-x .cap', CAP_HOT = {};   /* 位置键 → 收回的计时（0 = 指针还在上面） */
function capPill(cap) { return cap && cap.querySelector(':scope > .cap-pill'); }
function capLift(cap, hot) {
  const pl = capPill(cap); if (!pl) return;
  if (pl.matches(':popover-open')) pl.hidePopover();   /* 已经在顶层：重新进入，升到最上面 */
  pl.setAttribute('popover', 'manual'); pl.showPopover();
  pl.toggleAttribute('data-hot', hot);
}
function capOff(cap) { const pl = capPill(cap); if (!pl) return; pl.removeAttribute('data-hot'); if (pl.matches(':popover-open')) pl.hidePopover(); pl.removeAttribute('popover'); }
function capFind(k) { return Array.prototype.find.call(document.querySelectorAll(CAP_TOP), function (c) { return loopKey(c) === k; }); }
document.addEventListener('pointerover', function (e) {
  if (e.target.closest && e.target.closest('.edit-layout')) return;   /* 编辑布局是只读的：悬停不展开（看 body 上的 edit-layout） */
  const cap = e.target.closest ? e.target.closest(CAP_TOP) : null; if (!cap || (e.relatedTarget && cap.contains(e.relatedTarget))) return;
  const k = loopKey(cap); clearTimeout(CAP_HOT[k]); CAP_HOT[k] = 0;
  capLift(cap, true);
});
document.addEventListener('pointerout', function (e) {
  const cap = e.target.closest ? e.target.closest(CAP_TOP) : null; if (!cap || (e.relatedTarget && cap.contains(e.relatedTarget))) return;
  const k = loopKey(cap), pl = capPill(cap); if (pl) pl.removeAttribute('data-hot');
  CAP_HOT[k] = setTimeout(function () { delete CAP_HOT[k]; const c = capFind(k); if (c) capOff(c); }, ms('--reveal-hold') + ms('--dur-med'));
});
/* 点了展开层里的东西（跳转、打开详情、停止）：动作照常执行，展开层立刻收回 */
document.addEventListener('click', function (e) { const cap = e.target.closest ? e.target.closest(CAP_TOP) : null; if (!cap) return; const k = loopKey(cap); setTimeout(function () { clearTimeout(CAP_HOT[k]); delete CAP_HOT[k]; const c = capFind(k); if (c) capOff(c); }, 0); });

/* ───────── 消息卡片（msgFrame）：消息流里每条消息的外壳，组件库组件 ─────────
   节点模板只绑定字段、给出正文块；外壳的结构只在这里：
     frame  cat（作者行 + 卡片 + 卡片下方）| mine（你的气泡）| line（系统类卡片）| day（日期分隔）| typing（正在回复）| bare（原样）
     who time badges quote          作者行（quote = 回复引用 replyRef 的数据 { mid, from, text, state }，点了跳到原文）
     card   bubble（正文包在卡片里）| none（正文块自己就是卡片，如来信、提问）
     body   卡片里的内容；below 卡片下方（批注、过程记录）
     delivery  投递状态胶囊（{ who, state, time, detail, open: { act, args } }）；点击只执行声明的打开动作
     tags chips  你的消息上方的标签和引用
     icon title  系统类卡片
     emph   跳转强调（卡片边框闪一圈主题色）；picking / picked 多选
     acts   消息工具条（来自“消息操作”插槽），side 决定靠哪边 */
/* 投递状态（A 发给 B，A 的消息下方）：已投递 B · 时间 / 已读 B · 时间；B 处理中时胶囊持续闪烁，直到 B 这一轮进入终态。
   悬停不显示正文（正文就在当前消息里）。胶囊朝它所在的一侧展开（猫的消息向右，你的消息向左） */
/* 投递状态的文案：已投递 → 已读；处理中“收到，正在回…”；核对中 / 没确认收到 / 没送到 */
/* 投递状态的字在文案包 delivery 里（键和接口的投递状态同名） */
/* 目标是对话的胶囊（跨对话投递）：收起只露对话图标；悬停展开“已投递 → 对话名 · 时间”；点了跳到目标对话里的那一条 */
function capThread(d, dir, verb) {
  if (typeof d.time === 'number') d = Object.assign({}, d, { time: FORMATS.hm(d.time) });
  return capsule({ dir: dir, cls: 'cap-sm cap-thread ' + (d.state || ''), act: 'msgJump', data: ' data-mid="' + h(d.mid || '') + '" data-t="' + h(d.thread) + '"', tip: verb + ' ' + d.title + (d.time ? ' · ' + d.time : ''),
    lead: '<span class="cap-ic">' + icon('chat', 11) + '</span>', body: '<span class="cap-state">' + h(verb) + '</span> <b>' + h(d.title) + '</b>' + (d.time ? ' <span class="num faint">· ' + h(d.time) + '</span>' : '') });
}
/* 状态胶囊（一个组件，两档大小：size 'l' 在输入框上、默认 s 在消息下方）：输入框左上角“正在执行的成员”、你的消息下方的投递 / 已读、成员 A 发给 B 时 A 消息下方 B 的收到 / 已读 / 处理中，都是它。
   只有文字随场景不同；头像、执行中的扩散圈（同一动效、同一节拍）、叠放、展开方式都一样。展开后的一行永远是 [头像] 名字 状态 时间（st 可以带标记时 html 为真） */
function capWho(d, st, extra, html, size) {
  if (typeof d.time === 'number') d = Object.assign({}, d, { time: FORMATS.hm(d.time) });
  const w = whoInfo(d.who), stTxt = html ? st.replace(/<[^>]+>/g, '') : st;
  /* 执行中 / 卡住画在头像上：头像组件自己从成员的实时执行状态读，调用方不传 */
  return { cls: (size === 'm' ? 'cap-m' : 'cap-sm') + ' scap ' + (extra || ''), style: whoVar(d.who), tip: w.name + ' ' + stTxt + (d.time ? ' · ' + d.time : ''),
    lead: whoAva(d.who, { size: size === 'm' ? 'm' : 's', tip: false, live: d.live }), body: '<b>' + h(w.name) + '</b>' + (w.handle ? ' <span class="faint">' + h(w.handle) + '</span>' : '') + ' <span class="cap-state">' + (html ? st : h(st)) + '</span>' + (d.time ? ' <span class="num faint">' + h(d.time) + '</span>' : '') };
}
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  capsule: { g: 'identity', inline: true, via: ['type:capsules', 'type:notices', 'prop:delivery', 'prop:recv'], ex: function (s) { const r = s.runners[0]; return capsule(capWho({ who: r.who }, r.state, '', false, 'm')); } },
  capStack: { g: 'identity', inline: true, via: ['type:capsules', 'prop:delivery'], ex: function (s) { return capStack(s.runners.concat([{ who: s.extraRunner.who, state: s.statusText.info }]).map(function (r) { return capWho({ who: r.who }, r.state); }), { label: s.title }); } }
});
