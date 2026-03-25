/**
 * SkillHubService — 数据源已切换到腾讯 SkillHub (skillhub.tencent.com)
 *
 * 所有函数委托 TencentSkillHubService 实现，保持对外接口不变。
 */

export {
  fetchSkillAllFiles,
  fetchSkillContent,
  resolveSkills,
  type SkillHubResolveEntry,
  type SkillHubResolveResponse,
  type SkillHubSearchResponse,
  type SkillHubSkill,
  searchSkills,
  trendingSkills,
} from './TencentSkillHubService.js';
