import { useCallback, useEffect, useRef, useState } from 'react';
import { CatSelector } from './ThreadSidebar/CatSelector';

export interface VoteConfig {
  question: string;
  options: string[];
  voters: string[];
  anonymous: boolean;
  timeoutSec: number;
}

export function VoteConfigModal({
  onSubmit,
  onCancel,
}: {
  onSubmit: (config: VoteConfig) => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [voters, setVoters] = useState<string[]>([]);
  const [anonymous, setAnonymous] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState(120);
  const modalRef = useRef<HTMLDivElement>(null);

  const canSubmit = question.trim().length > 0 && options.filter((o) => o.trim()).length >= 2 && voters.length > 0;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onSubmit({
      question: question.trim(),
      options: options.map((o) => o.trim()).filter(Boolean),
      voters,
      anonymous,
      timeoutSec,
    });
  }, [question, options, voters, anonymous, timeoutSec, canSubmit, onSubmit]);

  const addOption = useCallback(() => {
    if (options.length < 10) setOptions((prev) => [...prev, '']);
  }, [options.length]);

  const removeOption = useCallback(
    (index: number) => {
      if (options.length <= 2) return;
      setOptions((prev) => prev.filter((_, i) => i !== index));
    },
    [options.length],
  );

  const updateOption = useCallback((index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-close
    <div
      role="presentation"
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={(e) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel();
      }}
    >
      <div
        ref={modalRef}
        className="bg-white rounded-xl shadow-2xl w-full max-w-[480px] mx-4 max-h-[80vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-cafe-black">发起投票</h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
            title="关闭"
            aria-label="关闭"
          >
            <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Question */}
          <div>
            <label htmlFor="vote-question" className="block text-sm font-medium text-gray-700 mb-1">
              问题
            </label>
            <input
              id="vote-question"
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="例：谁最绿茶？"
              maxLength={500}
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-owner-primary"
            />
          </div>

          {/* Options */}
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-1">选项</span>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => updateOption(i, e.target.value)}
                    placeholder={`选项 ${i + 1}`}
                    maxLength={100}
                    className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-owner-primary"
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (i === options.length - 1) addOption();
                      }
                    }}
                  />
                  {options.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeOption(i)}
                      className="text-gray-400 hover:text-red-500 transition-colors px-1"
                      title={`删除选项 ${i + 1}`}
                      aria-label={`删除选项 ${i + 1}`}
                    >
                      <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fillRule="evenodd"
                          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < 10 && (
              <button
                type="button"
                onClick={addOption}
                className="mt-2 text-xs text-owner-primary hover:text-owner-dark transition-colors"
              >
                + 添加选项
              </button>
            )}
          </div>

          {/* Voter cats */}
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-1">投票猫猫</span>
            <CatSelector selectedCats={voters} onSelectionChange={setVoters} />
          </div>

          {/* Settings row */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={anonymous}
                onChange={(e) => setAnonymous(e.target.checked)}
                className="rounded border-gray-300 text-owner-primary focus:ring-owner-primary"
              />
              匿名投票
            </label>

            <div className="flex items-center gap-2 text-sm text-gray-700">
              <label htmlFor="vote-timeout">超时</label>
              <select
                id="vote-timeout"
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                className="text-sm px-2 py-1 rounded border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-owner-primary"
              >
                <option value={60}>1 分钟</option>
                <option value={120}>2 分钟</option>
                <option value={300}>5 分钟</option>
                <option value={600}>10 分钟</option>
              </select>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-owner-primary text-white hover:bg-owner-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            开始投票
          </button>
        </div>
      </div>
    </div>
  );
}
