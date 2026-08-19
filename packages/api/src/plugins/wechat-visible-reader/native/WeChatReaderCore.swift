import AppKit
import CryptoKit
import Foundation
import ScreenCaptureKit
import Vision

enum ReaderEngine {
    static func locateTarget() async throws -> TargetWindow {
        guard CGPreflightScreenCaptureAccess() else { throw ReaderError.permissionDenied }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw CGPreflightScreenCaptureAccess() ? ReaderError.captureFailed : ReaderError.permissionDenied
        }
        guard let app = content.applications.first(where: { $0.bundleIdentifier == weChatBundleId }) else {
            throw ReaderError.wechatNotRunning
        }
        let candidates = content.windows
            .filter {
                $0.owningApplication?.processID == app.processID && $0.windowLayer == 0
                    && $0.frame.width >= 700 && $0.frame.height >= 500
            }
        let selection = TargetWindowSelector.select(candidates.map {
            WindowCandidateGeometry(isOnScreen: $0.isOnScreen, width: $0.frame.width, height: $0.frame.height)
        })
        let window: SCWindow
        switch selection {
        case .none:
            throw ReaderError.noActiveConversation
        case .ambiguous:
            throw ReaderError.layoutNotRecognized
        case let .selected(index):
            window = candidates[index]
        }
        let running = NSRunningApplication(processIdentifier: app.processID)
        let version = running?.bundleURL.flatMap { Bundle(url: $0) }?
            .object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        guard let profile = LayoutProfile.resolve(version: version) else { throw ReaderError.layoutNotRecognized }
        guard profile.recognizes(window: window.frame) else { throw ReaderError.layoutNotRecognized }
        return TargetWindow(window: window, version: version, profile: profile)
    }

    static func capture(_ target: TargetWindow) async throws -> CGImage {
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(target.window.frame.width.rounded()))
        configuration.height = max(1, Int(target.window.frame.height.rounded()))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        let filter = SCContentFilter(desktopIndependentWindow: target.window)
        do {
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            throw CGPreflightScreenCaptureAccess() ? ReaderError.captureFailed : ReaderError.permissionDenied
        }
    }

    static func crop(_ image: CGImage, to region: NormalizedRect) throws -> CGImage {
        let width = Double(image.width)
        let height = Double(image.height)
        let rect = CGRect(
            x: region.x * width,
            y: region.y * height,
            width: region.width * width,
            height: region.height * height
        ).integral
        guard rect.minX >= 0, rect.minY >= 0, rect.maxX <= width, rect.maxY <= height,
              let cropped = image.cropping(to: rect) else {
            throw ReaderError.layoutNotRecognized
        }
        return cropped
    }

    static func recognize(_ image: CGImage) throws -> [VNRecognizedTextObservation] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.012
        do {
            try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        } catch {
            throw ReaderError.captureFailed
        }
        return (request.results ?? []).sorted {
            if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01 {
                return $0.boundingBox.midY > $1.boundingBox.midY
            }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
    }

    static func recognizeRegion(
        _ image: CGImage,
        region: NormalizedRect
    ) throws -> [RecognizedRegionText] {
        let cropped = try crop(image, to: region)
        return try recognize(cropped).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return RecognizedRegionText(
                text: text,
                bbox: mapToWindow(observation.boundingBox, body: region),
                confidence: Double(candidate.confidence)
            )
        }
    }

    static func read(maxBlocks: Int, maxChars: Int) async throws -> ReadSuccess {
        try await readPage(target: locateTarget(), maxBlocks: maxBlocks, maxChars: maxChars)
    }

    static func readPage(target: TargetWindow, maxBlocks: Int, maxChars: Int) async throws -> ReadSuccess {
        let image = try await capture(target)
        guard PixelLayoutGuard.matches(image) else { throw ReaderError.layoutNotRecognized }
        let cropped = try crop(image, to: target.profile.bodyRegion)
        let observations = try recognize(cropped)
        let candidates = observations.compactMap { observation -> (VNRecognizedTextObservation, VNRecognizedText)? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            return (observation, candidate)
        }
        guard !candidates.isEmpty else { throw ReaderError.noActiveConversation }
        guard passesPageConfidence(candidates.map { $0.1.confidence }) else { throw ReaderError.ocrLowConfidence }
        let viable = candidates.filter { $0.1.confidence >= 0.35 }
        var units: [MessageUnit] = []
        var charCount = 0
        var truncated = false
        var warnings = Set(["visible_page_only", "ocr_only_non_text_may_be_omitted"])
        if viable.count < candidates.count { warnings.insert("low_confidence_text_omitted") }
        for (observation, candidate) in viable {
            if units.count >= maxBlocks { truncated = true; break }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let local = observation.boundingBox
            let bbox = mapToWindow(local, body: target.profile.bodyRegion)
            let partial = isPartial(local)
            let sender = inferSender(bbox)
            if sender == "unknown" { warnings.insert("sender_attribution_uncertain") }
            let indicator = partial ? "partial_text_omitted" : knownNonTextIndicator(text)
            let blockType = indicator == nil || partial ? "text" : "non_textual"
            let returnedText = blockType == "text" && !partial ? text : nil
            let textChars = returnedText?.unicodeScalars.count ?? 0
            if charCount + textChars > maxChars { truncated = true; break }
            if blockType == "non_textual" { warnings.insert("non_text_content_present") }
            charCount += textChars
            units.append(MessageUnit(
                blockType: blockType,
                isPartial: partial,
                text: returnedText,
                indicator: indicator,
                bbox: bbox,
                ocrConfidence: Double(candidate.confidence),
                layoutConfidence: target.profile.confidence,
                presumedSender: sender,
                blockHash: makeHash(text: returnedText ?? indicator ?? "omitted", bbox: bbox)
            ))
        }
        return ReadSuccess(
            captureId: UUID().uuidString.lowercased(),
            capturedAt: ISO8601DateFormatter.fractional.string(from: Date()),
            source: Source(
                bundleId: weChatBundleId,
                wechatVersion: target.version,
                windowSize: WindowSize(width: image.width, height: image.height)
            ),
            layout: LayoutInfo(
                profileId: target.profile.id,
                confidence: target.profile.confidence,
                bodyRegion: target.profile.bodyRegion
            ),
            messageUnits: units,
            totalChars: charCount,
            truncated: truncated,
            warnings: warnings.sorted()
        )
    }

    static func isPartial(_ rect: CGRect) -> Bool {
        rect.minY <= 0.015 || rect.maxY >= 0.985
    }

    static func passesPageConfidence(_ confidences: [Float]) -> Bool {
        guard !confidences.isEmpty else { return false }
        if confidences.count == 1 { return confidences[0] >= 0.55 }
        let mean = confidences.reduce(0.0, +) / Float(confidences.count)
        let readableCount = confidences.filter { $0 >= 0.35 }.count
        let readableRatio = Float(readableCount) / Float(confidences.count)
        return mean >= 0.45 && readableCount >= 2 && readableRatio >= 0.50
    }

    static func mapToWindow(_ rect: CGRect, body: NormalizedRect) -> NormalizedRect {
        NormalizedRect(
            x: body.x + Double(rect.minX) * body.width,
            y: body.y + (1 - Double(rect.maxY)) * body.height,
            width: Double(rect.width) * body.width,
            height: Double(rect.height) * body.height
        )
    }

    static func inferSender(_ rect: NormalizedRect) -> String {
        let midpoint = rect.x + rect.width / 2
        if midpoint < 0.58 { return "other" }
        if midpoint > 0.72 { return "self" }
        return "unknown"
    }

    static func knownNonTextIndicator(_ text: String) -> String? {
        switch text.replacingOccurrences(of: " ", with: "") {
        case "[图片]", "【图片】": return "image_placeholder"
        case "[语音]", "【语音】": return "voice_placeholder"
        case "[红包]", "微信红包": return "red_packet"
        case "[引用]", "【引用】": return "quote_placeholder"
        default: return nil
        }
    }

    static func makeHash(text: String, bbox: NormalizedRect) -> String {
        let input = "\(text)|\(bbox.x)|\(bbox.y)|\(bbox.width)|\(bbox.height)"
        return SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
