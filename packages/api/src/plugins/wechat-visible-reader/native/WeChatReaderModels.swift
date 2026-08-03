import Foundation
import ScreenCaptureKit

let weChatBundleId = "com.tencent.xinWeChat"

struct NormalizedRect: Encodable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    func contains(_ point: CGPoint) -> Bool {
        point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height
    }
}

struct LayoutProfile {
    let id: String
    let bodyRegion: NormalizedRect
    let searchFieldRegion: NormalizedRect
    let searchResultsRegion: NormalizedRect
    let headerRegion: NormalizedRect
    let confidence: Double

    func recognizes(window: CGRect) -> Bool {
        let ratio = window.width / window.height
        return window.width >= 900 && window.height >= 600 && ratio >= 1.30 && ratio <= 1.80
    }

    static func resolve(version: String) -> LayoutProfile? {
        guard version == "4.1.11" else { return nil }
        return LayoutProfile(
            id: "wechat-4.1.11-main",
            bodyRegion: NormalizedRect(x: 0.39, y: 0.10, width: 0.59, height: 0.63),
            searchFieldRegion: NormalizedRect(x: 0.02, y: 0.02, width: 0.33, height: 0.08),
            searchResultsRegion: NormalizedRect(x: 0.01, y: 0.10, width: 0.36, height: 0.62),
            headerRegion: NormalizedRect(x: 0.39, y: 0.01, width: 0.59, height: 0.09),
            confidence: 0.96
        )
    }
}

enum ReaderError: String, Error {
    case permissionDenied = "permission_denied"
    case wechatNotRunning = "wechat_not_running"
    case noActiveConversation = "no_active_conversation"
    case layoutNotRecognized = "layout_not_recognized"
    case ocrLowConfidence = "ocr_low_confidence"
    case captureFailed = "capture_failed"
    case sessionLocked = "session_locked"
    case searchLayoutNotRecognized = "search_layout_not_recognized"
    case contactNotFound = "contact_not_found"
    case contactAmbiguous = "contact_ambiguous"
    case headerMismatch = "header_mismatch"
    case restoreFailed = "restore_failed"
    case navigationFailed = "navigation_failed"

    var userAction: String {
        switch self {
        case .permissionDenied: return "请在系统设置中允许 Cat Café 录制屏幕后重试。"
        case .wechatNotRunning: return "请先启动微信。"
        case .noActiveConversation: return "请在微信中打开一个会话并保持主窗口可见。"
        case .layoutNotRecognized: return "当前微信窗口布局无法安全识别，请调整为标准主窗口后重试。"
        case .ocrLowConfidence: return "当前页面文字识别置信度过低，请让目标消息完整显示后重试。"
        case .captureFailed: return "微信读取失败，请稍后重试。"
        case .sessionLocked: return "请先解锁当前 Mac 会话。"
        case .searchLayoutNotRecognized: return "微信搜索区域未能安全识别，未执行输入。"
        case .contactNotFound: return "没有找到名称完全一致的联系人。"
        case .contactAmbiguous: return "找到多个同名联系人，未执行选择。"
        case .headerMismatch: return "打开后的会话标题与目标不一致，已停止读取。"
        case .restoreFailed: return "读取后未能完整恢复原微信现场，请手动检查当前窗口。"
        case .navigationFailed: return "微信导航未能安全完成，未继续读取。"
        }
    }
}

struct Failure: Encodable {
    struct Detail: Encodable { let code: String; let userAction: String }
    let ok = false
    let error: Detail
    init(_ error: ReaderError) { self.error = Detail(code: error.rawValue, userAction: error.userAction) }
}

struct WindowSize: Encodable { let width: Int; let height: Int }
struct Source: Encodable { let bundleId: String; let wechatVersion: String; let windowSize: WindowSize }
struct LayoutInfo: Encodable { let profileId: String; let confidence: Double; let bodyRegion: NormalizedRect }

struct MessageUnit: Encodable {
    let blockType: String
    let isPartial: Bool
    let text: String?
    let indicator: String?
    let bbox: NormalizedRect
    let ocrConfidence: Double
    let layoutConfidence: Double
    let presumedSender: String
    let blockHash: String

    var overlapContentKey: String {
        "\(blockType)|\(isPartial)|\(text ?? indicator ?? "omitted")|\(presumedSender)"
    }

    private enum CodingKeys: String, CodingKey {
        case blockType, isPartial, text, indicator, bbox, ocrConfidence, layoutConfidence, presumedSender, blockHash
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(blockType, forKey: .blockType)
        try container.encode(isPartial, forKey: .isPartial)
        if blockType == "text" {
            if isPartial { try container.encodeNil(forKey: .text) }
            else { try container.encode(text, forKey: .text) }
        }
        try container.encodeIfPresent(indicator, forKey: .indicator)
        try container.encode(bbox, forKey: .bbox)
        try container.encode(ocrConfidence, forKey: .ocrConfidence)
        try container.encode(layoutConfidence, forKey: .layoutConfidence)
        try container.encode(presumedSender, forKey: .presumedSender)
        try container.encode(blockHash, forKey: .blockHash)
    }
}

struct ReadSuccess: Encodable {
    let ok = true
    let captureId: String
    let capturedAt: String
    let source: Source
    let layout: LayoutInfo
    let messageUnits: [MessageUnit]
    let totalChars: Int
    let truncated: Bool
    let warnings: [String]
}

struct ProbeSuccess: Encodable {
    let ok = true
    let wechatVersion: String
    let profileId: String
    let windowSize: WindowSize
}

struct SelfTestResult: Encodable { let ok: Bool; let tests: [String] }

struct WindowCandidateGeometry {
    let isOnScreen: Bool
    let width: CGFloat
    let height: CGFloat

    var area: CGFloat { width * height }
}

enum TargetWindowSelection: Equatable {
    case none
    case ambiguous
    case selected(index: Int)
}

enum TargetWindowSelector {
    static func select(_ candidates: [WindowCandidateGeometry]) -> TargetWindowSelection {
        let visible = candidates.enumerated()
            .filter { $0.element.isOnScreen }
            .sorted { $0.element.area > $1.element.area }
        guard let primary = visible.first else { return .none }
        if visible.count > 1, visible[1].element.area >= primary.element.area * 0.7 {
            return .ambiguous
        }
        return .selected(index: primary.offset)
    }
}

struct TargetWindow { let window: SCWindow; let version: String; let profile: LayoutProfile }
struct RecognizedRegionText { let text: String; let bbox: NormalizedRect; let confidence: Double }

extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
