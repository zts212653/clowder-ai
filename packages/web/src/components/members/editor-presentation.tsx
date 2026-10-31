'use client';
import { createContext, type ReactNode, useContext } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { editorTextKeys } from './members.editor-copy';
import { nativeTextKeys } from './members.native-copy';
import { type MembersCopy, membersCopy } from './members.shell-copy';
export function MemberCopyProvider({ children }: { children: ReactNode }) {
  const copy = useShellCopy(membersCopy);
  return <MemberCopyContext.Provider value={copy}>{children}</MemberCopyContext.Provider>;
}
export const MemberCopyContext = createContext<MembersCopy>(membersCopy.zh);
export function useMemberText() {
  const copy = useContext(MemberCopyContext);
  return (value: string): string => {
    const entry = copy[(nativeTextKeys[value] ?? editorTextKeys[value] ?? value) as keyof MembersCopy];
    return typeof entry === 'string' ? entry : value;
  };
}
export const useMembersCopy = () => useContext(MemberCopyContext);

export const MemberEditorPresentation = createContext(false);
export const MemberFieldErrors = createContext<Record<string, boolean>>({});
export const useMemberFieldError = (field: string) => useContext(MemberFieldErrors)[field] || false;
export const useMemberEditorPresentation = () => useContext(MemberEditorPresentation);
const labels: Record<string, string> = {
  认证与模型: '模型与接入',
  身份信息: '身份',
  '别名与 @ 路由': '@ 名字',
  Client: '客户端',
  Transport: '接入方式',
  认证信息: '账号',
  'Background Color': '消息颜色',
  Model: '模型',
  '接入方式（Carrier）': '接入方式',
  'MCP Support': 'Clowder AI 工具',
  'Context Window': '上下文窗口',
  'CLI Effort': '思考深度',
  'CLI Command': '启动命令',
  'Provider 名称': '服务商名称',
  'ACP Command': 'ACP 启动命令',
  'ACP Startup Args': 'ACP 启动参数',
  'ACP Max Processes': '最多进程数',
  'ACP Idle TTL (min)': '闲置时限（分钟）',
  'Lang Code': '语言',
  Voice: '声音',
  Speed: '语速',
  'Ref Text': '参考音频文本',
  Instruct: '语气说明',
  Temperature: '声音变化',
  'Codex Sandbox (Codex)': '沙箱',
  'Codex Approval (Codex)': '审批方式',
  'Codex Auth Mode (Codex)': '认证方式',
  高级运行时参数: '高级',
};
export function useEditorLabel(label: string): string {
  const page = useMemberEditorPresentation();
  const t = useMemberText();
  return page ? t(labels[label] ?? label) : label;
}

export function useEditorText() {
  const page = useMemberEditorPresentation();
  const t = useMemberText();
  return (value: string) => (page ? t(value) : value);
}
