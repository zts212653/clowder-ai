# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.

"""Path management for JiuWenClaw.

Runtime layout:
- ~/.jiuwenclaw/config/config.yaml
- ~/.jiuwenclaw/config/.env
- ~/.jiuwenclaw/agent/home
- ~/.jiuwenclaw/agent/memory
- ~/.jiuwenclaw/agent/skills
- ~/.jiuwenclaw/agent/sessions
- ~/.jiuwenclaw/agent/workspace（运行时文件与 agent-data.json）
- ~/.jiuwenclaw/.checkpoint
- ~/.jiuwenclaw/.logs

内置模板位于包内 ``jiuwenclaw/resources/``（含 ``agent/`` 下 HEARTBEAT_ZH/EN、PRINCIPLE、TONE 等，以及 ``skills_state.json``）。
"""

import importlib.util
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Literal, Optional
from logging.handlers import RotatingFileHandler
from ruamel.yaml import YAML



# User home directory
USER_HOME = Path.home()
USER_WORKSPACE_DIR = USER_HOME / ".jiuwenclaw"

# Cache for resolved paths
_config_dir: Path | None = None
_workspace_dir: Path | None = None
_root_dir: Path | None = None
_is_package: bool | None = None
_initialized: bool = False


def _detect_installation_mode() -> bool:
    """Detect if running from a package installation (whl) or PyInstaller bundle."""
    global _is_package
    if _is_package is not None:
        return _is_package

    # PyInstaller 打包后使用用户工作区路径
    if getattr(sys, "frozen", False):
        _is_package = True
        return True

    # Check if module is in site-packages
    module_file = Path(__file__).resolve()

    # Check if module file is in any site-packages directory
    for path in sys.path:
        site_packages = Path(path)
        if "site-packages" in str(site_packages) and site_packages in module_file.parents:
            _is_package = True
            return True

    _is_package = False
    return False


def _find_source_root() -> Path:
    """Find the repository root in development mode (contains jiuwenclaw/ package)."""
    current = Path(__file__).resolve().parent.parent
    jw_pkg = current / "jiuwenclaw"
    if (jw_pkg / "resources" / "agent").exists():
        return current
    parent = current.parent
    jw_pkg2 = parent / "jiuwenclaw"
    if (jw_pkg2 / "resources" / "agent").exists():
        return parent
    return current


def _find_package_root() -> Path | None:
    """Best-effort detection of the jiuwenclaw package root.

    In package mode (whl), __file__ is at site-packages/jiuwenclaw/paths.py,
    so parent is site-packages/jiuwenclaw/.
    In editable / source mode, __file__ is at <project>/jiuwenclaw/paths.py,
    so parent is <project>/jiuwenclaw/.
    """
    current = Path(__file__).resolve().parent
    return current


def _resolve_preferred_language(
    config_yaml_dest: Path, explicit: Optional[str]
) -> str:
    """确定初始化使用的语言：显式参数优先，否则读已复制的 config，默认 zh。"""
    if explicit is not None:
        lang = str(explicit).strip().lower()
        return lang if lang in ("zh", "en") else "zh"
    if config_yaml_dest.exists():
        try:
            rt = YAML()
            with open(config_yaml_dest, "r", encoding="utf-8") as f:
                data = rt.load(f) or {}
            lang = str(data.get("preferred_language") or "zh").strip().lower()
            if lang in ("zh", "en"):
                return lang
        except Exception as e:
            logger.error(f"Failed to load config.yaml: {e}")
    return "zh"


