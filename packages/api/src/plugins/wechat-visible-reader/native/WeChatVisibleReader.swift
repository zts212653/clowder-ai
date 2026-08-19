import AppKit
import Darwin
import Foundation

private func installNavigationTerminationHandler(_ cancellation: NavigationCancellation) -> DispatchSourceSignal {
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(
        signal: SIGTERM,
        queue: DispatchQueue(label: "cat-cafe.wechat-navigation-signal")
    )
    source.setEventHandler { cancellation.cancel() }
    source.resume()
    return source
}

private func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else { exit(1) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private func runReaderSelfTest() -> Int32 {
    do {
        guard let image = syntheticReaderImage(),
              let profile = LayoutProfile.resolve(version: "4.1.11") else { return 1 }
        let cropped = try ReaderEngine.crop(image, to: profile.bodyRegion)
        let text = try ReaderEngine.recognize(cropped)
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: " ")
        let cropPassed = text.localizedCaseInsensitiveContains("TARGET")
            && !text.localizedCaseInsensitiveContains("SIDEBAR")
        let chromeExcluded = !text.localizedCaseInsensitiveContains("HEADER")
            && !text.localizedCaseInsensitiveContains("INPUT")
        let geometryGuard = profile.recognizes(window: CGRect(x: 0, y: 0, width: 1_200, height: 800))
            && !profile.recognizes(window: CGRect(x: 0, y: 0, width: 800, height: 800))
        let markerGuard = PixelLayoutGuard.matches(image)
            && syntheticReaderImage(includeLayoutMarkers: false).map { !PixelLayoutGuard.matches($0) } == true
        let partial = ReaderEngine.isPartial(CGRect(x: 0.1, y: 0, width: 0.2, height: 0.01))
            && !ReaderEngine.isPartial(CGRect(x: 0.1, y: 0.2, width: 0.2, height: 0.1))
        let nonText = ReaderEngine.knownNonTextIndicator("[图片]") == "image_placeholder"
            && ReaderEngine.knownNonTextIndicator("[语音]") == "voice_placeholder"
            && ReaderEngine.knownNonTextIndicator("微信红包") == "red_packet"
            && ReaderEngine.knownNonTextIndicator("[引用]") == "quote_placeholder"
        let confidence = ReaderEngine.passesPageConfidence([1, 1, 0.5, 0.5, 0.3, 0.3, 0.3, 0.3])
            && !ReaderEngine.passesPageConfidence([0.95, 0.10])
        let passed = cropPassed && chromeExcluded && geometryGuard && markerGuard && partial && nonText && confidence
        emit(SelfTestResult(ok: passed, tests: [
            "crop_before_ocr",
            "header_input_excluded",
            "layout_geometry_guard",
            "layout_marker_guard",
            "partial_abstention",
            "non_text_indicators",
            "page_confidence_fail_closed",
            "in_memory_only",
        ]))
        return passed ? 0 : 1
    } catch {
        emit(SelfTestResult(ok: false, tests: ["crop_before_ocr"]))
        return 1
    }
}

private func integerArgument(_ name: String, default defaultValue: Int) -> Int? {
    guard let index = CommandLine.arguments.firstIndex(of: name) else { return defaultValue }
    guard CommandLine.arguments.indices.contains(index + 1) else { return nil }
    return Int(CommandLine.arguments[index + 1])
}

private func stringArgument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name) else { return nil }
    guard CommandLine.arguments.indices.contains(index + 1) else { return nil }
    let value = CommandLine.arguments[index + 1]
    return value.isEmpty ? nil : value
}

private struct NavigationSpikeSuccess: Encodable {
    let ok = true
    let targetHeaderMatched = true
    let restore: SceneRestoreReport
}

@main
private struct WeChatVisibleReaderCLI {
    static func main() async {
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let command = CommandLine.arguments.dropFirst().first ?? ""
        let cancellation = NavigationCancellation()
        let terminationSource = ["--navigation-spike", "--read-conversation-recent"].contains(command)
            ? installNavigationTerminationHandler(cancellation)
            : nil
        defer { terminationSource?.cancel() }
        switch command {
        case "--self-test":
            exit(runReaderSelfTest())
        case "--navigation-self-test":
            let result = runNavigationSelfTest()
            emit(result)
            exit(result.ok ? 0 : 1)
        case "--probe":
            do {
                let target = try await ReaderEngine.locateTarget()
                emit(ProbeSuccess(
                    wechatVersion: target.version,
                    profileId: target.profile.id,
                    windowSize: WindowSize(
                        width: Int(target.window.frame.width),
                        height: Int(target.window.frame.height)
                    )
                ))
            } catch let error as ReaderError {
                emit(Failure(error))
            } catch {
                emit(Failure(.captureFailed))
            }
        case "--navigation-spike":
            guard let contact = stringArgument("--contact") else {
                emit(Failure(.navigationFailed))
                return
            }
            do {
                let restore = try await WeChatConversationNavigator.navigationSpike(
                    contact: contact,
                    cancellation: cancellation
                )
                emit(NavigationSpikeSuccess(restore: restore))
            } catch let error as ReaderError {
                emit(Failure(error))
            } catch {
                emit(Failure(.navigationFailed))
            }
        case "--read-conversation-recent":
            guard let contact = stringArgument("--contact"),
                  let limit = integerArgument("--limit", default: 30),
                  (1...30).contains(limit) else {
                emit(Failure(.navigationFailed))
                return
            }
            do {
                let outcome = try await WeChatConversationNavigator.readRecent(
                    contact: contact,
                    limit: limit,
                    cancellation: cancellation
                )
                emit(NavigationReadSuccess(outcome))
            } catch let error as NavigationOperationError {
                emit(NavigationFailure(error))
            } catch let error as ReaderError {
                emit(Failure(error))
            } catch {
                emit(Failure(.navigationFailed))
            }
        case "--read":
            guard let maxBlocks = integerArgument("--max-blocks", default: 80),
                  let maxChars = integerArgument("--max-chars", default: 8_000),
                  (1...200).contains(maxBlocks),
                  (1...20_000).contains(maxChars) else {
                emit(Failure(.captureFailed))
                return
            }
            do {
                emit(try await ReaderEngine.read(maxBlocks: maxBlocks, maxChars: maxChars))
            } catch let error as ReaderError {
                emit(Failure(error))
            } catch {
                emit(Failure(.captureFailed))
            }
        default:
            emit(Failure(.captureFailed))
        }
    }
}
