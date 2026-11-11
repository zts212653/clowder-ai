/* 接口门面（应用）：应用经它读写数据、听服务端的推送；视图模型只读绑定层（bind.js）填好的 store。
   门面只是接口，实现由数据层登记（apiProvide）：实现是接口请求和 socket。
   路径和返回形状就是后端的接口（packages/api/src/routes）。
     get(路径, 参数) / post(路径, 参数, 请求体)   读 / 写
     on(事件, fn) / send(事件, 内容)            服务端推来的事件 / 发给服务端的事件（socket）；实现登记之前订阅的，登记时补挂
     file(路径)                                服务端文件的地址（成员头像 /avatars/… 这类）
     act(名字)                                 动作表里没有的名字到这里找
     now()                                     “现在”（消息时间、相对时间都以它为准）
     status(键)                                一份数据现在的读取状态（'' | loading | error | stale | empty）：就是请求的状态 */
'use strict';
const API = { impl: null, subs: [] };
const api = {
  get: function (path, params) { return API.impl.get(path, params); },
  post: function (path, params, body) { return API.impl.post(path, params, body); },
  file: function (path) { return API.impl.file(path); },
  on: function (ev, fn) { if (API.impl) API.impl.on(ev, fn); else API.subs.push([ev, fn]); },
  send: function (ev, payload) { API.impl.send(ev, payload); },
  act: function (name) { return API.impl && API.impl.act ? API.impl.act(name) : null; },
  now: function () { return API.impl.now ? API.impl.now() : Date.now(); },
  status: function (key) { return API.impl.status ? API.impl.status(key) : ''; }
};
/* 数据层登记自己是门面的实现 */
function apiProvide(impl) { API.impl = impl; API.subs.forEach(function (s) { impl.on(s[0], s[1]); }); API.subs = []; }
