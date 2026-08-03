import AppKit
import CoreGraphics
import Foundation

private enum NavigationEventEmitter {
    static func openSearch(token: MainLayoutToken) throws {
        guard token.profile.recognizes(window: token.windowFrame) else { throw ReaderError.layoutNotRecognized }
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 3, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 3, keyDown: false) else {
            throw ReaderError.navigationFailed
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.postToPid(token.processId)
        up.postToPid(token.processId)
    }

    static func typeContact(_ contact: String, token: SearchLayoutToken) throws {
        guard !contact.isEmpty, contact.unicodeScalars.count <= 128 else { throw ReaderError.navigationFailed }
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw ReaderError.navigationFailed
        }
        let characters = Array(contact.utf16)
        down.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
        up.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
        down.postToPid(token.processId)
        up.postToPid(token.processId)
    }

    static func clickExactResult(_ result: ExactSearchResult, token: SearchLayoutToken) throws {
        let midpoint = CGPoint(x: result.bbox.x + result.bbox.width / 2, y: result.bbox.y + result.bbox.height / 2)
        guard token.resultsRegion.contains(midpoint) else { throw ReaderError.layoutNotRecognized }
        let location = CGPoint(
            x: token.windowFrame.minX + midpoint.x * token.windowFrame.width,
            y: token.windowFrame.minY + midpoint.y * token.windowFrame.height
        )
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(
                  mouseEventSource: source,
                  mouseType: .leftMouseDown,
                  mouseCursorPosition: location,
                  mouseButton: .left
              ),
              let up = CGEvent(
                  mouseEventSource: source,
                  mouseType: .leftMouseUp,
                  mouseCursorPosition: location,
                  mouseButton: .left
              ) else {
            throw ReaderError.navigationFailed
        }
        down.postToPid(token.processId)
        up.postToPid(token.processId)
    }

    static func scrollChatBody(_ delta: Int32, token: ConversationLayoutToken) throws {
        guard delta != 0, abs(delta) <= 1_200 else { throw ReaderError.navigationFailed }
        let midpoint = CGPoint(
            x: token.bodyRegion.x + token.bodyRegion.width / 2,
            y: token.bodyRegion.y + token.bodyRegion.height / 2
        )
        guard token.bodyRegion.contains(midpoint),
              let source = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(
                  scrollWheelEvent2Source: source,
                  units: .pixel,
                  wheelCount: 1,
                  wheel1: delta,
                  wheel2: 0,
                  wheel3: 0
              ) else {
            throw ReaderError.navigationFailed
        }
        event.location = CGPoint(
            x: token.windowFrame.minX + midpoint.x * token.windowFrame.width,
            y: token.windowFrame.minY + midpoint.y * token.windowFrame.height
        )
        event.postToPid(token.processId)
    }
}

enum WeChatConversationNavigator {
    private static let navigationDelayNanoseconds: UInt64 = 300_000_000
    private static let maximumScrolls = 4
    private static let olderMessagesScrollDelta: Int32 = 720
    static func readRecent(
        contact: String,
        limit: Int,
        cancellation: NavigationCancellation = NavigationCancellation()
    ) async throws -> NavigationReadOutcome {
        guard (1...30).contains(limit) else { throw ReaderError.navigationFailed }
        guard sessionIsUnlocked() else { throw ReaderError.sessionLocked }
        let (target, snapshot) = try await prepareActiveScene(cancellation: cancellation)
        var readResult: ReadSuccess?
        var targetHeader = ""
        var primaryError: Error?

        do {
            targetHeader = try await navigate(to: contact, target: target, cancellation: cancellation)
            readResult = try await readBoundedPages(target: target, limit: limit, cancellation: cancellation)
        } catch {
            primaryError = error
        }

        let restore = await restoreScene(snapshot)
        if !restore.complete {
            throw NavigationOperationError(readerError: .restoreFailed, restore: restore)
        }
        if let primaryError {
            throw NavigationOperationError(
                readerError: primaryError as? ReaderError ?? .navigationFailed,
                restore: restore
            )
        }
        guard let readResult else { throw ReaderError.navigationFailed }
        return NavigationReadOutcome(read: readResult, targetHeader: targetHeader, restore: restore)
    }
    static func navigationSpike(
        contact: String,
        cancellation: NavigationCancellation = NavigationCancellation()
    ) async throws -> SceneRestoreReport {
        guard sessionIsUnlocked() else { throw ReaderError.sessionLocked }
        let (target, snapshot) = try await prepareActiveScene(cancellation: cancellation)
        var primaryError: Error?
        do {
            _ = try await navigate(to: contact, target: target, cancellation: cancellation)
        } catch {
            primaryError = error
        }
        let restore = await restoreScene(snapshot)
        guard restore.complete else { throw ReaderError.restoreFailed }
        if let primaryError { throw primaryError }
        return restore
    }