def prompt_preferred_language() -> Optional[Literal["zh", "en"]]:
    """交互询问语言偏好。仅接受明确选项；空输入、不在列表或取消用语 → 返回 None（调用方应终止 init）。"""
    print()
    print("[jiuwenclaw-init] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("[jiuwenclaw-init]  请选择默认语言 / Choose your default language")
    print("[jiuwenclaw-init] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("[jiuwenclaw-init]   [1] 中文（简体）")
    print("[jiuwenclaw-init]       → config: preferred_language: zh")
    print("[jiuwenclaw-init]       → 复制 PRINCIPLE_ZH.md / TONE_ZH.md 为 home/PRINCIPLE.md、TONE.md")
    print("[jiuwenclaw-init]   ────────────────────────────────────────────")
    print("[jiuwenclaw-init]   [2] English")
    print("[jiuwenclaw-init]       → config: preferred_language: en")
    print("[jiuwenclaw-init]       → copy PRINCIPLE_EN.md / TONE_EN.md → home/PRINCIPLE.md, TONE.md")
    print("[jiuwenclaw-init] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("[jiuwenclaw-init]  须明确选择：1 / 2 / zh / en（无默认语言）")
    print("[jiuwenclaw-init]  取消：no / n / q / cancel / 取消")
    print("[jiuwenclaw-init] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    raw = input(
        "[jiuwenclaw-init] 请输入选项 (1, 2, zh, en) 或 no 取消: "
    ).strip().lower()
    if raw in ("no", "n", "q", "quit", "cancel", "取消"):
        return None
    if raw in ("1", "zh", "中文", "chinese"):
        return "zh"
    if raw in ("2", "en", "english", "e", "英文"):
        return "en"
    print("[jiuwenclaw-init] 无效选项；未选择有效语言，初始化已取消（与拒绝 yes/no 相同）。")
    return None


def prepare_workspace(overwrite: bool = True, preferred_language: Optional[str] = None):
    package_root = _find_package_root()
    if not package_root:
        raise RuntimeError("package root not found")

    USER_WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    # ----- config: copy config.yaml -----
    resources_dir = package_root / "resources"
    config_yaml_src_candidates = [
        resources_dir / "config.yaml",
        package_root / "config" / "config.yaml",
    ]

    config_yaml_src = next((p for p in config_yaml_src_candidates if p.exists()), None)

    if not config_yaml_src:
        raise RuntimeError(
            "config.yaml template not found; tried: "
            + ", ".join(str(p) for p in config_yaml_src_candidates)
        )

    config_dest_dir = USER_WORKSPACE_DIR / "config"
    config_dest_dir.mkdir(parents=True, exist_ok=True)
    config_yaml_dest = config_dest_dir / "config.yaml"

    if overwrite or not config_yaml_dest.exists():
        shutil.copy2(config_yaml_src, config_yaml_dest)

    resolved_lang = _resolve_preferred_language(config_yaml_dest, preferred_language)

    # ----- 内置模板根目录：<package>/resources（含 agent/、skills_state.json）-----
    template_root = resources_dir
    template_agent_dir = template_root / "agent"
    if not template_agent_dir.is_dir():
        raise RuntimeError(f"resources template missing agent dir: {template_agent_dir}")

    # ----- .env: copy from template to config/.env -----
    env_template_src_candidates = [
        resources_dir / ".env.template",
        package_root / ".env.template",
    ]
    env_template_src = next((p for p in env_template_src_candidates if p.exists()), None)
    if not env_template_src:
        raise RuntimeError(
            "env template source not found; tried: "
            + ", ".join(str(p) for p in env_template_src_candidates)
        )
    env_dest = USER_WORKSPACE_DIR / "config" / ".env"
    if overwrite or not env_dest.exists():
        shutil.copy2(env_template_src, env_dest)

    # ----- copy runtime dirs (new layout) -----
    agent_root = USER_WORKSPACE_DIR / "agent"
    agent_home = agent_root / "home"
    agent_skills = agent_root / "skills"
    agent_memory = agent_root / "memory"
    agent_sessions = agent_root / "sessions"
    (USER_WORKSPACE_DIR / ".checkpoint").mkdir(parents=True, exist_ok=True)
    (USER_WORKSPACE_DIR / ".logs").mkdir(parents=True, exist_ok=True)

    template_agent_workspace = template_agent_dir / "workspace"
    template_agent_memory = template_agent_dir / "memory"
    template_agent_skills = template_agent_dir / "skills"

    agent_workspace = agent_root / "workspace"

    def _copy_dir(src_dir: Path, dst_dir: Path) -> None:
        if not src_dir.exists():
            return
        if overwrite and dst_dir.exists():
            shutil.rmtree(dst_dir)
        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        if not dst_dir.exists():
            shutil.copytree(src_dir, dst_dir)
        else:
            shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True)

    # agent/workspace 可不在仓库中（agent-data.json 由运行时生成）；无模板子目录时建空目录
    if template_agent_workspace.exists():
        _copy_dir(template_agent_workspace, agent_workspace)
    else:
        if overwrite and agent_workspace.exists():
            shutil.rmtree(agent_workspace)
        agent_workspace.mkdir(parents=True, exist_ok=True)
    _copy_dir(template_agent_memory, agent_memory)
    _copy_dir(template_agent_skills, agent_skills)

    # home: 按语言将 PRINCIPLE/TONE/HEARTBEAT 模板复制为无后缀的 .md
    if overwrite and agent_home.exists():
        shutil.rmtree(agent_home)
    agent_home.mkdir(parents=True, exist_ok=True)
    suffix = "_ZH" if resolved_lang == "zh" else "_EN"
    _principle_src = template_agent_dir / f"PRINCIPLE{suffix}.md"
    _tone_src = template_agent_dir / f"TONE{suffix}.md"
    _heartbeat_src = template_agent_dir / f"HEARTBEAT{suffix}.md"
    if _principle_src.exists():
        shutil.copy2(_principle_src, agent_home / "PRINCIPLE.md")
    if _tone_src.exists():
        shutil.copy2(_tone_src, agent_home / "TONE.md")
    if _heartbeat_src.exists():
        shutil.copy2(_heartbeat_src, agent_home / "HEARTBEAT.md")

    # skills state: shipped under resources/
    skills_state_src = template_root / "skills_state.json"
    if skills_state_src.exists():
        agent_skills.mkdir(parents=True, exist_ok=True)
        shutil.copy2(skills_state_src, agent_skills / "skills_state.json")

    # sessions is runtime-only (template may not include it)
    agent_sessions.mkdir(parents=True, exist_ok=True)

    # 与 home 模板语言一致，写回顶层 preferred_language
    from jiuwenclaw.config import set_preferred_language_in_config_file

    set_preferred_language_in_config_file(config_yaml_dest, resolved_lang)


def init_user_workspace(overwrite: bool = True) -> Path | Literal["cancelled"]:
    """Initialize ~/.jiuwenclaw from package or source resources.

    资源布局:
    - 模板配置:   <package_root>/resources/config.yaml
    - .env 模板: <package_root>/resources/.env.template
    - 数据模板:   <package_root>/resources/agent（含 HEARTBEAT_ZH/EN 等）、skills_state.json

    上述内容会被复制到:
    - ~/.jiuwenclaw/config/config.yaml（含 preferred_language）
    - ~/.jiuwenclaw/config/.env
    - ~/.jiuwenclaw/agent/...（home 下 PRINCIPLE.md / TONE.md / HEARTBEAT.md 由所选语言决定）

    交互式 init 会先询问语言；首次启动 app 时非交互 prepare_workspace 则沿用模板 config 中的语言。
    """
    if USER_WORKSPACE_DIR.exists():
        # Warn user about data loss and ask for confirmation
        print("[jiuwenclaw-init] WARNING: This will delete all historical configuration and memory information.")
        print("[jiuwenclaw-init] This action cannot be undone.")
        confirmation = input("[jiuwenclaw-init] Do you want to confirm reinitialization? (yes/no): ").strip().lower()

        if confirmation not in ("yes", "y"):
            print("[jiuwenclaw-init] Initialization cancelled. Exiting.")
            return "cancelled"

    lang = prompt_preferred_language()
    if lang is None:
        print("[jiuwenclaw-init] Initialization cancelled. Exiting.")
        return "cancelled"
    print(f"[jiuwenclaw-init] 将使用语言 / Language: {lang}")
    prepare_workspace(overwrite, preferred_language=lang)

    return USER_WORKSPACE_DIR


def _resolve_paths() -> None:
    """Resolve and cache all paths."""
    global _initialized, _config_dir, _workspace_dir, _root_dir

    if _initialized:
        return

    # 优先使用已初始化的用户工作区 (~/.jiuwenclaw)，
    # 保证源码运行与安装包运行后的读写路径完全一致。
    user_config_dir = USER_WORKSPACE_DIR / "config"
    user_workspace_dir = USER_WORKSPACE_DIR / "agent" / "workspace"
    if user_config_dir.exists():
        _root_dir = USER_WORKSPACE_DIR
        _config_dir = user_config_dir
        _workspace_dir = user_workspace_dir
    else:
        # 尚未初始化 ~/.jiuwenclaw：从包内 resources 直读配置，工作区指向包内 agent/workspace
        package_root = _find_package_root()
        if package_root and (package_root / "resources" / "config.yaml").exists():
            res = package_root / "resources"
            _root_dir = package_root.parent
            _config_dir = res
            _workspace_dir = res / "agent" / "workspace"
            _workspace_dir.mkdir(parents=True, exist_ok=True)
        else:
            source_root = _find_source_root()
            pkg = source_root / "jiuwenclaw"
            res = pkg / "resources"
            _root_dir = source_root
            _config_dir = res if (res / "config.yaml").exists() else source_root / "config"
            _workspace_dir = res / "agent" / "workspace"
            _workspace_dir.mkdir(parents=True, exist_ok=True)

    _initialized = True


def get_config_dir() -> Path:
    """Get the config directory path."""
    _resolve_paths()
    return _config_dir


def get_workspace_dir() -> Path:
    """Get the workspace directory path."""
    _resolve_paths()
    return _workspace_dir


def get_project_workspace_dir() -> Path:
    project_dir = (os.getenv("JIUWENCLAW_PROJECT_DIR") or "").strip()
    if project_dir:
        return Path(project_dir).resolve()
    return get_workspace_dir()


def get_root_dir() -> Path:
    """Get the root directory path."""
    _resolve_paths()
    return _root_dir


def get_agent_workspace_dir() -> Path:
    """Get the agent workspace directory path."""
    return USER_WORKSPACE_DIR / "agent" / "workspace"


def get_agent_root_dir() -> Path:
    return USER_WORKSPACE_DIR / "agent"


def get_agent_home_dir() -> Path:
    return get_agent_root_dir() / "home"


def get_agent_memory_dir() -> Path:
    return get_agent_root_dir() / "memory"


def get_agent_skills_dir() -> Path:
    return get_agent_root_dir() / "skills"


def get_agent_sessions_dir() -> Path:
    return get_agent_root_dir() / "sessions"


def get_checkpoint_dir() -> Path:
    return USER_WORKSPACE_DIR / ".checkpoint"


def get_logs_dir() -> Path:
    return USER_WORKSPACE_DIR / ".logs"


def get_xy_tmp_dir() -> Path:
    xy_tmp_dir = USER_WORKSPACE_DIR / "tmp" / "xiaoyi"
    xy_tmp_dir.mkdir(parents=True, exist_ok=True)
    return xy_tmp_dir


def get_env_file() -> Path:
    return get_config_dir() / ".env"


def get_config_file() -> Path:
    """Get the config.yaml file path."""
    return get_config_dir() / "config.yaml"


def is_package_installation() -> bool:
    """Check if running from package installation."""
    return _detect_installation_mode()


def setup_logger(log_level: str = "INFO") -> logging.Logger:
    """Setup logger with console and file handlers."""
    logs_root = get_logs_dir()
    logs_root.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger("jiuwenclaw.app")
    logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))
    logger.propagate = False
    for handler in logger.handlers[:]:
        handler.close()
        logger.removeHandler(handler)

    formatter = logging.Formatter(
        fmt="%(asctime)s.%(msecs)03d %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    file_handler = RotatingFileHandler(
        filename=logs_root / "app.log",
        maxBytes=20 * 1024 * 1024,
        backupCount=20,
        encoding="utf-8"
    )
    file_handler.setFormatter(formatter)

    logger.addHandler(stream_handler)
    logger.addHandler(file_handler)
    return logger

logger = setup_logger(os.getenv("LOG_LEVEL", "INFO"))
