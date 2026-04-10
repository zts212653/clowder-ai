#!/bin/bash

# Cat Cafe 初始化脚本
# 用于首次设置项目环境

set -e

echo "🐱 Cat Café 初始化脚本"
echo "======================"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查必要工具
check_requirements() {
    echo ""
    echo "检查必要工具..."

    if ! command -v node &> /dev/null; then
        echo -e "${RED}错误: 未找到 Node.js${NC}"
        echo "请安装 Node.js 20+ : https://nodejs.org/"
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        echo -e "${RED}错误: Node.js 版本过低 (需要 >= 20)${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

    if ! command -v pnpm &> /dev/null; then
        echo -e "${YELLOW}未找到 pnpm，正在安装...${NC}"
        npm install -g pnpm
    fi
    echo -e "${GREEN}✓ pnpm $(pnpm -v)${NC}"

    if ! command -v redis-cli &> /dev/null; then
        echo -e "${YELLOW}警告: 未找到 Redis CLI${NC}"
        echo "请安装 Redis: brew install redis (macOS)"
    else
        echo -e "${GREEN}✓ Redis CLI${NC}"
    fi

    # F088 Phase J2: pandoc for document generation (MD → PDF/DOCX)
    if ! command -v pandoc &> /dev/null; then
        echo -e "${YELLOW}未找到 pandoc，正在安装...${NC}"
        if command -v brew &> /dev/null; then
            brew install pandoc
        else
            echo -e "${YELLOW}警告: 未找到 brew，请手动安装 pandoc: https://pandoc.org/installing.html${NC}"
        fi
    fi
    if command -v pandoc &> /dev/null; then
        echo -e "${GREEN}✓ pandoc $(pandoc --version | head -1 | awk '{print $2}')${NC}"
    fi
}

# 创建数据目录
setup_data_dir() {
    echo ""
    echo "创建数据目录..."

    DATA_DIR="${CAT_CAFE_DATA_DIR:-$HOME/.cat-cafe}"

    mkdir -p "$DATA_DIR/chat"
    mkdir -p "$DATA_DIR/memory"
    mkdir -p "$DATA_DIR/workspace"
    mkdir -p "$DATA_DIR/assets"
    mkdir -p "$DATA_DIR/.state"

    echo -e "${GREEN}✓ 数据目录: $DATA_DIR${NC}"
}

# 检查环境变量
check_env() {
    echo ""
    echo "检查环境变量..."

    if [ ! -f .env ]; then
        if [ -f .env.example ]; then
            echo -e "${YELLOW}未找到 .env 文件，从模板创建...${NC}"
            cp .env.example .env
            echo -e "${YELLOW}启动后在 Hub → 系统配置 → 账号配置 中添加 API Key${NC}"
        else
            echo -e "${RED}错误: 未找到 .env.example 模板${NC}"
            exit 1
        fi
    fi

    # Auth is managed via unified accounts system (~/.cat-cafe/accounts.json + credentials.json).
    # Run `node scripts/install-auth-config.mjs` to configure API keys.
    source .env 2>/dev/null || true
}

# 安装依赖
install_deps() {
    echo ""
    echo "安装依赖..."
    pnpm install
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
}

# 构建项目
build_project() {
    echo ""
    echo "构建项目..."
    pnpm run build
    echo -e "${GREEN}✓ 项目构建完成${NC}"
}

# 安装 Git Guards（hooks + zdiff3）
install_git_guards() {
    echo ""
    echo "安装 Git Guards..."
    if [ -f "$PWD/scripts/install-git-guards.sh" ]; then
        bash "$PWD/scripts/install-git-guards.sh"
    else
        echo -e "${YELLOW}警告: 未找到 install-git-guards.sh，跳过${NC}"
    fi
}

# 主函数
main() {
    check_requirements
    setup_data_dir
    check_env
    install_deps
    install_git_guards
    build_project

    echo ""
    echo "========================"
    echo -e "${GREEN}🎉 Cat Café 初始化完成！${NC}"
    echo ""
    echo "下一步："
    echo "  1. 打开 http://localhost:3003 → Hub → 系统配置 → 账号配置，添加 API Key"
    echo "  2. 启动 Redis: redis-server"
    echo "  3. 运行开发服务器: pnpm run start"
    echo ""
}

main "$@"
