# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.

"""AgentWebSocketServer - Gateway 与 AgentServer 之间的 WebSocket 服务端."""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import Any, ClassVar

from jiuwenclaw.utils import logger
from jiuwenclaw.schema.agent import AgentRequest, AgentResponse, AgentResponseChunk


def _payload_to_request(data: dict[str, Any]) -> AgentRequest:
    """将 Gateway 发送的 JSON 载荷解析为 AgentRequest."""
    from jiuwenclaw.schema.message import ReqMethod

    req_method = data.get("req_method")
    if req_method is not None and isinstance(req_method, str):
        req_method = ReqMethod(req_method)

    return AgentRequest(
        request_id=data["request_id"],
        channel_id=data.get("channel_id", ""),
        session_id=data.get("session_id"),
        req_method=req_method,
        params=data.get("params", {}),
        is_stream=data.get("is_stream", False),
        timestamp=data.get("timestamp", 0.0),
        metadata=data.get("metadata"),
    )


def _response_to_payload(resp: AgentResponse) -> dict[str, Any]:
    """将 AgentResponse 转为 JSON 载荷."""
    return asdict(resp)


def _chunk_to_payload(chunk: AgentResponseChunk) -> dict[str, Any]:
    """将 AgentResponseChunk 转为 JSON 载荷."""
    return asdict(chunk)


