import type { ContentScanFinding } from '@cat-cafe/shared';

interface ScanPattern {
  regex: RegExp;
  severity: 'critical' | 'warning';
  label: string;
}

const PATTERNS: ScanPattern[] = [
  { regex: /ignore\s+(?:all\s+)?(?:previous\s+)?instructions/i, severity: 'critical', label: 'ignore.*instructions' },
  {
    regex: /override\s+(?:all\s+)?(?:safety|security)\s+(?:rules|checks)/i,
    severity: 'critical',
    label: 'override safety rules',
  },
  {
    regex: /bypass\s+(?:all\s+)?(?:safety|security)\s+(?:rules|checks|restrictions)/i,
    severity: 'critical',
    label: 'bypass security',
  },
  {
    regex: /(?:send|post|transmit|exfiltrate)\s+.*(?:data|info|content)\s+to\s+https?:\/\//i,
    severity: 'critical',
    label: 'data exfiltration to URL',
  },
  {
    regex: /(?:read|access|open|cat)\s+.*(?:\.env|credentials|secret|api[._-]?key)/i,
    severity: 'warning',
    label: 'credential access',
  },
  {
    regex: /(?:modify|edit|write|overwrite|change)\s+.*(?:capabilities\.json|config\.json|settings\.json)/i,
    severity: 'warning',
    label: 'config tampering',
  },
  {
    regex: /(?:disable|remove|delete)\s+.*(?:safety|security|guard|permission)/i,
    severity: 'critical',
    label: 'disable safety',
  },
  {
    regex: /(?:you\s+(?:are|must)\s+(?:now\s+)?(?:a|an)\s+)/i,
    severity: 'warning',
    label: 'role reassignment attempt',
  },
  // Chinese patterns
  { regex: /忽略.{0,6}(?:之前|以前|所有|全部).{0,4}(?:指令|指示|规则|说明)/, severity: 'critical', label: '忽略指令' },
  { regex: /(?:绕过|跳过|无视|覆盖).{0,6}(?:安全|权限|检查|规则|限制)/, severity: 'critical', label: '绕过安全' },
  {
    regex: /(?:(?:发送|传输|上传|提交).{0,20}https?:\/\/|(?:把|将).{0,20}(?:发送|传输|上传|提交).{0,10}https?:\/\/)/,
    severity: 'critical',
    label: '数据外泄',
  },
  {
    regex: /(?:读取|访问|打开|获取).{0,6}(?:\.env|密钥|凭证|credential|secret|api[._-]?key)/,
    severity: 'warning',
    label: '凭证访问',
  },
  {
    regex: /(?:修改|编辑|覆盖|删除).{0,6}(?:capabilities|config|settings|配置).{0,4}(?:文件|\.json)/,
    severity: 'warning',
    label: '配置篡改',
  },
  { regex: /(?:禁用|关闭|移除|删除).{0,6}(?:安全|权限|守卫|防护)/, severity: 'critical', label: '禁用安全' },
];

export function scanSkillContent(content: string): ContentScanFinding[] {
  const lines = content.split('\n');
  const findings: ContentScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          pattern: pattern.label,
          severity: pattern.severity,
          line: i + 1,
          context: line.slice(0, 120),
        });
      }
    }
  }

  return findings;
}
