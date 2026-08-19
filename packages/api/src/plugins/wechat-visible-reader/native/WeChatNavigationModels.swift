import AppKit
import Foundation

enum NavigationAction: String {
    case openSearch
    case typeContact
    case selectExactResult
    case scrollChatBody
    case restoreScene
}

struct MainLayoutToken {
    let processId: pid_t
    let windowFrame: CGRect
    let profile: LayoutProfile
}

struct SearchLayoutToken {
    let processId: pid_t
    let windowFrame: CGRect
    let fieldRegion: NormalizedRect
    let resultsRegion: NormalizedRect
}

struct ConversationLayoutToken {
    let processId: pid_t
    let windowFrame: CGRect
    let bodyRegion: NormalizedRect
}

struct ExactSearchResult {
    let contact: String
    let bbox: NormalizedRect
}

struct SceneSnapshot {
    let frontApplicationProcessId: pid_t?
    let originalConversationHeader: String
    let originalBlockAnchors: Set<String>
    let target: TargetWindow
}

struct SceneRestoreReport: Encodable {
    let conversationRestored: Bool
    let scrollAnchorRestored: Bool
    let frontApplicationRestored: Bool
    var complete: Bool { conversationRestored && scrollAnchorRestored && frontApplicationRestored }
}

struct NavigationReadOutcome {
    let read: ReadSuccess
    let targetHeader: String
    let restore: SceneRestoreReport
}

struct NavigationOperationError: Error {
    let readerError: ReaderError
    let restore: SceneRestoreReport
}

final class NavigationCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func check() throws {
        lock.lock()
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { throw ReaderError.navigationFailed }
    }
}

struct NavigationReadSuccess: Encodable {
    let ok = true
    let targetHeader: String
    let targetHeaderMatched = true
    let restore: SceneRestoreReport
    let captureId: String
    let capturedAt: String
    let source: Source
    let layout: LayoutInfo
    let messageUnits: [MessageUnit]
    let totalChars: Int
    let truncated: Bool
    let warnings: [String]

    init(_ outcome: NavigationReadOutcome) {
        targetHeader = outcome.targetHeader
        restore = outcome.restore
        captureId = outcome.read.captureId
        capturedAt = outcome.read.capturedAt
        source = outcome.read.source
        layout = outcome.read.layout
        messageUnits = outcome.read.messageUnits
        totalChars = outcome.read.totalChars
        truncated = outcome.read.truncated
        warnings = outcome.read.warnings
    }
}

struct NavigationFailure: Encodable {
    struct Detail: Encodable { let code: String; let userAction: String }
    let ok = false
    let error: Detail
    let restore: SceneRestoreReport

    init(_ error: NavigationOperationError) {
        self.error = Detail(code: error.readerError.rawValue, userAction: error.readerError.userAction)
        restore = error.restore
    }
}

enum SearchResultResolver {
    static func normalized(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    static func uniqueExact(contact: String, candidates: [RecognizedRegionText]) throws -> ExactSearchResult {
        let expected = normalized(contact)
        let matches = candidates.filter { normalized($0.text) == expected && $0.confidence >= 0.55 }
        if matches.isEmpty { throw ReaderError.contactNotFound }
        if matches.count > 1 { throw ReaderError.contactAmbiguous }
        return ExactSearchResult(contact: expected, bbox: matches[0].bbox)
    }

    static func headerMatches(contact: String, candidates: [RecognizedRegionText]) -> Bool {
        let expected = normalized(contact)
        return candidates.filter { $0.confidence >= 0.55 }.contains { normalized($0.text) == expected }
    }
}

enum MessagePageStitcher {
    private static let geometryTolerance = 0.025
    private static let minimumScrollTranslation = 0.025

    static func prependOlder(_ older: [MessageUnit], to newer: [MessageUnit]) -> [MessageUnit] {
        let overlap = longestReliableOverlap(older, newer)
        return Array(older.dropLast(overlap)) + newer
    }

    static func stitchNewestFirst(_ pages: [[MessageUnit]], limit: Int) -> [MessageUnit] {
        guard var combined = pages.first else { return [] }
        for older in pages.dropFirst() { combined = prependOlder(older, to: combined) }
        return Array(combined.suffix(limit))
    }

    static func longestReliableOverlap(_ older: [MessageUnit], _ newer: [MessageUnit]) -> Int {
        let maximum = min(older.count, newer.count)
        guard maximum >= 2 else { return 0 }
        for length in stride(from: maximum, through: 2, by: -1) {
            if isReliableOverlap(Array(older.suffix(length)), Array(newer.prefix(length))) { return length }
        }
        return 0
    }

    private static func isReliableOverlap(_ older: [MessageUnit], _ newer: [MessageUnit]) -> Bool {
        guard older.count == newer.count,
              older.allSatisfy({ !$0.isPartial }),
              newer.allSatisfy({ !$0.isPartial }) else { return false }

        let pairs = Array(zip(older, newer))
        // Exact hashes cover a repeated capture that did not move. Otherwise text is never
        // sufficient: every unit must also follow one rigid vertical scroll translation.
        if pairs.allSatisfy({ $0.blockHash == $1.blockHash }) { return true }
        guard pairs.allSatisfy({ $0.overlapContentKey == $1.overlapContentKey }) else { return false }

        let translations = pairs.map { $1.bbox.y - $0.bbox.y }
        guard let firstTranslation = translations.first,
              abs(firstTranslation) >= minimumScrollTranslation,
              translations.allSatisfy({ abs($0 - firstTranslation) <= geometryTolerance }) else { return false }

        return pairs.allSatisfy { olderUnit, newerUnit in
            abs(olderUnit.bbox.x - newerUnit.bbox.x) <= geometryTolerance
                && abs(olderUnit.bbox.width - newerUnit.bbox.width) <= geometryTolerance
                && abs(olderUnit.bbox.height - newerUnit.bbox.height) <= geometryTolerance
        }
    }
}