class AgentWebSocketServer:
    """Gateway 与 AgentServer 之间的 WebSocket 服务端（单例）.

    监听来自 Gateway (WebSocketAgentServerClient) 的连接，按协议约定处理请求：
    - 收到 JSON 载荷，字段为 AgentRequest（含 is_stream）
    - is_stream=False：调用 IAgentServer.process_message()，返回一条完整 AgentResponse JSON
    - is_stream=True：调用 IAgentServer.process_message_stream()，逐条返回 AgentResponseChunk JSON

    支持 send_push：AgentServer 主动向 Gateway 推送消息（需 Gateway 预注册 agent-push 队列）。
    """

    _instance: ClassVar[AgentWebSocketServer | None] = None

    def __init__(
        self,
        agent,
        host: str = "127.0.0.1",
        port: int = 18000,
        *,
        ping_interval: float | None = 30.0,
        ping_timeout: float | None = 300.0,
    ) -> None:
        self._agent = agent
        self._host = host
        self._port = port
        self._ping_interval = ping_interval
        self._ping_timeout = ping_timeout
        self._server: Any = None
        # 当前 Gateway 连接，用于 send_push 主动推送
        self._current_ws: Any = None
        self._current_send_lock: asyncio.Lock | None = None

    @classmethod
    def get_instance(
        cls,
        *,
        agent: Any = None,
        host: str = "127.0.0.1",
        port: int = 18000,
        ping_interval: float | None = 30.0,
        ping_timeout: float | None = 300.0,
    ) -> "AgentWebSocketServer":
        """返回单例实例。

        首次调用时 agent 必填，host/port/ping_* 可选。
        后续调用可省略所有参数，返回已存在的实例。

        Raises:
            RuntimeError: 首次调用未提供 agent。
        """
        if cls._instance is not None:
            return cls._instance
        if agent is None:
            raise RuntimeError(
                "AgentWebSocketServer 未初始化。首次调用需传入 agent=..."
            )
        cls._instance = cls(
            agent=agent,
            host=host,
            port=port,
            ping_interval=ping_interval,
            ping_timeout=ping_timeout,
        )
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """重置单例（仅用于测试）。"""
        cls._instance = None

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        return self._port

    # ---------- 生命周期 ----------

    async def start(self) -> None:
        """启动 WebSocket 服务端，开始监听连接。优先使用 legacy.server.serve 以与 Gateway 的 legacy client 握手兼容."""
        if self._server is not None:
            logger.warning("[AgentWebSocketServer] 服务端已在运行")
            return

        try:
            from websockets.legacy.server import serve as legacy_serve
            self._server = await legacy_serve(
                self._connection_handler,
                self._host,
                self._port,
                ping_interval=self._ping_interval,
                ping_timeout=self._ping_timeout,
            )
        except ImportError:
            import websockets
            self._server = await websockets.serve(
                self._connection_handler,
                self._host,
                self._port,
                ping_interval=self._ping_interval,
                ping_timeout=self._ping_timeout,
            )
        logger.info(
            "[AgentWebSocketServer] 已启动: ws://%s:%s", self._host, self._port
        )

    async def stop(self) -> None:
        """停止 WebSocket 服务端."""
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._server = None
        logger.info("[AgentWebSocketServer] 已停止")

    # ---------- 连接处理 ----------

    async def _connection_handler(self, ws: Any) -> None:
        """处理单个 Gateway WebSocket 连接，同一连接可并发处理多个请求."""
        import websockets

        remote = ws.remote_address
        logger.info("[AgentWebSocketServer] 新连接: %s", remote)

        send_lock = asyncio.Lock()
        self._current_ws = ws
        self._current_send_lock = send_lock

        # 发送 connection.ack 事件，通知 Gateway 服务端已就绪
        try:
            ack_frame = {
                "type": "event",
                "event": "connection.ack",
                "payload": {"status": "ready"},
            }
            await ws.send(json.dumps(ack_frame, ensure_ascii=False))
            logger.info("[AgentWebSocketServer] 已发送 connection.ack: %s", remote)
        except Exception as e:
            logger.warning("[AgentWebSocketServer] 发送 connection.ack 失败: %s", e)

        tasks: set[asyncio.Task] = set()

        try:
            async for raw in ws:
                task = asyncio.create_task(self._handle_message(ws, raw, send_lock))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        except websockets.exceptions.ConnectionClosed:
            logger.info("[AgentWebSocketServer] 连接关闭: %s", remote)
        except Exception as e:
            logger.exception("[AgentWebSocketServer] 连接处理异常 (%s): %s", remote, e)
        finally:
            self._current_ws = None
            self._current_send_lock = None
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _handle_message(self, ws: Any, raw: str | bytes, send_lock: asyncio.Lock) -> None:
        """解析一条 JSON 请求并分发到 IAgentServer 处理."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            error_payload = {
                "request_id": "",
                "channel_id": "",
                "ok": False,
                "payload": {"error": f"JSON 解析失败: {e}"},
            }
            async with send_lock:
                await ws.send(json.dumps(error_payload, ensure_ascii=False))
            return

        request = _payload_to_request(data)

        logger.info(
            "[AgentWebSocketServer] 收到请求: request_id=%s channel_id=%s is_stream=%s",
            request.request_id,
            request.channel_id,
            request.is_stream,
        )

        try:
            if request.is_stream:
                await self._handle_stream(ws, request, send_lock)
            else:
                await self._handle_unary(ws, request, send_lock)
        except Exception as e:
            logger.exception(
                "[AgentWebSocketServer] 处理请求失败: request_id=%s: %s",
                request.request_id,
                e,
            )
            error_resp = AgentResponse(
                request_id=request.request_id,
                channel_id=request.channel_id,
                ok=False,
                payload={"error": str(e)},
            )
            async with send_lock:
                await ws.send(
                    json.dumps(_response_to_payload(error_resp), ensure_ascii=False)
                )

    async def _handle_unary(self, ws: Any, request: AgentRequest, send_lock: asyncio.Lock) -> None:
        """非流式处理：调用 process_message，返回一条完整 AgentResponse."""
        resp = await self._agent.process_message(request)
        payload = _response_to_payload(resp)
        async with send_lock:
            await ws.send(json.dumps(payload, ensure_ascii=False))
        logger.info(
            "[AgentWebSocketServer] 非流式响应已发送: request_id=%s",
            request.request_id,
        )

    async def _handle_stream(self, ws: Any, request: AgentRequest, send_lock: asyncio.Lock) -> None:
        """流式处理：调用 process_message_stream，逐条发送 AgentResponseChunk."""
        chunk_count = 0
        async for chunk in self._agent.process_message_stream(request):
            chunk_count += 1
            payload = _chunk_to_payload(chunk)
            async with send_lock:
                await ws.send(json.dumps(payload, ensure_ascii=False))
        logger.info(
            "[AgentWebSocketServer] 流式响应已发送: request_id=%s 共 %s 个 chunk",
            request.request_id,
            chunk_count,
        )

    async def send_push(self, msg) -> None:
        """AgentServer 主动向 Gateway 推送消息。

        payload 格式与 AgentResponse.payload 一致，
        可含 event_type 等字段供 Gateway 转为 Message 派发到 Channel。
        """
        if self._current_ws is None or self._current_send_lock is None:
            logger.warning(
                "[AgentWebSocketServer] send_push 失败: 无活跃 Gateway 连接"
            )
            return

        try:
            async with self._current_send_lock:
                await self._current_ws.send(json.dumps(msg, ensure_ascii=False))
            logger.info(
                "[AgentWebSocketServer] send_push 已发送: channel_id=%s",
                msg["channel_id"],
            )
        except Exception as e:
            logger.warning("[AgentWebSocketServer] send_push 失败: %s", e)

    def get_agent(self):
        return getattr(self._agent, "_instance", None)