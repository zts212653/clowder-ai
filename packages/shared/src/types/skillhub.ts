/**
 * SkillHub Types — SkillsHub (skillshub.wtf) 集成类型
 */

/** SkillsHub 搜索结果中的单个 skill */
export interface SkillHubSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  repo: {
    githubOwner: string;
    githubRepoName: string;
  };
  stars?: number;
  downloads?: number;
}

/** SkillsHub 搜索 API 响应 */
export interface SkillHubSearchResponse {
  data: SkillHubSkill[];
  total: number;
  page: number;
  hasMore: boolean;
}

/** SkillsHub Resolve API 单个结果 */
export interface SkillHubResolveEntry {
  skill: SkillHubSkill;
  score: number;
  confidence: number;
  fetchUrl: string;
}

/** SkillsHub Resolve API 响应 */
export interface SkillHubResolveResponse {
  data: SkillHubResolveEntry[];
  query: string;
  tokens: string[];
  matched: number;
  threshold: number;
  ambiguity: string;
}

/** 安装 skill 请求 */
export interface SkillHubInstallRequest {
  owner: string;
  repo: string;
  skill: string;
  /** 自定义本地名称，默认用 skill slug */
  localName?: string;
}

/** 安装结果 */
export interface SkillHubInstallResult {
  success: boolean;
  name: string;
  localPath: string;
  mounts: { claude: boolean; codex: boolean; gemini: boolean };
  error?: string;
}

/** 卸载 skill 请求 */
export interface SkillHubUninstallRequest {
  name: string;
}

/** 已安装的外部 skill 信息 */
export interface InstalledSkillInfo {
  name: string;
  source: 'local' | 'skillhub';
  skillhubUrl?: string;
  installedAt?: string;
}
