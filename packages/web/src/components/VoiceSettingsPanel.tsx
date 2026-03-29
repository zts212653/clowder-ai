'use client';

import React, { useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { type CustomTerm, useVoiceSettingsStore } from '@/stores/voiceSettingsStore';
import builtInTerms from '@/utils/voice-terms.json';

const BUILT_IN_ENTRIES = Object.entries(builtInTerms as Record<string, string>).filter(
  ([k]) => !k.startsWith('_comment'),
);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
      <h3 className="text-xs font-semibold text-cafe-secondary mb-2">{title}</h3>
      {children}
    </section>
  );
}

function AddTermRow({ onAdd }: { onAdd: (from: string, to: string) => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const toRef = useRef<HTMLInputElement>(null);
  const ime = useIMEGuard();

  const handleAdd = () => {
    if (!from.trim() || !to.trim()) return;
    onAdd(from.trim(), to.trim());
    setFrom('');
    setTo('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !ime.isComposing()) handleAdd();
  };

  const handleFromKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !ime.isComposing() && from.trim() && !to.trim()) {
      toRef.current?.focus();
    } else {
      handleKeyDown(e);
    }
  };

  return (
    <div className="flex items-center gap-2 mt-2">
      <input
        type="text"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        placeholder="误识别词"
        className="flex-1 text-xs border border-cafe rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={handleFromKeyDown}
      />
      <span className="text-cafe-muted text-xs">&rarr;</span>
      <input
        ref={toRef}
        type="text"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="正确词"
        className="flex-1 text-xs border border-cafe rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={handleKeyDown}
      />
      <button
        onClick={handleAdd}
        disabled={!from.trim() || !to.trim()}
        className="text-xs px-2.5 py-1.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        添加
      </button>
    </div>
  );
}

function CustomTermRow({
  term,
  index,
  onUpdate,
  onRemove,
}: {
  term: CustomTerm;
  index: number;
  onUpdate: (index: number, from: string, to: string) => void;
  onRemove: (index: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editFrom, setEditFrom] = useState(term.from);
  const [editTo, setEditTo] = useState(term.to);
  const ime = useIMEGuard();

  const startEdit = () => {
    setEditFrom(term.from);
    setEditTo(term.to);
    setEditing(true);
  };

  const saveEdit = () => {
    if (!editFrom.trim() || !editTo.trim()) return;
    onUpdate(index, editFrom.trim(), editTo.trim());
    setEditing(false);
  };

  const cancelEdit = () => setEditing(false);

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (ime.isComposing()) return;
    if (e.key === 'Enter') saveEdit();
    if (e.key === 'Escape') cancelEdit();
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <input
          type="text"
          value={editFrom}
          onChange={(e) => setEditFrom(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={handleEditKeyDown}
          className="flex-1 border border-blue-300 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
        />
        <span className="text-cafe-muted">&rarr;</span>
        <input
          type="text"
          value={editTo}
          onChange={(e) => setEditTo(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={handleEditKeyDown}
          className="flex-1 border border-blue-300 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={saveEdit}
          disabled={!editFrom.trim() || !editTo.trim()}
          className="text-blue-500 hover:text-blue-700 disabled:opacity-40"
          title="保存"
        >
          &#10003;
        </button>
        <button onClick={cancelEdit} className="text-cafe-muted hover:text-cafe-secondary" title="取消">
          &#10005;
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <code className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">{term.from}</code>
      <span className="text-cafe-muted">&rarr;</span>
      <code className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">{term.to}</code>
      <div className="ml-auto flex items-center gap-1">
        <button onClick={startEdit} className="text-cafe-muted hover:text-blue-500 transition-colors" title="编辑">
          &#9998;
        </button>
        <button
          onClick={() => onRemove(index)}
          className="text-cafe-muted hover:text-red-500 transition-colors"
          title="删除"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

export function VoiceSettingsPanel() {
  const { settings, addTerm, updateTerm, removeTerm, setLanguage, setCustomPrompt, resetAll } = useVoiceSettingsStore();
  const [showBuiltIn, setShowBuiltIn] = useState(false);

  return (
    <>
      {/* Custom terms */}
      <Section title="自定义术语纠正">
        <p className="text-[11px] text-cafe-secondary mb-2">添加你自己的纠正规则。自定义规则优先于内置词典。</p>
        {settings.customTerms.length > 0 ? (
          <div className="space-y-1.5 mb-1">
            {settings.customTerms.map((term, i) => (
              <CustomTermRow
                key={`${term.from}-${i}`}
                term={term}
                index={i}
                onUpdate={updateTerm}
                onRemove={removeTerm}
              />
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-cafe-muted italic">暂无自定义规则</p>
        )}
        <AddTermRow onAdd={addTerm} />
      </Section>

      {/* Built-in terms (collapsible) */}
      <Section title="内置词典">
        <button
          onClick={() => setShowBuiltIn(!showBuiltIn)}
          className="text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
        >
          {showBuiltIn ? '收起' : `查看全部 ${BUILT_IN_ENTRIES.length} 条内置规则`}
        </button>
        {showBuiltIn && (
          <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
            {BUILT_IN_ENTRIES.map(([from, to]) => (
              <div key={from} className="flex items-center gap-2 text-xs text-cafe-secondary">
                <code className="bg-cafe-surface-elevated px-1.5 py-0.5 rounded">{from}</code>
                <span>&rarr;</span>
                <code className="bg-cafe-surface-elevated px-1.5 py-0.5 rounded">{to}</code>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Language selection */}
      <Section title="语言设置">
        <div className="flex items-center gap-3">
          <label className="text-xs text-cafe-secondary">转写语言</label>
          <select
            value={settings.language}
            onChange={(e) => setLanguage(e.target.value as typeof settings.language)}
            className="text-xs border border-cafe rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="">自动检测</option>
          </select>
        </div>
      </Section>

      {/* Custom prompt (advanced) */}
      <Section title="Whisper 上下文提示（高级）">
        <p className="text-[11px] text-cafe-secondary mb-2">
          自定义发给 Whisper 的上下文提示词。模型会偏向识别提示中出现的术语。留空使用默认值。
        </p>
        <textarea
          value={settings.customPrompt ?? ''}
          onChange={(e) => setCustomPrompt(e.target.value || null)}
          placeholder="使用默认提示词"
          rows={3}
          className="w-full text-xs border border-cafe rounded px-2 py-1.5 focus:outline-none focus:border-blue-400 resize-vertical font-mono"
        />
      </Section>

      {/* Reset */}
      <div className="flex justify-end">
        <button onClick={resetAll} className="text-xs text-cafe-muted hover:text-red-500 transition-colors">
          重置所有设置
        </button>
      </div>
    </>
  );
}
