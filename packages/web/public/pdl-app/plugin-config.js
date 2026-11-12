/* 插件配置引擎：安装后，宿主读插件清单（plugin.yaml）的 configuration，投影成 PluginManagerConfigField[]，用同一个引擎画成配置表单。
   规则和真实项目同一套（PluginManagerConfigurationSection、ConfigFieldRenderer、ActionRenderer、OperationRowsRenderer、actionConfirmation）：
   - 种类 → 控件：select 下拉、member 成员下拉（选项是主机的成员列表）、boolean 开关、string / number / url 输入、secret 遮住的输入（只露“已设置”）、list 一列值的编辑器、operation 动作流程；hidden 不画；
     records 一组记录：清单声明每行有哪些子字段（recordFields，用上面这些种类）和可选的模板（presets，新加一行时的初值），值是这些行的 JSON 数组
   - 分支（configurationVariants，oneOf）：判别字段的当前值（含未保存的草稿）选出唯一匹配的分支；没被任何分支认领的字段一直在，分支字段只在选中时在。切换立刻重算，不保存、不往返
   - requiredWhen：写了它就由它决定（引用的值在列表里才必填）；引用的是已保存的密钥（值被遮住）时用宿主算好的 requiredNow
   - 步骤（steps / setupSteps）：带 mode 的步骤只在对应的模式选中时出现
   - 操作：一列动作按 next / rollback 走（按钮 → 轮询，带超时 → 状态 / 已连接 + 断开）；声明了 confirm 的动作每次都先确认；列出行的操作（resultRender: rows）画成行，
     每行的动作（rowActions）带着那一行的 input；动作的 next 是列表时成功后重新列；列表动作要确认时宿主不自己列
   - 校验和保存：只校验当前生效的字段；必填没填的标出来并聚焦第一个；保存只交改过的字段（空草稿 = 删除）；改过才出现保存栏（和 MCP 表单同一条规则）
   这里只出推导好的数据（pcfModel），画是组件库的 pluginConfigForm（widgets.js）。 */
'use strict';

const PCF_POLL_MS = 1500,
  PCF_STATUS_MS = 4000,
  PCF_OBSERVE_MS = 2500,
  PCF_OBSERVE_MAX = 5 * 60000;
const PCF_TERMINAL = ['denied', 'error', 'expired'];
if (!S.pcf) S.pcf = {};
const PCF_SRC = {}; /* 表单实例 → 数据来源 { plugin, fields, steps, testable }（动作要回到同一份字段上改） */

