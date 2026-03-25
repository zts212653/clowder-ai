# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.

"""Send File Toolkit

提供发送文件到用户的工具。支持发送一个或多个文件。

使用方式：
1. 创建 SendFileToolkit 实例
2. 调用 get_tools() 获取工具列表
3. 工具会自动注册到 Runner 中
"""

from __future__ import annotations

import json
from typing import List, Union

from openjiuwen.core.foundation.tool import LocalFunction, Tool, ToolCard

from jiuwenclaw.agentserver.agent_ws_server import AgentWebSocketServer
from jiuwenclaw.utils import logger


class SendFileToolkit:
    """Toolkit for sending files to users."""

    def __init__(self, request_id: str, session_id: str, channel_id: str) -> None:
        """Initialize SendFileToolkit.

        Args:
            request_id: Request identifier for message routing.
            session_id: Session identifier for message routing.
            channel_id: Channel identifier for message routing.
        """
        self.request_id = request_id
        self.session_id = session_id
        self.channel_id = channel_id
        logger.debug(
            "[SendFileToolkit] 初始化 request_id=%s session_id=%s channel_id=%s",
            request_id,
            session_id,
            channel_id,
        )

    async def send_file(self, abs_file_path_list: Union[List[str], str]) -> str:
        """Send files to user.

        Args:
            abs_file_path_list: List of absolute file paths to send.

        Returns:
            Success message or error description.
        """
        if isinstance(abs_file_path_list, str):
            try:
                abs_file_path_list = json.loads(abs_file_path_list)
            except json.decoder.JSONDecodeError as e:
                logger.info(f"send_file args error: {e}")
                raise TypeError(f"[SendFileToolkit] send_file args error.") from e
        logger.info(
            "[SendFileToolkit] send_file 开始 session_id=%s 文件数=%d",
            self.session_id,
            len(abs_file_path_list),
        )

        try:
            server = AgentWebSocketServer.get_instance()
            msg = {
                "request_id": self.request_id,
                "channel_id": self.channel_id,
                "payload": {
                    "event_type": "chat.file",
                    "files": abs_file_path_list,
                },
                "is_complete": False,
            }
            await server.send_push(msg)
            logger.info(
                "[SendFileToolkit] send_file 完成 session_id=%s",
                self.session_id,
            )
            return f"成功发送 {len(abs_file_path_list)} 个文件"
        except Exception as e:
            logger.exception(
                "[SendFileToolkit] send_file 失败 session_id=%s error=%s",
                self.session_id,
                str(e),
            )
            return f"发送文件失败: {str(e)}"

    def get_tools(self) -> List[Tool]:
        """Return tools for registration in Runner.

        Returns:
            List of tools for sending files.
        """
        session_id = self.session_id

        def make_tool(
            name: str,
            description: str,
            input_params: dict,
            func,
        ) -> Tool:
            card = ToolCard(
                id=f"{name}_{session_id}_{self.request_id}",
                name=name,
                description=description,
                input_params=input_params,
            )
            return LocalFunction(card=card, func=func)

        return [
            make_tool(
                name="send_file_to_user",
                description=(
                    "发送文件给用户。支持发送一个或多个文件。"
                    "需要提供文件的绝对路径列表。"
                ),
                input_params={
                    "type": "object",
                    "properties": {
                        "abs_file_path_list": {
                            "type": ["array", "string"],
                            "items": {"type": "string"},
                            "description": "要发送的文件绝对路径列表",
                        }
                    },
                    "required": ["abs_file_path_list"],
                },
                func=self.send_file,
            ),
        ]
