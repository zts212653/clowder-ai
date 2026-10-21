# 首启旅程组件实现

> Issue #1466 的 Phase 1 实现（核心流程 MVP）

## 修订记录

**Revision 1 (2026-10-09)** - 响应 @codex 审核意见：
- ✅ 修正 API 端点：使用 `/api/first-run/available-clients` 和 `POST /api/cats`
- ✅ 移除 mock 登录按钮和 pending 状态
- ✅ 明确部署边界：仅桌面应用支持
- ✅ 成员创建：循环调用 `POST /api/cats`，使用完整 schema（catId, breedId, color, mentionPatterns 等）
- 🚧 应用入口集成：待集成到 App.tsx
- 🚧 状态持久化：需要同步到 ThreadStore

## 实现的组件

### 主容器
- `OnboardingJourney.tsx` - 主流程容器，管理场景切换和状态

### 场景组件
1. **DemoScenes.tsx** (场景 1-5)
   - 场景 1: 三只猫先出现
   - 场景 2: 输入框自动打字（30ms/字符，支持暂停）
   - 场景 3: 一只猫接住消息并 @ 同伴
   - 场景 4: 因为协作，结果变好了（删除线/高亮展示改动）
   - 场景 5: 解说收束

2. **ClientSetup.tsx** (场景 6)
   - 真实调用 `GET /api/first-run/available-clients` 探测本机 CLI
   - 支持 0/1/多 client 分支
   - 未认证 CLI：显示文本提示 `需要先在终端运行: <cli> auth login`
   - **Phase 1 简化**：不拉起登录流程，只提供文本指引

3. **MemberHandoff.tsx** (场景 7)
   - 循环调用 `POST /api/cats` 创建成员（每个 client 一次调用）
   - 使用完整 schema：catId, breedId, name, displayName, color, mentionPatterns, roleDescription, personality, teamStrengths
   - 添加 X-Cat-Cafe-User header（路由要求）
   - 部分失败恢复：记录已创建数量，显示具体失败信息
   - 使用完整 CAT_CONFIGS（Phase 2 将改用 catRegistry）
   - 明确区分示范团队和真实团队

4. **RealChatEntry.tsx** (场景 8)
   - 用户可自由输入
   - 入口提醒非阻塞，可关闭
   - 发送第一句话后进入真实聊天界面

### 状态管理
- `onboarding-state.ts` - 状态机设计，localStorage 持久化（前端临时缓存）
- **生产需要**：同步到 ThreadStore `firstRunQuestState`（唯一真相源）
- 支持刷新恢复（不重放已完成示范）

### 样式
- 所有组件使用 CSS Modules
- 响应式布局（桌面 + 移动端）
- 复用原型的配色和布局

## 部署边界

**仅桌面应用支持**：
- API 服务器运行在本地（Electron 主进程），探测本机环境的 CLI
- Web 应用场景：远程 API 无法探测用户电脑，首启旅程不可用

## 与技术方案的对应

| 技术方案要求 | 实现状态 | 说明 |
|------------|---------|------|
| 场景 1-5 脚本演示 | ✅ | 完整实现，使用简化动画（字母头像） |
| 场景 6 真实 client 探测 | ✅ | 调用 `GET /api/first-run/available-clients` |
| 场景 7 成员创建与交接 | ✅ | 循环调用 `POST /api/cats`，处理部分失败 |
| 场景 8 进入真实聊天 | ✅ | 发送第一句话后调用 onComplete |
| 状态持久化 | ⚠️ | 当前使用 localStorage，需同步到 ThreadStore |
| 刷新恢复机制 | ✅ | 完整实现 |
| 应用入口集成 | ❌ | 待集成到 App.tsx |

## 未实现的部分（Phase 2/3）

- [ ] character-canon sprite sheets（当前使用字母头像占位）
- [ ] 猫的跑步循环动画（当前使用 CSS transform 模拟）
- [ ] "猫→头像"形变动画
- [ ] 0 client 分支的完整安装指引
- [ ] pending 登录状态的真实 CLI 拉起和轮询
- [ ] 可选训练路径（阶段 8-12）

## 使用方式

```tsx
import { OnboardingJourney } from '@/components/onboarding/OnboardingJourney';

function App() {
  const handleComplete = (members) => {
    console.log('首启完成，成员:', members);
    // 进入真实聊天界面
  };

  return <OnboardingJourney onComplete={handleComplete} />;
}
```

## 测试

```bash
# 单元测试
pnpm --filter @cat-cafe/web test onboarding-state.test.ts

# E2E 测试（TODO）
# pnpm --filter @cat-cafe/web test:e2e onboarding-journey.test.tsx
```

## 下一步

1. 集成到 App.tsx（首启时渲染）
2. 同步状态到 ThreadStore `firstRunQuestState`
3. E2E 测试覆盖：
   - 组件渲染测试
   - API 错误处理测试
   - 0/1/多 client 分支测试
   - 部分失败恢复测试
4. 视觉打磨（Phase 2）：
   - 引入 character-canon sprite sheets
   - 实现猫的跑步循环动画
   - 接入 F155 Guide Engine