async function pcfCheckRecord(root) {
  try {
    const result = await api.post('/api/agent-providers/bootstrap-check', {}, { root: root });
    return result;
  } catch (error) {
    return { error: error.message };
  }
}
function pcfState(inst) {
  return S.pcf[inst] || (S.pcf[inst] = { draft: {}, errors: {}, ops: {} });
}
function pcfDefault(f) {
  return f.default === undefined ? undefined : Array.isArray(f.default) ? JSON.stringify(f.default) : String(f.default);
}
function pcfEffective(f, draft) {
  if (draft[f.key] !== undefined) return draft[f.key];
  if (f.currentValue !== null && f.currentValue !== undefined) return f.currentValue;
  const d = pcfDefault(f);
  if (d !== undefined) return d;
  if (f.kind === 'select') return f.options && f.options[0] ? f.options[0].value : '';
  if (f.kind === 'boolean') return 'false';
  return '';
}
function pcfVariants(fields) {
  const f = fields.find(function (x) {
    return x.configurationVariants;
  });
  return f ? f.configurationVariants : null;
}
/* 分支模式下参与判断的值：草稿（空草稿 = 删除，退回默认）、已保存的非密钥值、默认值；未选的判别字段保持未选 */
function pcfVariantValues(fields, draft) {
  const v = {};
  fields.forEach(function (f) {
    if (f.kind === 'operation') return;
    const d = draft[f.key];
    if (d !== undefined && d.length) {
      v[f.key] = d;
      return;
    }
    if (d === undefined && f.currentValue !== null && f.currentValue !== undefined) {
      if (f.kind !== 'secret') v[f.key] = f.currentValue;
      return;
    }
    const def = pcfDefault(f);
    if (def !== undefined) v[f.key] = def;
  });
  return v;
}
/* 分支：组件库的 oneOf 表单（ui.js 的 oneOfWhen / oneOfKeys），和成员的接入方式是同一个 */
function pcfActiveKeys(fields, vp, values) {
  // operation fields a branch claims follow the branch too
  return oneOfKeys(
    fields.map(function (f) {
      return f.key;
    }),
    vp,
    values,
  );
}
function pcfRequired(f, fields, draft, vp) {
  if (!f.requiredWhen) return !!f.required;
  const ref = fields.find(function (x) {
    return x.key === f.requiredWhen.key;
  });
  if (ref && ref.kind === 'secret' && draft[ref.key] === undefined && ref.currentValue) return !!f.requiredNow;
  const actual = vp
    ? pcfVariantValues(fields, draft)[f.requiredWhen.key]
    : ref
      ? pcfEffective(ref, draft) || undefined
      : undefined;
  if (actual === undefined) return false;
  const want = Array.isArray(f.requiredWhen.value) ? f.requiredWhen.value : [f.requiredWhen.value];
  return want.some(function (x) {
    return String(x) === String(actual);
  });
}
function pcfList(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(String) : null;
  } catch (e) {
    return null;
  }
}
function pcfRecords(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a)
      ? a.filter(function (x) {
          return x && typeof x === 'object';
        })
      : null;
  } catch (e) {
    return null;
  }
}
/* 字段路径：'key' 是一个字段；'key#i#sub' 是 records 字段第 i 行的子字段。读写都走这里（输入、开关、下拉、一列值的编辑器共用） */
function pcfPath(path) {
  const ps = String(path).split('#');
  return { key: ps[0], i: ps.length > 1 ? +ps[1] : null, sub: ps[2] };
}
function pcfRaw(inst, key) {
  const f = pcfField(inst, key),
    d = pcfState(inst).draft;
  return d[key] !== undefined
    ? d[key]
    : (f && f.currentValue) || (f && pcfDefault(f)) || (f && f.kind === 'records' ? '[]' : '');
}
function pcfRecordRows(inst, key) {
  const field = pcfField(inst, key);
  if (field.configurationMode !== 'single') return pcfRecords(pcfRaw(inst, key)) || [];
  return [Object.assign({}, field.defaultClient, JSON.parse(pcfRaw(inst, key)))];
}
function pcfGet(inst, path) {
  const p = pcfPath(path);
  if (p.i == null) return pcfRaw(inst, p.key);
  const r = pcfRecordRows(inst, p.key)[p.i] || {},
    v = r[p.sub];
  return Array.isArray(v) ? JSON.stringify(v) : v == null ? '' : String(v);
}
function pcfPut(inst, path, v) {
  const p = pcfPath(path);
  if (p.i == null) {
    pcfSet(inst, p.key, v);
    return;
  }
  const rs = pcfRecordRows(inst, p.key),
    f = pcfField(inst, p.key),
    sf =
      ((f && f.recordFields) || []).find(function (x) {
        return x.key === p.sub;
      }) || {};
  rs[p.i] = Object.assign({}, rs[p.i]);
  rs[p.i][p.sub] =
    sf.kind === 'list'
      ? pcfList(v) || []
      : sf.kind === 'boolean'
        ? v === 'true'
        : sf.kind === 'number' && v !== ''
          ? +v
          : v;
  pcfSet(
    inst,
    p.key,
    JSON.stringify(
      f.configurationMode === 'single'
        ? Object.assign({}, JSON.parse(pcfRaw(inst, p.key)), { [p.sub]: rs[p.i][p.sub] })
        : rs,
    ),
  );
  delete pcfState(inst).errors[path];
}
/* 字段的“生效”判断：分支模式下看生效集合，否则都生效 */
function pcfCtx(inst) {
  const src = PCF_SRC[inst],
    st = pcfState(inst),
    fields = src.fields,
    vp = pcfVariants(fields);
  const active = vp ? pcfActiveKeys(fields, vp, pcfVariantValues(fields, st.draft)) : null;
  return {
    src: src,
    st: st,
    fields: fields,
    vp: vp,
    on: function (f) {
      return !active || !!active[f.key];
    },
  };
}
function pcfUpdates(inst) {
  const c = pcfCtx(inst),
    d = c.st.draft;
  return c.fields
    .filter(function (f) {
      return f.kind !== 'operation' && !f.hidden && c.on(f);
    })
    .reduce(function (out, f) {
      if (d[f.key] !== undefined) out.push({ key: f.key, value: d[f.key].length ? d[f.key] : null });
      else if (!c.vp && (f.currentValue === null || f.currentValue === undefined) && f.default === undefined) {
        if (f.kind === 'select' && f.options && f.options[0]) out.push({ key: f.key, value: f.options[0].value });
        if (f.kind === 'boolean') out.push({ key: f.key, value: 'false' });
      }
      return out;
    }, []);
}
function pcfValidate(inst) {
  const c = pcfCtx(inst),
    d = c.st.draft,
    vals = c.vp ? pcfVariantValues(c.fields, d) : null,
    errs = {};
  c.fields
    .filter(function (f) {
      return f.kind !== 'operation' && !f.hidden && c.on(f);
    })
    .forEach(function (f) {
      const v = vals ? (vals[f.key] === undefined ? '' : String(vals[f.key])) : pcfEffective(f, d);
      const has = v.trim().length > 0 || (f.kind === 'secret' && d[f.key] === undefined && !!f.currentValue);
      if (pcfRequired(f, c.fields, d, c.vp) && !has) errs[f.key] = tc('pcf.fill', f.label);
      else if (f.kind === 'list' && v && pcfList(v) === null) errs[f.key] = tc('pcf.badList');
      if (f.kind === 'records')
        pcfRecordRows(inst, f.key).forEach(function (r, i) {
          (f.recordFields || []).forEach(function (sf) {
            const x = r[sf.key];
            if (sf.required && (x == null || !String(Array.isArray(x) ? x.join('') : x).trim().length))
              errs[f.key + '#' + i + '#' + sf.key] = tc('pcf.fill', sf.label);
          });
        }); /* 每行的必填子字段 */
    });
  c.st.errors = errs;
  return Object.keys(errs);
}

