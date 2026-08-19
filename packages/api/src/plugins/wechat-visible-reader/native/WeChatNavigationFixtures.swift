import Foundation

private enum NavigationFixtureHarness {
    static func searchPlan(searchReady: Bool, candidates: [String], expectedHeader: String?) -> [NavigationAction] {
        var actions: [NavigationAction] = [.openSearch]
        guard searchReady else { return actions }
        actions.append(.typeContact)
        guard candidates.count == 1 else { return actions }
        actions.append(.selectExactResult)
        guard expectedHeader == candidates[0] else { return actions }
        actions.append(.restoreScene)
        return actions
    }

    static func message(_ body: String, y: Double, x: Double = 0.46) -> MessageUnit {
        let bbox = NormalizedRect(x: x, y: y, width: 0.18, height: 0.05)
        return MessageUnit(
            blockType: "text",
            isPartial: false,
            text: body,
            indicator: nil,
            bbox: bbox,
            ocrConfidence: 0.99,
            layoutConfidence: 0.96,
            presumedSender: "other",
            blockHash: ReaderEngine.makeHash(text: body, bbox: bbox)
        )
    }

    static func page(_ bodies: [String], ys: [Double]? = nil) -> [MessageUnit] {
        let positions = ys ?? bodies.indices.map { 0.10 + Double($0) * 0.10 }
        return zip(bodies, positions).map { message($0.0, y: $0.1) }
    }

    static func stitch(_ pages: [[MessageUnit]], limit: Int) -> [MessageUnit] {
        MessagePageStitcher.stitchNewestFirst(pages, limit: limit)
    }

    static func restoreAttemptsAfterFailure() -> [NavigationAction] {
        [.restoreScene, .scrollChatBody, .restoreScene]
    }
}

func runNavigationSelfTest() -> SelfTestResult {
    let noInput = NavigationFixtureHarness.searchPlan(
        searchReady: false,
        candidates: ["Target"],
        expectedHeader: "Target"
    ) == [.openSearch]
    let unique = NavigationFixtureHarness.searchPlan(
        searchReady: true,
        candidates: ["Target"],
        expectedHeader: "Target"
    ).contains(.selectExactResult)
    let ambiguous = !NavigationFixtureHarness.searchPlan(
        searchReady: true,
        candidates: ["Target", "Target"],
        expectedHeader: "Target"
    ).contains(.selectExactResult)
    let mismatch = !NavigationFixtureHarness.searchPlan(
        searchReady: true,
        candidates: ["Target"],
        expectedHeader: "Different"
    ).contains(.restoreScene)

    let stitched = NavigationFixtureHarness.stitch([
        NavigationFixtureHarness.page(["5", "6", "7", "8"]),
        NavigationFixtureHarness.page(["3", "4", "5", "6"]),
        NavigationFixtureHarness.page(["1", "2", "3", "4"]),
    ], limit: 8).compactMap(\.text)
    let ordered = stitched == ["1", "2", "3", "4", "5", "6", "7", "8"]

    let duplicateBodies = NavigationFixtureHarness.stitch([
        NavigationFixtureHarness.page(["same", "same", "new"]),
        NavigationFixtureHarness.page(["old", "same", "same"]),
    ], limit: 5).compactMap(\.text)
    let duplicatesPreserved = duplicateBodies == ["old", "same", "same", "new"]

    let unrelatedRepeatedSequence = NavigationFixtureHarness.stitch([
        NavigationFixtureHarness.page(["ok", "ok", "bye"], ys: [0.10, 0.20, 0.30]),
        NavigationFixtureHarness.page(["ok", "ok", "bye"], ys: [0.10, 0.27, 0.50]),
    ], limit: 6).compactMap(\.text)
    let unrelatedRepeatedSequencePreserved = unrelatedRepeatedSequence == ["ok", "ok", "bye", "ok", "ok", "bye"]
    let restoreAll = NavigationFixtureHarness.restoreAttemptsAfterFailure()
        == [.restoreScene, .scrollChatBody, .restoreScene]
    let cancellation = NavigationCancellation()
    cancellation.cancel()
    let cancellationObserved: Bool
    do {
        try cancellation.check()
        cancellationObserved = false
    } catch {
        cancellationObserved = true
    }

    let layoutVariants = [
        syntheticReaderImage(scale: 1, backgroundGray: 1, markerGray: 0.82),
        syntheticReaderImage(scale: 2, backgroundGray: 1, markerGray: 0.82),
        syntheticReaderImage(scale: 1, backgroundGray: 0.12, markerGray: 0.30),
        syntheticReaderImage(scale: 1, backgroundGray: 0.72, markerGray: 0.50),
        syntheticReaderImage(scale: 1, backgroundGray: 1, markerGray: 0.82, sidebarFraction: 0.26),
    ]
    let layoutGuard = layoutVariants.allSatisfy { image in image.map(PixelLayoutGuard.matches) == true }
    let visibleWindowSelected = TargetWindowSelector.select([
        WindowCandidateGeometry(isOnScreen: false, width: 1_496, height: 883),
        WindowCandidateGeometry(isOnScreen: false, width: 1_065, height: 882),
        WindowCandidateGeometry(isOnScreen: true, width: 1_496, height: 883),
    ]) == .selected(index: 2)

    return SelfTestResult(
        ok: noInput && unique && ambiguous && mismatch && ordered && duplicatesPreserved
            && unrelatedRepeatedSequencePreserved && restoreAll && cancellationObserved && layoutGuard
            && visibleWindowSelected,
        tests: [
            "search_not_ready_no_input",
            "unique_exact_result_only",
            "ambiguous_exact_result_refused",
            "header_mismatch_refused",
            "three_page_overlap_ordered",
            "duplicate_body_preserved",
            "unrelated_repeated_sequence_not_false_overlap",
            "failure_restores_all_scene_parts",
            "cooperative_termination_cancellation",
            "dpr_light_dark_relative_layout_guard",
            "offscreen_stale_windows_ignored",
        ]
    )
}
