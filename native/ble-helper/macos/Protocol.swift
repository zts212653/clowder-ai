import Darwin
import Foundation

let bleProtocolName = "ble-helper"
let bleProtocolVersion = 1
let bleMaxLineBytes = 64 * 1024
let bleMaxValueBytes = 4 * 1024

private let allowedCommands: Set<String> = [
    "scan.start",
    "scan.stop",
    "device.inspect",
    "gatt.read",
    "device.disconnect",
    "helper.shutdown",
]

struct BleRequest {
    let requestId: String
    let command: String
    let params: [String: Any]
}

protocol BleCommandHandling: AnyObject {
    func handle(_ request: BleRequest)
}

final class ProtocolWriter {
    private let outputQueue = DispatchQueue(label: "ai.clowderai.ble-helper.stdout")

    func hello() {
        send([
            "protocol": bleProtocolName,
            "version": bleProtocolVersion,
            "kind": "hello",
        ])
    }

    func response(requestId: String, data: Any? = nil) {
        var object: [String: Any] = [
            "protocol": bleProtocolName,
            "version": bleProtocolVersion,
            "kind": "response",
            "requestId": requestId,
            "ok": true,
        ]
        if let data {
            object["data"] = data
        }
        send(object, fallbackRequestId: requestId)
    }

    func error(requestId: String, code: String) {
        send([
            "protocol": bleProtocolName,
            "version": bleProtocolVersion,
            "kind": "response",
            "requestId": requestId,
            "ok": false,
            "error": String(code.prefix(512)),
        ])
    }

    func event(name: String, data: [String: Any]) {
        send([
            "protocol": bleProtocolName,
            "version": bleProtocolVersion,
            "kind": "event",
            "event": name,
            "data": data,
        ])
    }

    func diagnostic(_ message: String) {
        let line = "[ble-helper] \(message.prefix(512))\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    private func send(_ object: [String: Any], fallbackRequestId: String? = nil) {
        outputQueue.sync {
            do {
                var data = try JSONSerialization.data(withJSONObject: object, options: [])
                if data.count > bleMaxLineBytes, let requestId = fallbackRequestId {
                    data = try JSONSerialization.data(withJSONObject: [
                        "protocol": bleProtocolName,
                        "version": bleProtocolVersion,
                        "kind": "response",
                        "requestId": requestId,
                        "ok": false,
                        "error": "response_too_large",
                    ])
                }
                guard data.count <= bleMaxLineBytes else {
                    diagnostic("Dropping oversized protocol message")
                    return
                }
                data.append(0x0A)
                FileHandle.standardOutput.write(data)
            } catch {
                diagnostic("Unable to encode protocol message")
            }
        }
    }
}

final class BleProtocolServer {
    private let writer: ProtocolWriter
    private let handler: BleCommandHandling

    init(writer: ProtocolWriter, handler: BleCommandHandling) {
        self.writer = writer
        self.handler = handler
    }

    func handleLine(_ line: Data) {
        guard line.count <= bleMaxLineBytes else {
            writer.diagnostic("Rejected oversized input line")
            return
        }
        guard
            let value = try? JSONSerialization.jsonObject(with: line),
            let object = value as? [String: Any]
        else {
            writer.diagnostic("Rejected invalid JSON")
            return
        }

        let requestId = object["requestId"] as? String
        guard
            object["protocol"] as? String == bleProtocolName,
            (object["version"] as? NSNumber)?.intValue == bleProtocolVersion,
            let requestId,
            !requestId.isEmpty,
            requestId.utf8.count <= 128,
            let command = object["command"] as? String,
            !command.isEmpty,
            command.utf8.count <= 128,
            let params = object["params"] as? [String: Any]
        else {
            if let requestId {
                writer.error(requestId: requestId, code: "invalid_request")
            } else {
                writer.diagnostic("Rejected request without a valid requestId")
            }
            return
        }

        guard allowedCommands.contains(command) else {
            writer.error(requestId: requestId, code: "unsupported_command")
            return
        }
        handler.handle(BleRequest(requestId: requestId, command: command, params: params))
    }
}

final class StdinLineReader {
    private let writer: ProtocolWriter
    private let onLine: (Data) -> Void

    init(writer: ProtocolWriter, onLine: @escaping (Data) -> Void) {
        self.writer = writer
        self.onLine = onLine
    }

    func start() {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            var buffer = Data()
            while true {
                let chunk = FileHandle.standardInput.availableData
                if chunk.isEmpty {
                    // The API process owns the helper lifetime. Queue shutdown
                    // behind any lines already dispatched to the main queue so
                    // their responses are flushed before an orderly EOF exit.
                    DispatchQueue.main.async {
                        Darwin.exit(0)
                    }
                    return
                }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    var line = buffer.prefix(upTo: newline)
                    buffer.removeSubrange(...newline)
                    if line.last == 0x0D {
                        line = line.dropLast()
                    }
                    guard line.count <= bleMaxLineBytes else {
                        writer.diagnostic("Input line exceeded 64 KiB")
                        Darwin.exit(2)
                    }
                    let ownedLine = Data(line)
                    DispatchQueue.main.async { [onLine] in
                        onLine(ownedLine)
                    }
                }
                if buffer.count > bleMaxLineBytes {
                    writer.diagnostic("Input line exceeded 64 KiB")
                    Darwin.exit(2)
                }
            }
        }
    }
}

final class ProtocolSmokeHandler: BleCommandHandling {
    private let writer: ProtocolWriter

    init(writer: ProtocolWriter) {
        self.writer = writer
    }

    func handle(_ request: BleRequest) {
        if request.command == "helper.shutdown" {
            writer.response(requestId: request.requestId, data: ["stopping": true])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
                Darwin.exit(0)
            }
            return
        }
        writer.error(requestId: request.requestId, code: "protocol_smoke_no_hardware")
    }
}
