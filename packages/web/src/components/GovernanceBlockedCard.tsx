import { GovernanceInstaller } from './GovernanceInstaller';
import { GovernanceShieldIcon } from './icons/GovernanceShieldIcon';

interface GovernanceBlockedCardProps {
  projectPath: string;
  reasonKind: 'needs_bootstrap' | 'needs_confirmation' | 'files_missing';
}

export function GovernanceBlockedCard({ projectPath }: GovernanceBlockedCardProps) {
  const dirName = projectPath.split(/[/\\]/).pop() ?? projectPath;

  return (
    <div data-testid="governance-blocked-card" className="mb-3 flex justify-center">
      <div className="max-w-[85%] w-full rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-4">
        <div className="flex items-start gap-3">
          <GovernanceShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-conn-amber-text" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-conn-amber-text">
              项目 <code className="rounded bg-conn-amber-bg px-1 py-0.5 text-xs">{dirName}</code> 的历史治理阻塞已解除
            </p>
            <p className="mt-1 text-xs text-conn-amber-text">
              现在派遣不再要求目标仓先安装治理。请重新发送原消息；若需要项目文件，请在下方预览后显式确认。
            </p>
          </div>
        </div>
        <div className="mt-4">
          <GovernanceInstaller projectPath={projectPath} allowCleanup />
        </div>
      </div>
    </div>
  );
}
