import { AttachIcon } from './icons/AttachIcon';

interface MobileInputToolbarProps {
  onAttach: () => void;
  onWhisperToggle: () => void;
  onGameClick: () => void;
  onClose: () => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  maxImages?: boolean;
  whisperMode?: boolean;
}

/**
 * Expandable toolbar for mobile input — attach, whisper, game buttons.
 * Shown above the main input row when user taps the + button.
 */
export function MobileInputToolbar({
  onAttach,
  onWhisperToggle,
  onGameClick,
  onClose,
  disabled,
  sendDisabled,
  maxImages,
  whisperMode,
}: MobileInputToolbarProps) {
  const btnBase =
    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-30';

  return (
    <div className="flex gap-2 px-4 pt-2 md:hidden">
      <button
        onClick={() => {
          onAttach();
          onClose();
        }}
        disabled={disabled || sendDisabled || maxImages}
        className={`${btnBase} text-gray-600 bg-white border-gray-200 hover:border-owner-primary hover:text-owner-primary`}
      >
        <AttachIcon className="w-4 h-4" /> 附件
      </button>
      <button
        onClick={() => {
          onWhisperToggle();
          onClose();
        }}
        disabled={disabled || sendDisabled}
        className={`${btnBase} ${
          whisperMode
            ? 'text-amber-600 bg-amber-50 border-amber-300'
            : 'text-gray-600 bg-white border-gray-200 hover:border-amber-400 hover:text-amber-500'
        }`}
      >
        <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
            clipRule="evenodd"
          />
        </svg>
        悄悄话
      </button>
      <button
        onClick={() => {
          onGameClick();
          onClose();
        }}
        disabled={disabled || sendDisabled}
        className={`${btnBase} text-gray-600 bg-white border-gray-200 hover:border-indigo-400 hover:text-indigo-500`}
      >
        <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
          <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM14 11a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 110-2h1v-1a1 1 0 011-1z" />
        </svg>
        游戏
      </button>
    </div>
  );
}