    private static func prepareActiveScene(
        cancellation: NavigationCancellation
    ) async throws -> (TargetWindow, SceneSnapshot) {
        try cancellation.check()
        let originalFrontApplicationProcessId = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let target = try await ReaderEngine.locateTarget()
        try cancellation.check()
        let snapshot = try await captureScene(
            target: target,
            originalFrontApplicationProcessId: originalFrontApplicationProcessId
        )
        do {
            try await activateWeChat(cancellation: cancellation)
        } catch {
            _ = restoreFrontApplication(originalFrontApplicationProcessId)
            throw error
        }
        return (target, snapshot)
    }

    private static func activateWeChat(cancellation: NavigationCancellation) async throws {
        try cancellation.check()
        guard let application = NSRunningApplication.runningApplications(withBundleIdentifier: weChatBundleId).first else {
            throw ReaderError.wechatNotRunning
        }
        try cancellation.check()
        guard application.activate(options: [.activateAllWindows]) else { throw ReaderError.navigationFailed }
        try await pause(cancellation: cancellation)
    }

    private static func captureScene(
        target: TargetWindow,
        originalFrontApplicationProcessId: pid_t?
    ) async throws -> SceneSnapshot {
        let image = try await ReaderEngine.capture(target)
        guard PixelLayoutGuard.matches(image) else { throw ReaderError.layoutNotRecognized }
        let headerCandidates = try ReaderEngine.recognizeRegion(image, region: target.profile.headerRegion)
            .filter { $0.confidence >= 0.55 }
        guard let originalHeader = headerCandidates.first?.text else { throw ReaderError.noActiveConversation }
        let page = try await ReaderEngine.readPage(target: target, maxBlocks: 80, maxChars: 8_000)
        return SceneSnapshot(
            frontApplicationProcessId: originalFrontApplicationProcessId,
            originalConversationHeader: SearchResultResolver.normalized(originalHeader),
            originalBlockAnchors: Set(page.messageUnits.map(\.blockHash)),
            target: target
        )
    }

    private static func navigate(
        to contact: String,
        target: TargetWindow,
        cancellation: NavigationCancellation? = nil
    ) async throws -> String {
        try check(cancellation)
        guard let processId = target.window.owningApplication?.processID,
              let running = NSRunningApplication(processIdentifier: processId) else {
            throw ReaderError.wechatNotRunning
        }
        try check(cancellation)
        running.activate(options: [.activateAllWindows])
        try await pause(cancellation: cancellation)

        let beforeSearch = try await ReaderEngine.capture(target)
        guard PixelLayoutGuard.matches(beforeSearch) else { throw ReaderError.layoutNotRecognized }
        let mainToken = MainLayoutToken(processId: processId, windowFrame: target.window.frame, profile: target.profile)
        try check(cancellation)
        try NavigationEventEmitter.openSearch(token: mainToken)
        try await pause(cancellation: cancellation)

        let focused = try await ReaderEngine.capture(target)
        guard PixelLayoutGuard.matches(focused),
              PixelLayoutGuard.searchFocusChanged(
                  before: beforeSearch,
                  after: focused,
                  region: target.profile.searchFieldRegion
              ) else {
            throw ReaderError.searchLayoutNotRecognized
        }
        let searchToken = SearchLayoutToken(
            processId: processId,
            windowFrame: target.window.frame,
            fieldRegion: target.profile.searchFieldRegion,
            resultsRegion: target.profile.searchResultsRegion
        )
        try check(cancellation)
        try NavigationEventEmitter.typeContact(contact, token: searchToken)
        try await pause(cancellation: cancellation)

        let resultsImage = try await ReaderEngine.capture(target)
        guard PixelLayoutGuard.matches(resultsImage) else { throw ReaderError.layoutNotRecognized }
        let candidates = try ReaderEngine.recognizeRegion(resultsImage, region: target.profile.searchResultsRegion)
        let exact = try SearchResultResolver.uniqueExact(contact: contact, candidates: candidates)
        try check(cancellation)
        try NavigationEventEmitter.clickExactResult(exact, token: searchToken)
        try await pause(cancellation: cancellation)

        let conversationImage = try await ReaderEngine.capture(target)
        guard PixelLayoutGuard.matches(conversationImage) else { throw ReaderError.layoutNotRecognized }
        let headerCandidates = try ReaderEngine.recognizeRegion(conversationImage, region: target.profile.headerRegion)
        guard SearchResultResolver.headerMatches(contact: contact, candidates: headerCandidates) else {
            throw ReaderError.headerMismatch
        }
        return SearchResultResolver.normalized(contact)
    }

