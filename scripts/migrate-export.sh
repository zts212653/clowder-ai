#!/bin/bash
# Clowder AI 迁移打包脚本 (Ubuntu → GitCode → Windows)
# 用法: ./scripts/migrate-export.sh <密码>
# 产出: /tmp/cc-backup-repo/clowder-backup.tar.gz.enc + restore-manifest.json
# 可逆: 不修改任何原文件，纯只读导出
set -euo pipefail

PASSWORD="${1:-}"
if [ -z "$PASSWORD" ]; then
  echo "用法: $0 <加密密码>"
  echo "示例: $0 'my-secret-pass-2026'"
  exit 1
fi

PROJECT_DIR="/home/developer/clowder-ai"
HOME_DIR="/home/developer"
REPO_DIR="/tmp/cc-backup-repo"
TARBALL="/tmp/clowder-backup.tar.gz"
ENC_FILE="$REPO_DIR/clowder-backup.tar.gz.enc"
GC_REMOTE="https://<user>:<token>@<your-git-host>/<owner>/cc-backup.git"

echo "=== [1/5] 准备打包目录 ==="
rm -rf "$REPO_DIR"
GIT_TERMINAL_PROMPT=0 git clone "${GC_REMOTE}" "$REPO_DIR" --quiet
echo "  clone OK → $REPO_DIR"

echo "=== [2/5] 打包 (tar.gz) ==="
# 用 transform 保留原路径结构，但解包时能区分项目内 vs 家目录
# 结构:
#   project/.cat-cafe/  project/.env  project/.mcp.json
#   project/data/transcripts/
#   project/*.sqlite (+ -wal + -shm)
#   home/.claude/skills  home/.claude/settings.json  home/.claude/hooks
#   redis/dump.rdb
TAR_ROOT="/tmp/clowder-backup-staging"
rm -rf "$TAR_ROOT"
mkdir -p "$TAR_ROOT/project" "$TAR_ROOT/home/.claude" "$TAR_ROOT/redis"

# 项目内文件
cp -a "$PROJECT_DIR/.cat-cafe" "$TAR_ROOT/project/"
cp -a "$PROJECT_DIR/.env" "$TAR_ROOT/project/"
cp -a "$PROJECT_DIR/.mcp.json" "$TAR_ROOT/project/"
cp -a "$PROJECT_DIR/data" "$TAR_ROOT/project/"
# sqlite 主文件 + wal + shm (保证一致)
for db in evidence world event-memory task-outcome-episodes; do
  cp -a "$PROJECT_DIR/$db.sqlite"* "$TAR_ROOT/project/"
done

# 家目录配置 (只迁 skills/settings/hooks，跳过 projects/telemetry 按Unix路径索引)
# skills 用 -rL 解引用: ~/.claude/skills 是指向 cat-cafe-skills/ 的 symlink,
# 保留链接会让 Windows tar.exe 解包时报 "Can't create ... Invalid argument" (解不开符号链接).
cp -rL "$HOME_DIR/.claude/skills" "$TAR_ROOT/home/.claude/"
cp -a "$HOME_DIR/.claude/settings.json" "$TAR_ROOT/home/.claude/"
cp -a "$HOME_DIR/.claude/hooks" "$TAR_ROOT/home/.claude/"

# Redis dump
cp -a "$HOME_DIR/.cat-cafe/redis-opensource/dump.rdb" "$TAR_ROOT/redis/"

echo "  打包内容:"
du -sh "$TAR_ROOT"/* 2>/dev/null | sed 's/^/    /'

tar czf "$TARBALL" -C "$TAR_ROOT" .
echo "  tar.gz 大小: $(du -h "$TARBALL" | cut -f1)"

echo "=== [3/5] 加密 (AES-256-CBC + pbkdf2) ==="
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
  -in "$TARBALL" \
  -out "$ENC_FILE" \
  -pass pass:"$PASSWORD"
echo "  加密包大小: $(du -h "$ENC_FILE" | cut -f1)"

echo "=== [4/5] 生成 restore-manifest.json (明文，不含密钥) ==="
cat > "$REPO_DIR/restore-manifest.json" <<'MANIFEST'
{
  "version": 1,
  "created_at": "PLACEHOLDER_TIMESTAMP",
  "source_host": "ubuntu (/home/developer/clowder-ai)",
  "encryption": "openssl AES-256-CBC + pbkdf2 iter=100000",
  "decrypt_command": "openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in clowder-backup.tar.gz.enc -out clowder-backup.tar.gz -pass pass:<你的密码>",
  "archive_structure": {
    "project/": "放到 clowder-ai 项目根目录",
    "home/.claude/": "放到用户家目录 ~/.claude/ (skills+settings+hooks only)",
    "redis/dump.rdb": "放到 Windows Redis 数据目录: <project>/.cat-cafe/run/windows/data/dump.rdb"
  },
  "post_restore_actions": [
    "1. 改 .mcp.json 绝对路径: /home/developer/clowder-ai → <新项目绝对路径>",
    "2. 删除 .mcp.json 中 probe 条目的 cwd (指向旧 Downloads 路径)",
    "3. 若拉新版源码，重新应用本地 patch (见 patch-list.txt)"
  ],
  "skipped": [
    "~/.claude/projects (Unix 路径索引，Windows 读不到)",
    "~/.claude/telemetry (历史遥测)",
    "practicecenter (独立 git 仓库，单独处理)",
    "node_modules/.next/dist (新机重装生成)"
  ]
}
MANIFEST

# patch 清单
cat > "$REPO_DIR/patch-list.txt" <<'PATCHES'
# 本地 patch 清单 (若新机器拉新版源码需重新应用)
# 1. feishu/connector.yaml: FEISHU_GROUP_BOT_MENTIONS 字段 type: textarea → input
#    原因: ConfigFieldType 不支持 textarea，parser 会跳过整个 feishu manifest
# 2. connector-gateway-bootstrap.ts: prefixedEnv() 函数 (CATCAFE_ 前缀优先)
#    已在 src，新版本若已含则跳过
# 3. connector-hub pluginRegistry hotfix (dist 层): getter 懒加载 opts.pluginRegistry
#    已在 dist，新版本若已修复则跳过
# 4. /whoami 命令 (shared/dist/core-commands.js)
PATCHES

# 还原脚本自包含: clone cc-backup 后直接 .\restore.ps1 一键还原, 无需另找脚本
if [ -f "$PROJECT_DIR/scripts/restore.ps1" ]; then
  cp -a "$PROJECT_DIR/scripts/restore.ps1" "$REPO_DIR/restore.ps1"
  echo "  restore.ps1 已打包进仓库 (desktop/dev 双布局, 一键还原)"
fi

echo "=== [5/5] 推送到备份仓库 ==="
cd "$REPO_DIR"
git add -A
git commit -m "backup: clowder-ai encrypted migration snapshot" --quiet
git push origin main --quiet 2>&1 | tail -3 || git push origin HEAD:main --quiet
echo
echo "✅ 完成！加密包已推到备份仓库 (地址见顶部 GC_REMOTE，此处不回显以防泄露凭据)"
echo "   文件: clowder-backup.tar.gz.enc ($(du -h "$ENC_FILE" | cut -f1))"
echo "   说明: restore-manifest.json + patch-list.txt (明文，无密钥)"
echo
echo "📌 Windows 还原: 见 restore-manifest.json + 运行 restore.ps1"

# 清理本地暂存
rm -rf "$TAR_ROOT" "$TARBALL"
