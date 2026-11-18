/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 值的写法：时间、大小、时长（PDL 的 { of, fmt }） */
'use strict';
/* 时间和大小的写法（PDL 的 { of, fmt }）：接口给时间戳 / 字节数，这里按“你”的时区写成字。ago 侧栏的相对时间 · day 今天 / N月N日 · at 今天 hh:mm / 昨天 hh:mm / N 天前 / N月N日 hh:mm · hm 时:分 · stamp MM/DD hh:mm（对话和消息的时间，不分今天） · bytes GB / MB / KB（一位小数） */
function fmtParts(ts) { const tz = WHO_DATA.me().timeZone, o = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts).forEach(function (p) { o[p.type] = p.value; }); return o; }
/* 时间：毫秒数、数字串或 ISO 串都读成时间戳；读不出来是 NaN，各个时间写法一律写成空串 */
function fmtTs(ts) { return typeof ts === 'number' ? ts : typeof ts === 'string' ? (/^\d+$/.test(ts) ? Number(ts) : Date.parse(ts)) : NaN; }
function fmtDayNo(o) { return Date.UTC(+o.year, +o.month - 1, +o.day) / 864e5; }
const FORMATS = {
  ago: function (ts) { ts = fmtTs(ts); if (!isFinite(ts)) return ''; const s = Math.max(0, (ioNow() - ts) / 1000);   /* 时间可能是毫秒数、数字串或 ISO 串；读不出来就不写 */ return s < 60 ? tc('common.justNow') : s < 3600 ? tc('format.minutes', Math.round(s / 60)) : s < 86400 ? tc('format.hours', Math.round(s / 3600)) : tc('format.days', Math.round(s / 86400)); },
  hm: function (ts) { ts = fmtTs(ts); if (!isFinite(ts)) return ''; const o = fmtParts(ts); return o.hour + ':' + o.minute; },
  stamp: function (ts) { ts = fmtTs(ts); if (!isFinite(ts)) return ''; const o = fmtParts(ts); return ('0' + o.month).slice(-2) + '/' + ('0' + o.day).slice(-2) + ' ' + o.hour + ':' + o.minute; },
  day: function (ts) { ts = fmtTs(ts); if (!isFinite(ts)) return ''; const o = fmtParts(ts); return fmtDayNo(o) === fmtDayNo(fmtParts(ioNow())) ? tc('format.today') : tc('format.date', +o.month, +o.day); },
  at: function (ts) { ts = fmtTs(ts); if (!isFinite(ts)) return ''; const o = fmtParts(ts), d = fmtDayNo(fmtParts(ioNow())) - fmtDayNo(o), hm = o.hour + ':' + o.minute; return d <= 0 ? tc('format.todayAt', hm) : d === 1 ? tc('format.yesterdayAt', hm) : d < 7 ? tc('format.daysAgo', Math.round((ioNow() - ts) / 864e5)) : tc('format.date', +o.month, +o.day) + ' ' + hm; },
  floorMinutes: function (seconds) { return Math.floor(seconds / 60); },
  num: function (n) { return Number(n).toLocaleString(); },
  datetime: function (ts) { ts = fmtTs(ts); if (!isFinite(ts)) return ''; return new Date(ts).toLocaleString(undefined, { timeZone: WHO_DATA.me().timeZone || undefined }); },
  date: function (ts) { ts = fmtTs(ts); if (!isFinite(ts)) return ''; return new Date(ts).toLocaleDateString(undefined, { timeZone: WHO_DATA.me().timeZone || undefined }); },
  duration: function (sec) { return ENGINE_PARTS.duration(sec); },
  clock: function (sec) { return clockText(sec); },
  clockH: function (sec) { return clockText(sec, true); },
  latency: function (ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; },
  compact: function (n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); },
  dec2: function (n) { return Number(n).toFixed(2); },
  basename: function (path) { return String(path).replace(/:\d+(-\d+)?$/, '').split('/').filter(Boolean).pop(); },
  localized: function (value) { if (typeof value === 'string') return value; const lang = S.lang || 'zh', t = value.translations || {}; return t[lang] || (lang === 'zh' ? t['zh-CN'] : '') || value.default; },
  jsonValue: function (value) { return typeof value === 'string' ? value : JSON.stringify(value); },
  json: function (value) { return JSON.stringify(value); },
  /* 读的 JSON：对象 / JSON 串都分行缩进；不是 JSON 的字串原样 */
  jsonPretty: function (value) { if (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) { return value; } } return JSON.stringify(value, null, 2); },
  jsonLines: function (entries) { return entries.map(function (entry) { return JSON.stringify(entry); }).join('\n'); },
  noFinalPeriod: function (text) { return String(text).replace(/。$/, ''); },
  stem: function (name) { return String(name).replace(/\.[^.]+$/, ''); },
  markdown: function (text) { return mdLite(text); },
  escaped: function (text) { return h(text); },
  urlLabel: function (url) { return String(url).replace('https://', ''); },
  dirname: function (path) { return String(path).split('/').slice(0, -1).join('/'); },
  console: function (args) { return Array.isArray(args) ? args.map(function (v) { return typeof v === 'string' ? v : JSON.stringify(v); }).join(' ') : args; },
  server: function (target) { return target.host + ':' + target.port; },
  endpoint: function (target) { return FORMATS.server(target) + target.path; },
  withoutMention: function (value) { return value.text.replace(new RegExp('^' + value.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), ''); },
  toolCall: function (value) { const name = value.call ? value.call.toolName || value.call.label.replace(/^.*? → /, '') : value.label; return name + (value.input ? ' ' + value.input : ''); },
  firstLine: function (text) { return String(text).split('\n').find(function (line) { return line.trim(); }); },
  /* Markdown 的第一行当一行字（去掉标记）和其余部分：一段说明收起时只露第一行，展开时接着画后面的，不把第一行再画一遍 */
  plainLine: function (text) { return htmlText(mdLite(FORMATS.firstLine(text) || '')); },
  markdownRest: function (text) { const lines = String(text).split('\n'), i = lines.findIndex(function (line) { return line.trim(); }); const rest = lines.slice(i + 1).join('\n'); return rest.trim() ? mdLite(rest) : ''; },
  identity: function (identity) { return whoText(identity); },
  identityHandle: function (identity) { return whoText(identity, { handle: true }); },
  color: function (value) { const c = whoColors('primary' in value ? { color: value } : value); return c.fixed || getComputedStyle(document.documentElement).getPropertyValue('--name-' + (c.step || 1)).trim().toLowerCase(); },
  bytes: function (n) { const r = function (d) { return Math.round(n / d * 10) / 10; }; return n >= 1073741824 ? tc('format.gb', r(1073741824)) : n >= 1048576 ? tc('format.mb', r(1048576)) : tc('format.kb', r(1024)); }
};
ENGINE_PARTS.format = function (kind, v) { return FORMATS[kind](v); };
ENGINE_PARTS.duration = function (sec) { sec = Math.round(sec); return sec >= 60 ? tc('format.duration.minutesSeconds', Math.floor(sec / 60), sec % 60) : tc('format.duration.seconds', sec); };
