import AppKit

struct FictionalApplication: WorkspaceApplicationIdentity {
    let bundleIdentifier: String?
    let localizedName: String?
}
@main
struct SyntheticActivationTest {
    static func main() {
        // Swift Character counts grapheme clusters; the public bound and JS
        // guard count Unicode scalars. A long decomposed name must be dropped.
        let overBound = String(repeating: "e\u{301}", count: 65)
        guard projectApplication(FictionalApplication(bundleIdentifier: "org.fixture.long", localizedName: overBound)) == nil else {
            print("synthetic-native-activation: rejected scalar-bound assertion")
            exit(1)
        }
        let atBound = String(repeating: "e\u{301}", count: 64)
        precondition(projectApplication(FictionalApplication(bundleIdentifier: "org.fixture.bound", localizedName: atBound)) != nil)
        let center = NotificationCenter() // Isolated events only; never NSWorkspace.shared.
        var rows: [[String: String]] = []
        let source = ActivationSource(center: center) { rows.append($0) }
        func activate(_ app: FictionalApplication) {
            center.post(name: NSWorkspace.didActivateApplicationNotification, object: nil,
                        userInfo: [NSWorkspace.applicationUserInfoKey: app, "title": "discarded fixture metadata"])
        }
        activate(FictionalApplication(bundleIdentifier: "org.fixture.editor", localizedName: "Fixture Editor"))
        activate(FictionalApplication(bundleIdentifier: nil, localizedName: "No identity"))
        activate(FictionalApplication(bundleIdentifier: "org.fixture.invalid/path", localizedName: "Invalid"))
        activate(FictionalApplication(bundleIdentifier: "org.fixture.control", localizedName: "Bad\nName"))
        precondition(rows == [["bundleId": "org.fixture.editor", "name": "Fixture Editor"]])
        source.close()
        activate(FictionalApplication(bundleIdentifier: "org.fixture.closed", localizedName: "Closed"))
        precondition(rows.count == 1)
        print("synthetic-native-activation: passed; observer removed; no workspace or foreground query")
    }
}
