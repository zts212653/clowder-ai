export interface DirectoryBrowserCopy {
  configuredPathUnavailable: string;
  browseFailed: string;
  connectFailed: string;
  createFailed: string;
  folderNamePlaceholder: string;
  create: string;
  cancel: string;
  loading: string;
  noSubdirectories: string;
  currentProject: string;
  pathPlaceholder: string;
  goToPath: string;
  thisPc: string;
  collapseBrowser: string;
  newFolderTitle: string;
  newFolder: string;
  drivesLoading: string;
  drivesFailed: string;
  retry: string;
  noDrives: string;
  viewAllDrives: string;
  switchDrive: string;
}

export const defaultDirectoryBrowserCopy: DirectoryBrowserCopy = {
  configuredPathUnavailable: '配置路径不可用，已切换到主目录',
  browseFailed: 'Failed to browse directory',
  connectFailed: 'Unable to connect to server',
  createFailed: '创建失败',
  folderNamePlaceholder: '文件夹名称...',
  create: '创建',
  cancel: '取消',
  loading: 'Loading...',
  noSubdirectories: 'No subdirectories',
  currentProject: '当前项目',
  pathPlaceholder: 'Enter path...',
  goToPath: 'Go to path',
  thisPc: '此电脑',
  collapseBrowser: '收起浏览',
  newFolderTitle: '新建文件夹',
  newFolder: '新建',
  drivesLoading: '正在加载磁盘列表...',
  drivesFailed: '磁盘列表加载失败',
  retry: '重试',
  noDrives: '未发现可用磁盘',
  viewAllDrives: '查看所有磁盘',
  switchDrive: '切换磁盘',
};

export interface DirectoryBrowserProps {
  onNavigationStart?: () => void;
  allowCreateDirectory?: boolean;
  /** Initially browsed path — defaults to home via API */
  initialPath?: string;
  /** Path of the currently active project (highlighted in listing) */
  activeProjectPath?: string;
  /** Called whenever the browsed directory changes */
  onCurrentPathChange?: (path: string) => void;
  /** Called when browsing a virtual location that is not a concrete directory */
  onVirtualLocationChange?: () => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Optional host-owned commit action for the currently browsed folder. */
  onSelectCurrent?: (path: string) => void;
  selectCurrentLabel?: string;
  /** Host vocabulary; omitted preserves the original classic browser wording. */
  copy?: DirectoryBrowserCopy;
}
