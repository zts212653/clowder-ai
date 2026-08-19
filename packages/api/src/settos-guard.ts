/**
 * Node 24.16+ / undici 崩溃防护：writeH1 对每个 HTTP/1.1 请求无条件调
 * socket.setTypeOfService()，调用处无 try/catch；macOS 上该 setsockopt 会因
 * socket 状态随机同步抛 EINVAL，未捕获异常直接杀死整个进程（fetch promise
 * 层接不到）。上游 nodejs/undici#5544，修复 #5547 已 merge 但尚未进任何
 * Node release。QoS 打标本就是 best-effort——失败吞掉即可。
 *
 * 必须作为 index.ts 的第一个 import，确保在任何出站 fetch 前生效。
 * 等 Node 自带的 undici 包含修复后可删除本文件。
 */
import net from 'node:net';

type SocketWithTos = net.Socket & {
  setTypeOfService?: (tos: number) => net.Socket;
};

const proto = net.Socket.prototype as SocketWithTos;
const original = proto.setTypeOfService;

if (typeof original === 'function') {
  proto.setTypeOfService = function setTypeOfServiceGuarded(tos: number) {
    try {
      return original.call(this, tos);
    } catch {
      return this;
    }
  };
}