    private static func readBoundedPages(
        target: TargetWindow,
        limit: Int,
        cancellation: NavigationCancellation
    ) async throws -> ReadSuccess {
        guard let processId = target.window.owningApplication?.processID else { throw ReaderError.wechatNotRunning }
        let token = ConversationLayoutToken(
            processId: processId,
            windowFrame: target.window.frame,
            bodyRegion: target.profile.bodyRegion
        )
        var pages: [[MessageUnit]] = []
        var firstPage: ReadSuccess?
        for index in 0...maximumScrolls {
            try cancellation.check()
            let page = try await ReaderEngine.readPage(target: target, maxBlocks: 120, maxChars: 12_000)
            try cancellation.check()
            if firstPage == nil { firstPage = page }
            pages.append(page.messageUnits)
            if MessagePageStitcher.stitchNewestFirst(pages, limit: limit).count >= limit { break }
            if index < maximumScrolls {
                try NavigationEventEmitter.scrollChatBody(olderMessagesScrollDelta, token: token)
                try await pause(cancellation: cancellation)
            }
        }
        guard let template = firstPage else { throw ReaderError.noActiveConversation }
        let units = MessagePageStitcher.stitchNewestFirst(pages, limit: limit)
        let totalChars = units.reduce(0) { total, unit in
            total + (unit.blockType == "text" && !unit.isPartial ? unit.text?.unicodeScalars.count ?? 0 : 0)
        }
        let hitScrollBudgetBeforeLimit = pages.count == maximumScrolls + 1 && units.count < limit
        return ReadSuccess(
            captureId: template.captureId,
            capturedAt: template.capturedAt,
            source: template.source,
            layout: template.layout,
            messageUnits: units,
            totalChars: totalChars,
            truncated: hitScrollBudgetBeforeLimit || template.truncated,
            warnings: Array(Set(template.warnings + ["named_conversation", "bounded_multi_page_ocr"])).sorted()
        )
    }

    static func restoreScene(_ snapshot: SceneSnapshot) async -> SceneRestoreReport {
        var conversationRestored = false
        var scrollAnchorRestored = false
        var frontApplicationRestored = snapshot.frontApplicationProcessId == nil

        do {
            _ = try await navigate(to: snapshot.originalConversationHeader, target: snapshot.target)
            conversationRestored = true
            scrollAnchorRestored = try await restoreAnchor(snapshot)
        } catch {
            conversationRestored = false
        }

        if let processId = snapshot.frontApplicationProcessId {
            frontApplicationRestored = restoreFrontApplication(processId)
        }

        return SceneRestoreReport(
            conversationRestored: conversationRestored,
            scrollAnchorRestored: scrollAnchorRestored,
            frontApplicationRestored: frontApplicationRestored
        )
    }

    private static func restoreAnchor(_ snapshot: SceneSnapshot) async throws -> Bool {
        guard let processId = snapshot.target.window.owningApplication?.processID else { return false }
        let token = ConversationLayoutToken(
            processId: processId,
            windowFrame: snapshot.target.window.frame,
            bodyRegion: snapshot.target.profile.bodyRegion
        )
        for attempt in 0...maximumScrolls {
            let page = try await ReaderEngine.readPage(target: snapshot.target, maxBlocks: 80, maxChars: 8_000)
            if !snapshot.originalBlockAnchors.isDisjoint(with: page.messageUnits.map(\.blockHash)) { return true }
            if attempt < maximumScrolls {
                try NavigationEventEmitter.scrollChatBody(olderMessagesScrollDelta, token: token)
                try await pause()
            }
        }
        return false
    }

    private static func sessionIsUnlocked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        let onConsole = session[kCGSessionOnConsoleKey as String] as? Bool ?? false
        let loginDone = session[kCGSessionLoginDoneKey as String] as? Bool ?? false
        return onConsole && loginDone
    }

    private static func restoreFrontApplication(_ processId: pid_t?) -> Bool {
        guard let processId else { return true }
        guard let application = NSRunningApplication(processIdentifier: processId) else { return false }
        return application.activate(options: [])
    }

    private static func check(_ cancellation: NavigationCancellation?) throws {
        if let cancellation { try cancellation.check() }
    }

    private static func pause(cancellation: NavigationCancellation? = nil) async throws {
        try await Task.sleep(nanoseconds: navigationDelayNanoseconds)
        try check(cancellation)
    }
}
