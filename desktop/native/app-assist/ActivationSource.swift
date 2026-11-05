import AppKit

final class ActivationSource {
    private let center: NotificationCenter
    private var observer: NSObjectProtocol?
    init(center: NotificationCenter, emit: @escaping ([String: String]) -> Void) {
        self.center = center
        observer = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { event in
            guard let application = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? WorkspaceApplicationIdentity,
                  let projected = projectApplication(application) else { return }
            emit(projected)
        }
    }
    func close() {
        if let observer = observer { center.removeObserver(observer) }
        observer = nil
    }
    deinit { close() }
}
