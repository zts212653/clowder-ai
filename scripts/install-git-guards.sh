#!/bin/bash
# scripts/install-git-guards.sh — Git Guards 安装器
#
# 设置 repo-local git config，激活版本化 .githooks/ 目录。
# 幂等：多次运行结果一致。
#
# Usage:
#   pnpm guards:install
#   bash scripts/install-git-guards.sh

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "错误: 不在 git 仓库中" >&2
  exit 1
fi

echo "🛡️  Cat Café Git Guards 安装"
echo "==========================="

# 1. 设置 core.hooksPath → .githooks（版本化目录）
CURRENT_HOOKS_PATH="$(git config --local core.hooksPath 2>/dev/null || echo "")"
if [ "$CURRENT_HOOKS_PATH" = ".githooks" ]; then
  echo -e "${GREEN}✓ core.hooksPath 已指向 .githooks${NC}"
else
  git config --local core.hooksPath .githooks
  echo -e "${GREEN}✓ core.hooksPath → .githooks（原值: ${CURRENT_HOOKS_PATH:-未设置}）${NC}"
fi

# 2. 设置 merge.conflictStyle = zdiff3（三屏冲突标记）
CURRENT_CONFLICT_STYLE="$(git config --local merge.conflictStyle 2>/dev/null || echo "")"
if [ "$CURRENT_CONFLICT_STYLE" = "zdiff3" ]; then
  echo -e "${GREEN}✓ merge.conflictStyle 已设置为 zdiff3${NC}"
else
  git config --local merge.conflictStyle zdiff3
  echo -e "${GREEN}✓ merge.conflictStyle → zdiff3（原值: ${CURRENT_CONFLICT_STYLE:-未设置}）${NC}"
  echo -e "${YELLOW}  ↳ 冲突时会显示 base/ours/theirs 三段，帮助理解双方意图${NC}"
fi

# 3. 确保 .githooks/ 下的脚本有执行权限
chmod +x "$REPO_ROOT"/.githooks/* 2>/dev/null || true
echo -e "${GREEN}✓ .githooks/ 脚本已设置执行权限${NC}"

# 4. 验证
echo ""
echo "验证结果："
echo "  core.hooksPath     = $(git config --local core.hooksPath)"
echo "  merge.conflictStyle = $(git config --local merge.conflictStyle)"
echo "  hooks 文件："
ls -1 "$REPO_ROOT"/.githooks/ | sed 's/^/    /'

echo ""
echo -e "${GREEN}🎉 Git Guards 安装完成${NC}"
