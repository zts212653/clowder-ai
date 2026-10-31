import type { ShellLanguage } from '../shell/shell-language';

const relative = {
  zh: new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }),
  en: new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }),
};

export function sessionProjectName(projectPath: string): string {
  return (
    projectPath
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || projectPath
  );
}

export function sessionActivity(timestamp: number, language: ShellLanguage, unknown: string, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return unknown;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return relative[language].format(0, 'second');
  if (seconds < 3600) return relative[language].format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return relative[language].format(-Math.floor(seconds / 3600), 'hour');
  return relative[language].format(-Math.floor(seconds / 86400), 'day');
}

export function sessionActivityDetail(timestamp: number, language: ShellLanguage, unknown: string): string {
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
    : unknown;
}