/* ───────── 操作：动作的状态和走法 ───────── */
async function pcfCall(inst, f, aid, body, confirmed) {
  try {
    return await chatPort.action('pluginOperation', {
      id: PCF_SRC[inst].plugin,
      operation: f.key,
      action: aid,
      value: JSON.stringify(body || {}),
      confirmed: String(!!confirmed),
    });
  } catch (error) {
    return { ok: false, label: error.message };
  }
}
function pcfFail(r) {
  if (!r || !r.ok) return (r && r.label) || tc('pcf.failed');
  const st = r.data && typeof r.data === 'object' ? r.data.status : '';
  return r.advance === false || st === 'error' ? (r.data && r.data.message) || r.label || tc('pcf.failed') : null;
}
function pcfConfirm(label, wording, then) {
  if (wording === undefined) return then(false);
  dialog({
    title: label,
    text: h(wording),
    ok: label,
    danger: true,
    on: function () {
      return then(true);
    },
  });
}
// An action's result: its label as a status line; a text result (an address, a message to paste) as a copyable
// value that stays. Other results go after a few seconds. A `rows` result replaces the rows.
function pcfFeedback(o, r, rowKey) {
  const text = r.render === 'text' && typeof r.data === 'string' ? r.data : '';
  if (!r.label && !text) return;
  const fb = (o.fb = { label: r.label || '', copy: text, row: rowKey || '' });
  if (!text)
    setTimeout(function () {
      if (o.fb === fb) {
        o.fb = null;
        render(true);
      }
    }, PCF_STATUS_MS);
}
function pcfRowsResult(inst, f, o, r) {
  if (r.render === 'rows' && r.data && Array.isArray(r.data.rows)) pcfRowsSet(inst, f, o, r.data);
}
function pcfShape(f) {
  const as = f.actions || [],
    first = as[0];
  const list = as.find(function (a) {
    return a.resultRender === 'rows';
  });
  if (list) return { mode: 'rows', list: list };
  const revoke = as.find(function (a) {
    return a.render === 'button' && first && a.next === first.id && first.next === a.id;
  });
  const status = as.find(function (a) {
    return a.render === 'status' || a.render === 'polling';
  });
  if (first && first.render === 'button' && status && status.confirm === undefined && revoke)
    return { mode: 'live', arm: first, status: status, revoke: revoke };
  return {
    mode: 'seq',
    first: first,
    off: as.find(function (a) {
      return first && a.id !== first.id && a.next === first.id;
    }),
  };
}
function pcfOp(inst, f) {
  const st = pcfState(inst),
    sh = pcfShape(f);
  if (st.ops[f.key]) return st.ops[f.key];
  const o = (st.ops[f.key] = { mode: sh.mode, err: '' });
  if (sh.mode === 'seq') {
    const cur =
      (f.operationState && f.operationState.currentAction) ||
      (f.configured && sh.off ? sh.off.id : sh.first && sh.first.id);
    o.cur = cur;
    o.phase = f.configured && sh.off && cur === sh.off.id ? 'connected' : pcfPhaseFor(f, cur, sh);
  }
  if (sh.mode === 'live') pcfLiveRefresh(inst, f);
  if (sh.mode === 'rows') {
    if (sh.list.confirm === undefined) pcfRowsList(inst, f);
    else o.awaiting = true;
  } /* 列表动作要确认时宿主不自己列 */
  return o;
}
function pcfPhaseFor(f, id, sh) {
  if (!id) return 'idle';
  if (sh.off && id === sh.off.id) return 'connected';
  const a = (f.actions || []).find(function (x) {
    return x.id === id;
  });
  return a && a.render === 'polling' ? 'polling' : 'idle';
}
function pcfField(inst, key) {
  return PCF_SRC[inst].fields.find(function (x) {
    return x.key === key;
  });
}
/* 连上 / 断开：操作的目标字段跟着有值 / 没值（扫码拿到的 Bot Token 是宿主写的密钥） */
function pcfConnected(inst) {
  return PCF_SRC[inst].refresh();
}
function pcfAdvance(inst, f, next) {
  const o = pcfOp(inst, f),
    sh = pcfShape(f);
  o.cur = next;
  o.phase = pcfPhaseFor(f, next, sh);
  if (o.phase === 'connected') void pcfConnected(inst);
  if (o.phase === 'polling') pcfPoll(inst, f, next);
}
function pcfPoll(inst, f, aid) {
  const o = pcfOp(inst, f),
    a = f.actions.find(function (x) {
      return x.id === aid;
    }),
    epoch = (o.epoch = (o.epoch || 0) + 1);
  o.until = Date.now() + (a.timeout || 60) * 1000;
  const tick = async function () {
    if (o.epoch !== epoch || o.phase !== 'polling') return;
    if (Date.now() >= o.until) {
      /* 超时：有 rollback 回到它，否则停在出错 */
      o.last = null;
      o.err = tc('pcf.timeout');
      o.phase = a.rollback ? 'idle' : 'error';
      if (a.rollback) o.cur = a.rollback;
      render(true);
      return;
    }
    const r = await pcfCall(inst, f, aid);
    if (!r || !r.ok) {
      o.phase = 'error';
      o.err = (r && r.label) || tc('pcf.failed');
      render(true);
      return;
    }
    const term = r.render === 'polling' && r.data && PCF_TERMINAL.indexOf(r.data.status) >= 0;
    if (term) {
      o.err = r.data.message || r.label || r.data.status;
      o.phase = 'error';
      if (a.rollback) {
        o.cur = a.rollback;
        o.last = null;
      }
      render(true);
      return;
    }
    if (r.render === 'polling' || r.render === a.render) {
      if (o.last && o.last.render === 'img') o.last = Object.assign({}, o.last, { label: r.label || o.last.label });
      else o.last = r;
      setTimeout(tick, PCF_POLL_MS);
      render(true);
      return;
    }
    o.last = r;
    if (a.next) pcfAdvance(inst, f, a.next);
    else o.phase = 'result';
    render(true);
  };
  setTimeout(tick, PCF_POLL_MS);
}
function pcfRun(inst, f, aid) {
  const o = pcfOp(inst, f),
    sh = pcfShape(f),
    a = f.actions.find(function (x) {
      return x.id === aid;
    });
  return pcfConfirm(a.label, a.confirm, async function (confirmed) {
    if (sh.mode === 'live') {
      o.busy = true;
      const r = await pcfCall(inst, f, aid, {}, confirmed);
      o.busy = false;
      o.err = r && r.ok ? '' : (r && r.label) || tc('pcf.failed');
      await pcfLiveRefresh(inst, f);
      render(true);
      return o.err ? { error: o.err } : undefined;
    }
    if (sh.mode === 'rows') {
      const r = await pcfCall(inst, f, aid, {}, confirmed);
      o.err = pcfFail(r) || '';
      if (!o.err) {
        pcfFeedback(o, r);
        pcfRowsResult(inst, f, o, r);
        if (a.next === sh.list.id) await pcfRowsList(inst, f);
        pcfSiblings(inst, f);
      }
      render(true);
      return o.err ? { error: o.err } : undefined;
    }
    if (sh.off && aid === sh.off.id && o.phase === 'connected') {
      /* 断开 */
      o.phase = 'disconnecting';
      render(true);
      const r = await pcfCall(inst, f, aid, {}, confirmed);
      if (!r || !r.ok) {
        o.phase = 'connected';
        render(true);
        return { error: pcfFail(r) };
      }
      await pcfConnected(inst);
      o.cur = sh.first.id;
      o.last = null;
      o.phase = 'idle';
      render(true);
      return;
    }
    const next = f.actions.find(function (x) {
      return x.id === a.next;
    });
    o.epoch = (o.epoch || 0) + 1;
    o.last = null;
    o.err = '';
    o.phase = 'loading';
    render(true);
    return (async function () {
      const r = await pcfCall(inst, f, aid, {}, confirmed),
        bad = pcfFail(r);
      if (bad) {
        o.phase = 'error';
        o.err = bad;
        render(true);
        return { error: bad };
      }
      o.last = r;
      pcfSiblings(inst, f);
      if (next && next.render === 'polling') {
        o.cur = next.id;
        o.phase = 'polling';
        pcfPoll(inst, f, next.id);
      } else if (a.next) pcfAdvance(inst, f, a.next);
      else {
        o.phase = 'result';
        if (r.render === 'status')
          setTimeout(function () {
            if (o.last === r) {
              o.last = null;
              render(true);
            }
          }, PCF_STATUS_MS);
      }
      render(true);
    })();
  });
}
/* 限时授权：状态动作是唯一的事实来源（剩余时间、到期） */
async function pcfLiveRefresh(inst, f) {
  const o = pcfState(inst).ops[f.key],
    sh = pcfShape(f),
    r = await pcfCall(inst, f, sh.status.id),
    d = r && r.ok && r.data;
  o.err = pcfFail(r) || '';
  o.status =
    d && typeof d.armed === 'boolean'
      ? d.armed && Date.parse(d.expiresAt) > Date.now()
        ? { armed: true, until: Date.parse(d.expiresAt), label: r.label }
        : { armed: false, label: r.label }
      : null;
  render(true);
}
async function pcfRowsList(inst, f, confirmed) {
  const o = pcfState(inst).ops[f.key],
    sh = pcfShape(f);
  if (sh.list.confirm !== undefined && !confirmed) {
    o.awaiting = true;
    return;
  }
  const r = await pcfCall(inst, f, sh.list.id, {}, confirmed);
  o.awaiting = false;
  if (r && r.ok && r.render === 'rows' && r.data && Array.isArray(r.data.rows)) {
    pcfRowsSet(inst, f, o, r.data);
    o.err = '';
  } else o.err = (r && r.label) || tc('pcf.failed');
  render(true);
  return o.err ? { error: o.err } : undefined;
}
// New rows: validUntil = the prepared rows expire then and are listed again; pollUntil = watch them until then
// (every 2.5 s, at most 5 minutes), then stop and offer a re-check.
function pcfRowsSet(inst, f, o, rows) {
  const now = Date.now(),
    epoch = (o.rowsEpoch = (o.rowsEpoch || 0) + 1),
    keys = rows.rows
      .map(function (x) {
        return x.key;
      })
      .join('\u0000');
  o.rows = rows;
  if (o.paused !== keys) o.paused = '';
  if (rows.validUntil)
    setTimeout(
      function () {
        if (o.rowsEpoch !== epoch) return;
        o.rows = null;
        void pcfRowsList(inst, f);
      },
      Math.max(0, rows.validUntil - now),
    );
  else if (rows.pollUntil) {
    const until = (o.observeUntil = Math.min(
      rows.pollUntil,
      o.observeUntil && o.observeUntil > now ? o.observeUntil : now + PCF_OBSERVE_MAX,
    ));
    setTimeout(
      function () {
        if (o.rowsEpoch !== epoch || document.visibilityState === 'hidden') return;
        if (Date.now() >= until) {
          o.paused = keys;
          o.observeUntil = 0;
        }
        void pcfRowsList(inst, f);
      },
      Math.min(PCF_OBSERVE_MS, Math.max(0, until - now)),
    );
  }
}
// After an action succeeds, the plugin's watched statuses (lists without confirmation) look again; this does not
// count as confirming them.
function pcfSiblings(inst, f) {
  PCF_SRC[inst].fields.forEach(function (x) {
    if (x.key === f.key || x.kind !== 'operation') return;
    const sh = pcfShape(x),
      o = pcfState(inst).ops[x.key];
    if (sh.mode === 'rows' && sh.list.confirm === undefined && o) {
      o.observeUntil = 0;
      void pcfRowsList(inst, x);
    }
  });
}
function pcfRowRun(inst, f, rowKey, aid) {
  const o = pcfOp(inst, f),
    sh = pcfShape(f),
    row = (o.rows.rows || []).find(function (x) {
      return x.key === rowKey;
    });
  const ra =
      row &&
      (row.actions || []).find(function (x) {
        return x.action === aid;
      }),
    dec = (f.rowActions || []).find(function (x) {
      return x.id === aid;
    });
  if (!ra || !dec) return;
  const label = ra.label || dec.label;
  return pcfConfirm(label, ra.confirm !== undefined ? ra.confirm : dec.confirm, async function (confirmed) {
    /* 行自己的确认可以换措辞，不能跳过 */
    o.rowErr = o.rowErr || {};
    const r = await pcfCall(inst, f, aid, { rowKey: rowKey, input: ra.input }, confirmed),
      bad = pcfFail(r);
    if (bad) o.rowErr[rowKey] = bad;
    else {
      delete o.rowErr[rowKey];
      pcfFeedback(o, r, dec.next === sh.list.id ? '' : rowKey);
      pcfRowsResult(inst, f, o, r);
      if (dec.next === sh.list.id) await pcfRowsList(inst, f);
      pcfSiblings(inst, f);
    }
    render(true);
    return bad ? { error: bad } : undefined;
  });
}

