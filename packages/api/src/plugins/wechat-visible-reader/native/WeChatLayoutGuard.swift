import AppKit
import CoreText
import Foundation

enum PixelLayoutGuard {
    static func matches(_ image: CGImage) -> Bool {
        boundaryPasses(image, vertical: true, lower: 0.20, upper: 0.39)
            && boundaryPasses(image, vertical: false, lower: 0.70, upper: 0.80)
    }

    static func searchFocusChanged(before: CGImage, after: CGImage, region: NormalizedRect) -> Bool {
        let changed = regionDifference(before: before, after: after, region: region)
        let backgroundVariation = localVariation(after, region: region)
        return changed >= max(4, backgroundVariation * 1.8)
    }

    static func strongestMedianBoundaryDifference(
        _ image: CGImage,
        vertical: Bool,
        lower: Double,
        upper: Double
    ) -> Double {
        boundarySeries(image, vertical: vertical, lower: lower, upper: upper).max() ?? 0
    }

    static func backgroundVariation(
        _ image: CGImage,
        vertical: Bool,
        lower: Double,
        upper: Double
    ) -> Double {
        let values = boundarySeries(image, vertical: vertical, lower: lower, upper: upper).sorted()
        guard !values.isEmpty else { return 0 }
        return values[values.count / 2]
    }

    private static func boundaryPasses(_ image: CGImage, vertical: Bool, lower: Double, upper: Double) -> Bool {
        let boundary = strongestMedianBoundaryDifference(image, vertical: vertical, lower: lower, upper: upper)
        let backgroundVariation = backgroundVariation(image, vertical: vertical, lower: lower, upper: upper)
        return boundary >= max(8, backgroundVariation * 2.5)
    }

    private static func boundarySeries(
        _ image: CGImage,
        vertical: Bool,
        lower: Double,
        upper: Double
    ) -> [Double] {
        guard let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return [] }
        let pixelBytes = image.bitsPerPixel / 8
        guard pixelBytes >= 3 else { return [] }
        let major = vertical ? image.width : image.height
        let minor = vertical ? image.height : image.width
        var medians: [Double] = []
        for position in stride(from: Int(Double(major) * lower), to: Int(Double(major) * upper), by: 2) {
            guard position >= 2 && position < major else { continue }
            var samples: [Int] = []
            for cross in stride(from: Int(Double(minor) * 0.10), to: Int(Double(minor) * 0.90), by: 4) {
                let x = vertical ? position : cross
                let y = vertical ? cross : position
                let priorX = vertical ? position - 2 : cross
                let priorY = vertical ? cross : position - 2
                let offset = y * image.bytesPerRow + x * pixelBytes
                let prior = priorY * image.bytesPerRow + priorX * pixelBytes
                let difference = (0..<3).reduce(0) { $0 + abs(Int(bytes[offset + $1]) - Int(bytes[prior + $1])) }
                samples.append(difference / 3)
            }
            samples.sort()
            if !samples.isEmpty { medians.append(Double(samples[samples.count / 2])) }
        }
        return medians
    }

    private static func regionDifference(before: CGImage, after: CGImage, region: NormalizedRect) -> Double {
        guard before.width == after.width, before.height == after.height,
              let beforeCrop = try? ReaderEngine.crop(before, to: region),
              let afterCrop = try? ReaderEngine.crop(after, to: region),
              let beforeData = beforeCrop.dataProvider?.data,
              let afterData = afterCrop.dataProvider?.data,
              let beforeBytes = CFDataGetBytePtr(beforeData),
              let afterBytes = CFDataGetBytePtr(afterData) else { return 0 }
        let bytes = min(CFDataGetLength(beforeData), CFDataGetLength(afterData))
        guard bytes > 0 else { return 0 }
        let strideSize = max(4, bytes / 4_096)
        var total = 0
        var samples = 0
        for offset in stride(from: 0, to: bytes, by: strideSize) {
            total += abs(Int(beforeBytes[offset]) - Int(afterBytes[offset]))
            samples += 1
        }
        return samples == 0 ? 0 : Double(total) / Double(samples)
    }

    private static func localVariation(_ image: CGImage, region: NormalizedRect) -> Double {
        guard let crop = try? ReaderEngine.crop(image, to: region),
              let data = crop.dataProvider?.data,
              let bytes = CFDataGetBytePtr(data) else { return 0 }
        let length = CFDataGetLength(data)
        guard length > 4 else { return 0 }
        let strideSize = max(4, length / 2_048)
        var differences: [Int] = []
        for offset in stride(from: strideSize, to: length, by: strideSize) {
            differences.append(abs(Int(bytes[offset]) - Int(bytes[offset - strideSize])))
        }
        differences.sort()
        return differences.isEmpty ? 0 : Double(differences[differences.count / 2])
    }
}

func syntheticReaderImage(
    scale: Int = 1,
    backgroundGray: CGFloat = 1,
    markerGray: CGFloat = 0.82,
    sidebarFraction: CGFloat = 0.37,
    includeLayoutMarkers: Bool = true
) -> CGImage? {
    let width = 1_200 * scale
    let height = 800 * scale
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    context.setFillColor(CGColor(gray: backgroundGray, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    if includeLayoutMarkers {
        let sidebarWidth = CGFloat(width) * sidebarFraction
        context.setFillColor(CGColor(gray: markerGray, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: sidebarWidth, height: CGFloat(height)))
        context.fill(
            CGRect(x: sidebarWidth, y: 0, width: CGFloat(width) - sidebarWidth, height: CGFloat(200 * scale))
        )
    }
    let textColor: NSColor = backgroundGray > 0.5 ? .black : .white
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 42 * CGFloat(scale), weight: .semibold),
        .foregroundColor: textColor,
    ]
    for (text, point) in [
        ("SIDEBAR SECRET", CGPoint(x: 20 * scale, y: 430 * scale)),
        ("HEADER SECRET", CGPoint(x: 520 * scale, y: 750 * scale)),
        ("INPUT SECRET", CGPoint(x: 520 * scale, y: 50 * scale)),
        ("TARGET VISIBLE", CGPoint(x: 520 * scale, y: 430 * scale)),
    ] {
        context.textPosition = point
        CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes)), context)
    }
    return context.makeImage()
}
