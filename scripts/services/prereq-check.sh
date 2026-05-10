#!/usr/bin/env bash
# scripts/services/prereq-check.sh
# Shared prerequisite check for ML service install scripts.
# Source this file at the top of each install script.

check_python3() {
  if ! command -v python3 &>/dev/null; then
    echo "ERROR: Python 3 未找到。"
    echo ""
    echo "请先安装 Python 3.10+："
    case "$(uname -s)" in
      Darwin) echo "  brew install python@3.12" ;;
      Linux)  echo "  sudo apt install python3 python3-venv  # Debian/Ubuntu"
              echo "  sudo dnf install python3              # Fedora/RHEL" ;;
      *)      echo "  请从 https://www.python.org/downloads/ 下载安装" ;;
    esac
    exit 1
  fi

  local py_version
  py_version=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  local major minor
  major=$(echo "$py_version" | cut -d. -f1)
  minor=$(echo "$py_version" | cut -d. -f2)
  if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 10 ]; }; then
    echo "ERROR: Python $py_version 版本过低，需要 3.10+。"
    echo "当前版本: $(python3 --version)"
    exit 1
  fi
  echo "  Python $py_version ✓"
}