/* ───────── 推导：给组件库的 props ───────── */
function pcfOpVM(inst, f) {
  const o = pcfOp(inst, f),
    sh = pcfShape(f),
    rows = o.rows,
    status = o.status;
  return {
    p: inst,
    f: f.key,
    mode: sh.mode,
    err: o.err || '',
    actions: f.actions || [],
    rowActions: f.rowActions || [],
    listId: sh.list && sh.list.id,
    firstId: sh.first && sh.first.id,
    offId: sh.off && sh.off.id,
    armId: sh.arm && sh.arm.id,
    revokeId: sh.revoke && sh.revoke.id,
    currentId: o.cur,
    phase: o.phase,
    last: o.last,
    seconds: Math.max(0, Math.ceil((o.until - Date.now()) / 1000)),
    status: status
      ? {
          armed: !!(status.armed && status.until > Date.now()),
          label: status.label,
          seconds: Math.ceil((status.until - Date.now()) / 1000),
        }
      : null,
    busy: !!o.busy,
    fb: o.fb && !o.fb.row ? o.fb : null,
    // A watched status (polling, no confirmation) has no standing refresh: a re-check only after a failed read or
    // when watching stopped. Prepared rows (validUntil) list again by themselves.
    refresh:
      !(rows && rows.validUntil) &&
      (!(sh.list && sh.list.render === 'polling' && sh.list.confirm === undefined) || !!o.err || !!o.paused),
    refreshAuto: !!(sh.list && sh.list.render === 'polling' && sh.list.confirm === undefined),
    paused: !!o.paused,
    awaiting: !!o.awaiting,
    loaded: !!rows,
    emptyText: rows && rows.empty,
    rows: rows
      ? rows.rows.map(function (r) {
          return Object.assign({}, r, {
            err: (o.rowErr || {})[r.key] || '',
            fb: o.fb && o.fb.row === r.key ? o.fb : null,
          });
        })
      : [],
  };
}
/* 一个表单实例：src = { plugin, fields, steps, testable, installed }；返回 pluginConfigForm 的 props */
function pcfModel(inst, src) {
  src.fields = src.fields.map(function (field) {
    const library = (src.clientLibraries || []).find(function (lib) {
      return lib.configurationKey === field.key;
    });
    return library && library.configurationMode === 'single'
      ? Object.assign({}, field, {
          configurationMode: library.configurationMode,
          defaultClient: library.defaultClient,
        })
      : field;
  });
  PCF_SRC[inst] = src;
  const c = pcfCtx(inst),
    d = c.st.draft,
    fields = c.fields;
  if (!src.installed) return { p: inst, installed: false };
  const modeField = fields.find(function (f) {
    return (
      f.kind === 'select' &&
      (f.options || []).some(function (x) {
        return (src.steps || []).some(function (s) {
          return s.mode === x.value;
        });
      })
    );
  });
  const mode = modeField ? pcfEffective(modeField, d) : '';
  const steps = (src.steps || [])
    .filter(function (s) {
      return !s.mode || s.mode === mode;
    })
    .map(function (s) {
      return { text: s.text, code: s.code };
    });
  const rows = fields
    .filter(function (f) {
      return !f.hidden && c.on(f);
    })
    .map(function (f) {
      const id = 'pcf-' + inst.replace(/\W/g, '-') + '-' + f.key,
        err = c.st.errors[f.key] || '';
      const row = {
        key: f.key,
        id: id,
        kind: f.kind,
        label: f.label,
        req: f.kind !== 'operation' && pcfRequired(f, fields, d, c.vp),
        desc: f.description || '',
        err: err,
      };
      if (f.kind === 'operation') return Object.assign(row, { operation: pcfOpVM(inst, f) });
      if (f.kind === 'select') {
        const value = c.vp
          ? d[f.key] !== undefined
            ? d[f.key]
            : f.currentValue !== null && f.currentValue !== undefined
              ? f.currentValue
              : pcfDefault(f) || ''
          : pcfEffective(f, d);
        return Object.assign(row, { value: value, options: f.options || [] });
      }
      if (f.kind === 'boolean') return Object.assign(row, { value: pcfEffective(f, d) === 'true' });
      if (f.kind === 'member')
        return Object.assign(row, {
          kind: 'select',
          value: pcfEffective(f, d),
          options: WHO_DATA.members().map(function (m) {
            return { value: m.id, label: m.name };
          }),
        }); /* 成员：选项是主机的成员列表 */
      if (f.kind === 'list')
        return Object.assign(row, {
          items: pcfList(d[f.key] !== undefined ? d[f.key] : f.currentValue || pcfDefault(f) || '[]') || [],
        });
      if (f.kind === 'records')
        return Object.assign(row, {
          configurationMode: f.configurationMode,
          defaultClient: f.defaultClient,
          presets: f.presets || [],
          checkable: (src.clientLibraries || []).some(function (lib) {
            return lib.configurationKey === f.key;
          }),
          items: pcfRecordRows(inst, f.key).map(function (r, i) {
            return {
              i: i,
              checked: (c.st.checks || {})[f.key + '#' + r.id] || null,
              name: r.name || r.id,
              rows: (f.recordFields || []).map(function (sf) {
                return pcfSubRow(inst, f, sf, i, id);
              }),
            };
          }),
        });
      return Object.assign(row, { value: d[f.key] || '', currentValue: f.currentValue, defaultValue: pcfDefault(f) });
    });
  return { p: inst, installed: true, steps: steps, rows: rows, fieldCount: fields.length, testable: !!src.testable };
}
/* records 一行里的一个子字段：和顶层字段同样的种类 → 控件，只是读写走字段路径（key#i#sub） */
function pcfSubRow(inst, f, sf, i, base) {
  const path = f.key + '#' + i + '#' + sf.key,
    v = pcfGet(inst, path),
    err = pcfState(inst).errors[path] || '';
  return {
    key: path,
    schemaKey: sf.key,
    id: base + '-' + i + '-' + sf.key,
    kind: sf.kind,
    record: true,
    defaultClient: f.defaultClient,
    label: sf.label,
    req: !!sf.required,
    desc: sf.description || '',
    err: err,
    value: sf.kind === 'boolean' ? v === 'true' : v,
    options: sf.options || [],
    items: sf.kind === 'list' ? pcfList(v || '[]') || [] : [],
    placeholder: sf.placeholder || '',
  };
}
/* 保存栏：改过才出现；保存时校验、只交改过的字段 */
function pcfDirty(inst) {
  const st = pcfState(inst);
  return Object.keys(st.draft).some(function (k) {
    const f = pcfField(inst, k);
    return !f || String(st.draft[k]) !== String(pcfEffective(f, {}));
  });
} /* 草稿里和原值不同的字段才算改过 */
formDraft('pcf', {
  dirty: function () {
    return Object.keys(S.pcf || {}).some(function (inst) {
      return PCF_SRC[inst] && pcfDirty(inst);
    });
  },
  drop: function () {
    S.pcf = {};
  },
}); /* 离开时放弃 = 草稿清掉，所以有草稿的就是正在改的那一份 */
async function pcfSave(inst) {
  const st = pcfState(inst),
    bad = pcfValidate(inst);
  if (bad.length) {
    render(true);
    focusField('pcf-' + inst.replace(/\W/g, '-') + '-' + bad[0]);
    return false;
  }
  if (st.busy) return false;
  st.busy = true;
  try {
    await PCF_SRC[inst].save(pcfUpdates(inst));
    st.draft = {};
    st.errors = {};
    return true;
  } finally {
    st.busy = false;
    render(true);
  }
}

