# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.

"""权限引擎 - 核心权限控制模块.

职责:
 1. 加载 / 热更新 permissions 配置
 2. 评估工具调用权限 (allow / ask / deny)

审批流程由 react_agent._request_permission_approval 统一处理,
引擎本身只负责权限判定, 不发起审批请求。
"""

from __future__ import annotations

import logging
from typing import Any

from jiuwenclaw.agentserver.permissions.checker import (
    ExternalDirectoryChecker,
    ToolPermissionChecker,
)
from jiuwenclaw.agentserver.permissions.models import (
    PermissionLevel,
    PermissionResult,
)

logger = logging.getLogger(__name__)


class PermissionEngine:
    """权限引擎 - 负责加载配置、评估权限."""

    def __init__(self, config: dict | None = None):
        self.config = config or {}
        self._enabled = self.config.get("enabled", True)
        self._tool_checker = ToolPermissionChecker(self.config)
        self._external_checker = ExternalDirectoryChecker(self.config)

    # ---------- 配置 ----------

    def update_config(self, config: dict):
        """热更新配置."""
        self.config = config
        self._enabled = config.get("enabled", True)
        self._tool_checker = ToolPermissionChecker(config)
        self._external_checker = ExternalDirectoryChecker(config)

    @property
    def enabled(self) -> bool:
        return self._enabled

    # ---------- 权限检查 ----------

    async def check_permission(
        self,
        tool_name: str,
        tool_args: dict[str, Any],
        channel_id: str = "web",
        session_id: str | None = None,
    ) -> PermissionResult:
        """检查工具调用权限.

        Returns:
            PermissionResult 包含权限级别和匹配规则.
        """
        if not self._enabled:
            return PermissionResult(
                permission=PermissionLevel.ALLOW,
                reason="Permission system is disabled",
            )

        # 1. 先检查工具是否允许
        permission, matched_rule = self._tool_checker.check_tool(
            tool_name, tool_args, channel_id
        )
        if permission is None:
            permission = PermissionLevel.ASK
            matched_rule = "default"

        # 2. 工具允许时，再检查外部路径（仅当工具通过后才检查路径）
        if permission == PermissionLevel.ALLOW:
            ext_result = self._external_checker.check_external_paths(tool_name, tool_args)
            if ext_result:
                logger.info("Tool %s blocked by external directory check", tool_name)
                return ext_result

        result = PermissionResult(
            permission=permission,
            matched_rule=matched_rule,
            reason=self._get_reason(permission, tool_name, matched_rule),
        )

        logger.info(
            "Permission check: tool=%s, result=%s, rule=%s, channel=%s",
            tool_name, permission.value, matched_rule, channel_id,
        )
        return result

    # ---------- 辅助 ----------

    @staticmethod
    def _get_reason(
        permission: PermissionLevel, tool_name: str, matched_rule: str
    ) -> str:
        if permission == PermissionLevel.ALLOW:
            return f"Allowed by rule: {matched_rule}"
        if permission == PermissionLevel.DENY:
            return f"Denied by rule: {matched_rule}"
        return f"Approval required for {tool_name} (rule: {matched_rule})"


# ----- 全局单例 -----
_permission_engine: PermissionEngine | None = None


def init_permission_engine(config: dict | None = None) -> PermissionEngine:
    """初始化全局权限引擎."""
    global _permission_engine
    if _permission_engine is None:
        _permission_engine = PermissionEngine(config)
    if config is not None:
        _permission_engine.update_config(config)
    return _permission_engine


def get_permission_engine() -> PermissionEngine:
    """获取全局权限引擎实例 (懒初始化)."""
    global _permission_engine
    if _permission_engine is None:
        _permission_engine = PermissionEngine()
    return _permission_engine


def set_permission_engine(engine: PermissionEngine):
    """替换全局权限引擎 (测试用)."""
    global _permission_engine
    _permission_engine = engine

