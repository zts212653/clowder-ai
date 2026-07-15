/**
 * F113 DrivesView: the "此电脑" drive-picker grid with loading/error/empty states.
 * Extracted from DirectoryBrowser.tsx (R3 review P2#4: split root-navigation slice).
 */
import { DriveIcon } from './directory-browser-icons';
import type { DriveInfo, DrivesState } from './use-drives-loader';

interface DrivesViewProps {
  drives: DriveInfo[];
  drivesState: DrivesState;
  activeProjectPath?: string;
  onSelectDrive: (path: string) => void;
  onRetry: () => void;
}

export function DrivesView({ drives, drivesState, activeProjectPath, onSelectDrive, onRetry }: DrivesViewProps) {
  return (
    <div className="py-2">
      {drivesState === 'loading' && (
        <div className="flex items-center justify-center py-8">
          <span className="text-xs text-cafe-muted">正在加载磁盘列表...</span>
        </div>
      )}
      {drivesState === 'error' && (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <span className="text-xs text-cafe-muted">磁盘列表加载失败</span>
          <button type="button" onClick={onRetry} className="text-xs text-cafe-accent hover:underline">
            重试
          </button>
        </div>
      )}
      {drivesState === 'ready' && drives.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <span className="text-xs text-cafe-muted">未发现可用磁盘</span>
        </div>
      )}
      {drivesState === 'ready' && drives.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5 px-2">
          {drives.map((drive) => {
            const isActive = activeProjectPath?.toLowerCase() === drive.path.toLowerCase();
            return (
              <button
                key={drive.letter}
                type="button"
                onClick={() => onSelectDrive(drive.path)}
                className={`text-left px-3 py-2.5 text-sm rounded-lg transition-colors flex items-center gap-2.5 ${
                  isActive ? 'bg-cafe-surface ring-1 ring-cafe-accent/40' : 'hover:bg-cafe-surface/50'
                }`}
                title={drive.path}
              >
                <DriveIcon className="text-cafe-muted" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-cafe-black truncate">{drive.label}</div>
                  <div className="text-micro text-cafe-muted truncate">{drive.path}</div>
                </div>
                {isActive && <span className="text-micro text-cafe-accent flex-shrink-0">当前项目</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
