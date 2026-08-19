type DesktopUpdatePromptAction = 'download' | 'install' | 'later' | 'skip' | 'open-release' | 'dismiss';

interface DesktopUpdateAvailablePromptPayload {
  kind: 'available';
  version: string;
  currentVersion: string;
  platform: 'windows' | 'macos';
  assetName: string;
  releaseUrl: string;
  releaseNotes: string;
}

interface DesktopUpdateReadyPromptPayload {
  kind: 'ready-to-install';
  version: string;
  platform: 'windows' | 'macos';
  assetName: string;
}

interface DesktopUpdateUpToDatePromptPayload {
  kind: 'up-to-date';
  version: string;
}

interface DesktopUpdateCheckFailedPromptPayload {
  kind: 'check-failed';
  version: string;
  releaseUrl: string;
}

type DesktopUpdatePromptPayload =
  | DesktopUpdateAvailablePromptPayload
  | DesktopUpdateReadyPromptPayload
  | DesktopUpdateUpToDatePromptPayload
  | DesktopUpdateCheckFailedPromptPayload;

interface DesktopUpdateProgressPayload {
  phase: 'downloading';
  version: string;
  assetName: string;
  progress: number;
}

interface DesktopUpdateSettings {
  autoCheck: boolean;
}

interface DesktopBridge {
  onStatus(callback: (message: string) => void): () => void;
  onUpdatePrompt(callback: (prompt: DesktopUpdatePromptPayload) => void): () => void;
  onUpdateProgress(callback: (progress: DesktopUpdateProgressPayload | null) => void): () => void;
  getUpdateSettings(): Promise<DesktopUpdateSettings>;
  setUpdateAutoCheck(enabled: boolean): Promise<DesktopUpdateSettings>;
  updatePromptReady(): Promise<DesktopUpdatePromptPayload | null>;
  sendUpdatePromptAction(action: DesktopUpdatePromptAction, version: string): void;
}

interface Window {
  desktopBridge?: DesktopBridge;
}