/* ───────── 动作和输入 ───────── */
function pcfSet(inst, key, v) {
  const st = pcfState(inst);
  st.draft[key] = v;
  delete st.errors[key];
}
Object.assign(A, {
  /* 插件配置的一个操作（配置协议）：op = bool（字段开关）| recBool（记录里的开关）| add / del（一列值的增删）| recAdd / recDel（记录的增删）| discard（丢掉草稿）；没写 op = 字段声明的操作（a） */
  pcfOp: function (d) {
    if (d.op && PCF_OPS[d.op]) {
      const result = PCF_OPS[d.op](d);
      render(true);
      return result;
    }
    const f = pcfField(d.p, d.f);
    if (!f) return;
    const sh = pcfShape(f);
    if (d.r) return pcfRowRun(d.p, f, d.r, d.a);
    if (sh.mode === 'rows' && d.a === sh.list.id)
      return pcfConfirm(sh.list.label, sh.list.confirm, function (confirmed) {
        return pcfRowsList(d.p, f, confirmed);
      });
    return pcfRun(d.p, f, d.a);
  },
});
function pcfListOp(d) {
  const b = d.l.lastIndexOf('|'),
    inst = d.l.slice(0, b),
    path = d.l.slice(b + 1),
    items = pcfList(pcfGet(inst, path) || '[]') || [];
  if (d.op === 'add') items.push('');
  else items.splice(+d.i, 1);
  pcfPut(inst, path, JSON.stringify(items));
  markDirty();
}
const PCF_OPS = {
  bool: function (d) {
    const f = pcfField(d.p, d.k);
    pcfSet(d.p, d.k, pcfEffective(f, pcfState(d.p).draft) === 'true' ? 'false' : 'true');
    markDirty();
  },
  add: pcfListOp,
  del: pcfListOp /* 一列值（kvEditor 的增删：l = 实例|路径） */,
  /* records：加一行（从模板开始，或者空的）、删一行、行里的开关 */
  recCheck: async function (d) {
    const state = pcfState(d.p),
      row = pcfRecordRows(d.p, d.k)[+d.i];
    (state.checks || (state.checks = {}))[d.k + '#' + row.id] = await pcfCheckRecord(row.bootstrapRoot);
    render(true);
  },
  recAdd: function (d) {
    const f = pcfField(d.p, d.k),
      rs = pcfRecords(pcfRaw(d.p, d.k)) || [],
      pr = (f.presets || []).find(function (x) {
        return x.id === d.preset;
      });
    rs.push(pr ? JSON.parse(JSON.stringify(pr.value)) : {});
    pcfSet(d.p, d.k, JSON.stringify(rs));
    markDirty();
  },
  recDel: function (d) {
    const rs = pcfRecords(pcfRaw(d.p, d.k)) || [];
    rs.splice(+d.i, 1);
    pcfSet(d.p, d.k, JSON.stringify(rs));
    markDirty();
  },
  recBool: function (d) {
    pcfPut(d.p, d.k, pcfGet(d.p, d.k) === 'true' ? 'false' : 'true');
    markDirty();
  },
  discard: function (d) {
    const st = pcfState(d.p);
    st.draft = {};
    st.errors = {};
  },
};
Object.assign(INPUTS, {
  pcfIn: function (e) {
    const t = e.target;
    pcfSet(t.dataset.p, t.dataset.k, t.value);
    markDirty();
    t.removeAttribute('aria-invalid');
  },
  pcfListIn: function (e) {
    /* 键是「实例|字段:序号」；实例名自己可以带冒号（组件目录的 cat:kinds），所以从后往前拆 */
    const t = e.target,
      s = t.dataset.draft,
      j = s.lastIndexOf(':'),
      base = s.slice(0, j),
      b = base.lastIndexOf('|'),
      inst = base.slice(0, b),
      key = base.slice(b + 1),
      items = pcfList(pcfGet(inst, key) || '[]') || [];
    items[+s.slice(j + 1)] = t.value;
    pcfPut(inst, key, JSON.stringify(items));
    markDirty();
  },
  pcfRecIn: function (e) {
    const t = e.target;
    pcfPut(t.dataset.p, t.dataset.k, t.value);
    markDirty();
    t.removeAttribute('aria-invalid');
  },
});
Object.assign(CHANGES, {
  pcfSel: function (e) {
    const t = e.target;
    pcfSet(t.dataset.p, t.dataset.k, t.value);
    markDirty();
    render(true);
  } /* 下拉换了：分支、步骤、必填立刻重算 */,
  pcfRecSel: function (e) {
    const t = e.target;
    pcfPut(t.dataset.p, t.dataset.k, t.value);
    markDirty();
    render(true);
  },
});
FORMS.pcf = function (f) {
  return pcfSave(f.dataset.p).catch(function (error) {
    toast(error.message, null, 'danger');
  });
}; /* 保存栏消失就是反馈 */

