import AppKit

// Only the trusted opt-in Host invokes this fixed executable. Never query the
// current foreground application, enumerate windows, or fall back to AX/CG/OSA.
guard CommandLine.arguments == [CommandLine.arguments[0], "--observe"] else { exit(64) }
func writeFrame(_ value: [String: String]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(65) }
    FileHandle.standardOutput.write(bytes)
    FileHandle.standardOutput.write(Data([10]))
}
let source = ActivationSource(center: NSWorkspace.shared.notificationCenter, emit: writeFrame)
writeFrame(["kind": "ready"])
FileHandle.standardInput.readabilityHandler = { handle in
    let input = handle.availableData
    if input.isEmpty {
        DispatchQueue.main.async { source.close(); exit(0) }
    } else {
        DispatchQueue.main.async { source.close(); exit(64) }
    }
}
RunLoop.main.run()
