---
feature_ids: [F241]
topics: [windows, intranet, codeagent, installer, identity]
doc_kind: plan
created: 2026-10-22
---

# 内网 Windows CodeAgent 独立发行版

目标：交付独立 EXE 安装包；CodeAgent 直接内置 Host。2026-10-23 内网验收后调整默认推荐：Claude Code 为宪宪、CodeAgent 为砚砚、DSH 为鲸鲸，身份不重复；不依赖 #104 插件安装或 Claude Code 存在。

用户操作与一次配置入口见[内网包指南](../ops/intranet-windows-codeagent.md)。

源码：feat/intranet-windows-codeagent；承接 #1677 B/C 已提交实现及隔离后续修复 9729158b4。旧插件方案和当前运行环境保留，内网包不自动更新到公共发行版。

## 产品契约

- 安装包、应用 ID、安装目录和用户数据根独立：Clowder AI Intranet；不覆盖普通版、角色、认证、Redis 或原生会话。
- 默认端口 5331/5332/6389；不使用生产 3003/3004/6399。首次安装使用新的程序和数据目录验收，升级不能冒充首装。
- 桌面 Host 启动默认带入 trusted-host 与受限 root-only 审计策略，目录自身私有权限、本地 NTFS、非链接、鉴权和直接本机管理门禁保留，不修改系统盘 ACL。
- 默认设置来自本发行版代码，每次启动相同；用户数据根的 intranet-host.json 可持久覆盖明确策略。读取不写配置，更新程序不替换用户数据文件；显式 strict/required 与 AUDIT_LOG_DIR 均尊重。
- 原生检测只解析 PATH/常见目录，不启动 client、不调用模型。仅找到真实 CodeAgent 时，默认建议砚砚；未找到则显示不可用，不能冒充登录或协议已验证。
- 角色模板独立于 transport；一个 CodeAgent 工具仍可手工承载多个角色。已有宪宪、砚砚、墨墨的成员 ID、职责、绑定和原生会话保留，不随默认推荐调整自动改名或合并。
- 内网默认推荐仅 CodeAgent、Claude Code、DSH，推荐列表和创建结果按身份去重；Codex/Pi 保留已有及手工接入，不进入默认推荐。推荐身份与工具分开；已有角色、插件及定制接入不自动改绑或覆盖，退出默认范围的未提交草稿也保留。
- DSH 检测到程序不等同已可聊天。优先读取已配置且凭据可解析的路由，确认后生成成员独立 patch 并保存；没有可用路由时在现有配置入口补齐，不能默认采用没有 key 的 deepseek-official。
- CodeAgent 启动为 codeagent --acp。bypass 仍属客户端独立配置，不由 Host 兼容模式暗中开启；先保留实机已经验证的参数。
- 安装包包含 Host、Node、Redis、Web、Electron；企业 CodeAgent 本体和原生认证属于企业分发边界，需验收真实安装来源后记录。安装 Host 不应伪造 CodeAgent 已安装；当前作者机未检测到真实 CodeAgent。

## 验证与交付

1. 检测无 Claude/只有 CodeAgent、CodeAgent 缺失/后装重检；命令与 argv 不含插件引用。
2. Claude/CodeAgent/DSH 同时出现时身份唯一、CodeAgent 单独出现仍为砚砚、Codex/Pi 默认排除、旧草稿与成员保护；保存回读和真实 ACP 初始化、MCP、协作、重启续接分别取证。
3. persistent Host 默认、显式覆盖、审计故障重试、严格/兼容自身 ACL 反例、直接本机边界。
4. committed source 的生产 build 与独立安装包 SHA；最终交付位置 integrity check；实际 EXE 首装/首启、安装布局、健康/历史、退出/升级保留。
5. 作者测试不新增桌面快捷方式或开机启动；临时实例维护任务台账，停止仅限已核验归属。原生认证/会话与日志不进入 Git/安装包；合成 ACP 不能冒充企业 CodeAgent 实机验收。

Architecture cell：桌面发行版与原生角色发现。Map delta：增加内网默认策略及带身份的 CodeAgent 建议，不新增插件授权层。Why：让首次可用路径直接由 Host 和安装包承担。

工具目录、精确绑定与聊天名称的一致性调整见[本轮实施契约](./2026-10-23-intranet-runtime-identity.md)。