/* Permission edits use the same field validation and draft model as package configuration. */
function pluginPermissionsVM(plugin, label) {
  const raw = placementData(),
    r = raw.pluginPermissions[plugin],
    inst = plugin + '|permissions';
  if (raw.pluginPermissionsErrors[plugin]) return { label: label, error: raw.pluginPermissionsErrors[plugin] };
  const fields = [
    {
      key: 'whitelistEnabled',
      kind: 'boolean',
      label: 't:pcf.fieldLabel.whitelistEnabled',
      currentValue: String(r.whitelistEnabled),
    },
    {
      key: 'commandAdminOnly',
      kind: 'boolean',
      label: 't:pcf.fieldLabel.commandAdminOnly',
      currentValue: String(r.commandAdminOnly),
    },
    {
      key: 'adminOpenIds',
      kind: 'list',
      label: 't:pcf.fieldLabel.adminOpenIds',
      currentValue: JSON.stringify(r.adminOpenIds),
    },
    {
      key: 'allowedGroups',
      kind: 'records',
      label: 't:pcf.fieldLabel.allowedGroups',
      currentValue: JSON.stringify(r.allowedGroups),
      recordFields: [
        { key: 'externalChatId', kind: 'string', label: 'ID', required: true },
        { key: 'label', kind: 'string', label: 't:common.name' },
      ],
    },
  ];
  return {
    label: label,
    p: inst,
    error: pcfState(inst).saveError || '',
    dirty: !!PCF_SRC[inst] && pcfDirty(inst),
    form: pcfModel(inst, { plugin: plugin, revision: r.revision, fields: fields, installed: true }),
  };
}
FORMS.pluginPermissions = async function (form) {
  const inst = form.dataset.p,
    state = pcfState(inst),
    src = PCF_SRC[inst];
  if (pcfValidate(inst).length) {
    render(true);
    return false;
  }
  const body = { expectedRevision: src.revision };
  pcfUpdates(inst).forEach(function (u) {
    const f = pcfField(inst, u.key);
    body[u.key] = f.kind === 'boolean' ? u.value === 'true' : JSON.parse(u.value);
  });
  if (body.allowedGroups)
    body.allowedGroups = body.allowedGroups.map(function (g) {
      return { externalChatId: g.externalChatId, label: g.label };
    });
  try {
    await chatPort.action('settingsPluginPermissionsSave', { id: src.plugin, value: JSON.stringify(body) });
    state.saveError = '';
    state.draft = {};
    state.errors = {};
    return true;
  } catch (error) {
    state.saveError = error.message;
    return false;
  } finally {
    render(true);
  }
};
