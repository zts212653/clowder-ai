// Fixed UI and validator messages only; model IDs, paths and API errors remain source data.
export const nativeCopy = {
  zh: {
    'AGY 官方 ACP': 'AGY 官方 ACP',
    '官方 ACP 可留空；Command 填已安装程序的路径。': '官方 ACP 可留空；Command 填已安装程序的路径。',
    '启用 Native': '启用 Native',
    暂停: '暂停',
    '隔离 Profile ID': '隔离 Profile ID',
    'Profile 根目录': 'Profile 根目录',
    批准工作区: '批准工作区',
    nativeProfileRootPlaceholder: '留空使用 ~/.cat-cafe/agy-profiles',
    每行一个完整的工作区绝对路径: '每行一个完整的工作区绝对路径',
    nativeLoginHelp:
      '使用此隔离 Profile 中已登录的个人 OAuth。Model 填实际 ID（如 gemini-3.8-flash-high）。首次使用前需完成该 Profile 的登录；保存设置不会启动模型。',
    'AGY Native 需要隔离 Profile 中已登录的个人 OAuth': 'AGY Native 需要隔离 Profile 中已登录的个人 OAuth',
    '隔离 Profile ID 格式无效': '隔离 Profile ID 格式无效',
    nativeModelInvalid: 'AGY Native 模型需填写实际模型 ID，例如 gemini-3.8-flash-high',
    'AGY Native 需要至少一个批准工作区': 'AGY Native 需要至少一个批准工作区',
    'Profile 根目录和批准工作区必须使用绝对路径': 'Profile 根目录和批准工作区必须使用绝对路径',
  },
  en: {
    'AGY 官方 ACP': 'AGY Official ACP',
    '官方 ACP 可留空；Command 填已安装程序的路径。':
      'Leave arguments empty for official ACP. Set Command to the installed executable path.',
    '启用 Native': 'Enable Native',
    暂停: 'Paused',
    '隔离 Profile ID': 'Isolated Profile ID',
    'Profile 根目录': 'Profile root directory',
    批准工作区: 'Approved workspaces',
    nativeProfileRootPlaceholder: 'Leave blank to use ~/.cat-cafe/agy-profiles',
    每行一个完整的工作区绝对路径: 'One absolute workspace path per line',
    nativeLoginHelp:
      'Use the personal OAuth login in this isolated Profile. Enter a physical model ID, such as gemini-3.8-flash-high. Sign in to this Profile before using it. Saving settings does not start a model.',
    'AGY Native 需要隔离 Profile 中已登录的个人 OAuth':
      'AGY Native needs a personal OAuth login in the isolated Profile.',
    '隔离 Profile ID 格式无效': 'The isolated Profile ID has an invalid format.',
    nativeModelInvalid: 'AGY Native needs a physical model ID, such as gemini-3.8-flash-high.',
    'AGY Native 需要至少一个批准工作区': 'AGY Native needs at least one approved workspace.',
    'Profile 根目录和批准工作区必须使用绝对路径':
      'The Profile root directory and approved workspaces must use absolute paths.',
  },
};
export const nativeTextKeys: Record<string, string> = {
  '留空使用 ~/.cat-cafe/agy-profiles': 'nativeProfileRootPlaceholder',
  '使用此隔离 Profile 中已登录的个人 OAuth。Model 填实际 ID（如 gemini-3.8-flash-high）。首次使用前需完成该 Profile 的登录；保存设置不会启动模型。':
    'nativeLoginHelp',
  'AGY Native 模型需填写实际模型 ID，例如 gemini-3.8-flash-high': 'nativeModelInvalid',
};
