import AppKit
import CoreText
import Foundation
import Vision

private let dialogueUnits = [
    "今天需要确认项目进度和下一步安排",
    "请帮我检查这份合同里的关键风险",
    "明天下午三点一起讨论新的设计方案",
    "客户已经回复请尽快整理重点内容",
    "这周的会议纪要需要补充负责人和日期",
    "我刚收到消息稍后把详细资料发给你",
    "麻烦确认订单数量地址以及联系电话",
    "如果时间有变化请第一时间告诉大家",
    "这个问题已经解决不需要继续跟进",
    "请把最终版本发到群里方便大家查看",
    "周末出发前记得检查证件和充电设备",
    "谢谢你的提醒我会按计划完成这件事",
]
private let repetitions = 10
private let threshold = 0.90
private let targetWidth = 1158
private let targetHeight = 769

private struct FixtureRect: Encodable {
    let x: Double; let y: Double; let width: Double; let height: Double
}
private struct FixtureSize: Encodable { let width: Int; let height: Int }
private let bodyRegion = FixtureRect(x: 0.39, y: 0.10, width: 0.59, height: 0.63)

private struct AccuracyResult: Encodable {
    let ok: Bool
    let unitCount: Int
    let observedUnitCount: Int
    let expectedChars: Int
    let observedChars: Int
    let editDistance: Int
    let accuracy: Double
    let threshold: Double
    let windowSize: FixtureSize
    let bodyRegion: FixtureRect
    let sidebarCanaryExcluded: Bool
    let headerInputCanariesExcluded: Bool
}

private func makePage(lines: [String]) -> CGImage? {
    guard let context = CGContext(
        data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
    context.setFillColor(CGColor(gray: 0.82, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 428, height: targetHeight))
    context.fill(CGRect(x: 428, y: 0, width: targetWidth - 428, height: 190))
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    let font = NSFont(name: "PingFangSC-Regular", size: 30) ?? NSFont.systemFont(ofSize: 30)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
    for (index, line) in lines.enumerated() {
        context.textPosition = CGPoint(x: 480, y: 570 - index * 66)
        let attributed = NSAttributedString(string: line, attributes: attributes)
        CTLineDraw(CTLineCreateWithAttributedString(attributed), context)
    }
    for (text, point) in [
        ("SIDEBAR_CANARY", CGPoint(x: 20, y: 400)),
        ("HEADER_CANARY", CGPoint(x: 480, y: 720)),
        ("INPUT_CANARY", CGPoint(x: 480, y: 25)),
    ] {
        context.textPosition = point
        CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes)), context)
    }
    return context.makeImage()
}

private func crop(_ image: CGImage) -> CGImage? {
    let width = Double(image.width)
    let height = Double(image.height)
    let rect = CGRect(
        x: bodyRegion.x * width,
        y: bodyRegion.y * height,
        width: bodyRegion.width * width,
        height: bodyRegion.height * height
    ).integral
    return image.cropping(to: rect)
}

private func recognize(_ image: CGImage) throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    request.usesLanguageCorrection = true
    request.minimumTextHeight = 0.012
    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
    return (request.results ?? [])
        .sorted {
            if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01 {
                return $0.boundingBox.midY > $1.boundingBox.midY
            }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        .compactMap { $0.topCandidates(1).first?.string }
}

private func normalizedHan(_ value: String) -> String {
    String(value.unicodeScalars.filter { scalar in
        (0x3400...0x4DBF).contains(scalar.value) || (0x4E00...0x9FFF).contains(scalar.value)
    })
}

private func editDistance(_ lhs: String, _ rhs: String) -> Int {
    let left = Array(lhs)
    let right = Array(rhs)
    if left.isEmpty { return right.count }
    if right.isEmpty { return left.count }
    var previous = Array(0...right.count)
    for (leftIndex, leftCharacter) in left.enumerated() {
        var current = Array(repeating: 0, count: right.count + 1)
        current[0] = leftIndex + 1
        for (rightIndex, rightCharacter) in right.enumerated() {
            let substitution = previous[rightIndex] + (leftCharacter == rightCharacter ? 0 : 1)
            current[rightIndex + 1] = min(previous[rightIndex + 1] + 1, current[rightIndex] + 1, substitution)
        }
        previous = current
    }
    return previous[right.count]
}

private func emit(_ result: AccuracyResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(result) else { exit(1) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

do {
    let pages = [Array(dialogueUnits[0..<6]), Array(dialogueUnits[6..<12])]
    var expected = ""
    var observed = ""
    var observedUnitCount = 0
    var sidebarCanaryExcluded = true
    var headerInputCanariesExcluded = true
    for _ in 0..<repetitions {
        for lines in pages {
            guard let image = makePage(lines: lines), let cropped = crop(image) else {
                throw CocoaError(.coderInvalidValue)
            }
            let pageUnits = try recognize(cropped)
            let raw = pageUnits.joined(separator: " ")
            sidebarCanaryExcluded = sidebarCanaryExcluded && !raw.contains("SIDEBAR_CANARY")
            headerInputCanariesExcluded = headerInputCanariesExcluded
                && !raw.contains("HEADER_CANARY") && !raw.contains("INPUT_CANARY")
            expected += normalizedHan(lines.joined())
            observedUnitCount += pageUnits.count
            observed += normalizedHan(raw)
        }
    }
    let distance = editDistance(expected, observed)
    let denominator = max(expected.count, observed.count, 1)
    let accuracy = max(0, 1 - Double(distance) / Double(denominator))
    let unitCount = dialogueUnits.count * repetitions
    let passed = unitCount >= 100 && accuracy >= threshold && sidebarCanaryExcluded && headerInputCanariesExcluded
    emit(AccuracyResult(
        ok: passed, unitCount: unitCount,
        observedUnitCount: observedUnitCount,
        expectedChars: expected.count,
        observedChars: observed.count,
        editDistance: distance,
        accuracy: accuracy,
        threshold: threshold,
        windowSize: FixtureSize(width: targetWidth, height: targetHeight),
        bodyRegion: bodyRegion,
        sidebarCanaryExcluded: sidebarCanaryExcluded,
        headerInputCanariesExcluded: headerInputCanariesExcluded
    ))
    exit(passed ? 0 : 1)
} catch {
    emit(AccuracyResult(
        ok: false, unitCount: dialogueUnits.count * repetitions, observedUnitCount: 0,
        expectedChars: 0, observedChars: 0, editDistance: 0, accuracy: 0, threshold: threshold,
        windowSize: FixtureSize(width: targetWidth, height: targetHeight), bodyRegion: bodyRegion,
        sidebarCanaryExcluded: false, headerInputCanariesExcluded: false
    ))
    exit(1)
}
