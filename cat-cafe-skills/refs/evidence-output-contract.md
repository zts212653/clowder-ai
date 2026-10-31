# Evidence Output Contract

> 用途：统一截图、录屏、浏览器导出等媒体证据的默认落点，避免临时工件掉进仓库根目录。

## 三条规则

1. **媒体证据默认写到系统临时目录**：`${TMPDIR}/cat-cafe-evidence/{branch-or-feature}/{date}/`
2. **仓库根目录禁止媒体/设计工件**（已跟踪 + 未跟踪都不允许）：`*.png` / `*.jpg` / `*.jpeg` / `*.webp` / `*.gif` / `*.webm` / `*.mp4` / `*.mov` / `*.wav` / `*.pdf` / `*.pen`
3. **测试工件不用仓库目录**：一律用 `mkdtemp(os.tmpdir())` 或等价临时目录

## 允许入库的情况

- 需要长期保留的验收证据：显式归档到 `project-evidence/`
- Feature / Story 自带素材目录：显式归档到各自约定的 `assets/` 子目录
- 产品/品牌素材：显式归档到仓库内正式资产目录（如 `assets/`）

默认原则：**要进 repo，必须显式归档；不能因为 cwd 正好在仓库里，就把临时截图留在根目录。**

## 执行位置

- `quality-gate`：检查仓库根目录是否出现媒体/设计工件（含已跟踪和未跟踪）；命中即 BLOCK
- `browser-preview` / `vision-evidence-workflow`：默认截图路径指向系统临时目录

## 检查命令（统一口径）

```bash
# 工作树（含 staged / unstaged / untracked）
git status --short | rg '^.. [^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'

# 当前分支相对 main 已提交内容
git diff --name-only origin/main...HEAD | rg '^[^/]+\.(png|jpe?g|webp|gif|webm|mp4|mov|wav|pdf|pen)$'
```

## 不做什么

- 不靠 repo `.gitignore` 掩盖临时垃圾
- 不靠 git hook；走 Clowder AI 自己的 SOP 闸门
- 不把测试临时工件当成“证据”自动挪走；测试应修源头
