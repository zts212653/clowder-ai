import AppKit

protocol WorkspaceApplicationIdentity {
    var bundleIdentifier: String? { get }
    var localizedName: String? { get }
}
extension NSRunningApplication: WorkspaceApplicationIdentity {}

func projectApplication(_ application: WorkspaceApplicationIdentity) -> [String: String]? {
    guard let bundleId = application.bundleIdentifier,
          (1...255).contains(bundleId.utf8.count),
          bundleId.unicodeScalars.allSatisfy({
              (65...90).contains($0.value) || (97...122).contains($0.value) ||
              (48...57).contains($0.value) || $0 == "." || $0 == "-"
          }), let name = application.localizedName,
          !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          name.unicodeScalars.count <= 128,
          !name.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0.properties.generalCategory == .format })
    else { return nil }
    return ["bundleId": bundleId, "name": name]
}
