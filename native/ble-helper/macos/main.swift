import Foundation

let writer = ProtocolWriter()
let smokeOnly = CommandLine.arguments.contains("--protocol-smoke")
let handler: BleCommandHandling = smokeOnly ? ProtocolSmokeHandler(writer: writer) : BleController(writer: writer)
let server = BleProtocolServer(writer: writer, handler: handler)
let reader = StdinLineReader(writer: writer) { line in
    server.handleLine(line)
}

writer.hello()
reader.start()
RunLoop.main.run()
