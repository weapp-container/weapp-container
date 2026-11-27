import UIKit
import WeappContainer

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let host = VendorHost()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidEnterBackground(_ scene: UIScene) { host.setForeground(false) }
    func sceneDidBecomeActive(_ scene: UIScene) { host.setForeground(true) }
    func sceneDidDisconnect(_ scene: UIScene) {
        Task { try await host.close() }
    }
}

@MainActor final class VendorHost: UIViewController {
    private var session: WeappContainerSession?
    private var surface: WeappContainerView?
    private let content = UIView()
    private let status = UILabel()
    private var rejectProfile = false
    private var busy = false
    private var foreground = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.accessibilityIdentifier = "host-status"
        let rejection = UIButton(type: .system)
        rejection.setTitle("Reject profile", for: .normal)
        rejection.addAction(UIAction { [weak self, weak rejection] _ in
            guard let self else { return }
            rejectProfile.toggle()
            rejection?.setTitle(rejectProfile ? "Allow profile" : "Reject profile", for: .normal)
        }, for: .touchUpInside)
        let reopen = UIButton(type: .system)
        reopen.setTitle("Reopen", for: .normal)
        reopen.addAction(UIAction { [weak self] _ in self?.open() }, for: .touchUpInside)
        let buttons = UIStackView(arrangedSubviews: [reopen, rejection])
        buttons.distribution = .fillEqually
        let layout = UIStackView(arrangedSubviews: [buttons, status, content])
        layout.axis = .vertical
        layout.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(layout)
        NSLayoutConstraint.activate([
            layout.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            layout.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            layout.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            layout.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            buttons.heightAnchor.constraint(equalToConstant: 44),
        ])
        open()
    }

    private func open() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await close()
                status.text = "Loading"
                let next = WeappContainerSession(configuration: .init(storageKey: "vendor-demo"))
                try next.registerHostMethod("company.getProfile") { [weak self] _ in
                    guard let self else { throw WeappHostError(code: .cancelled, message: "Host closed") }
                    if self.rejectProfile {
                        self.status.text = "Profile rejected"
                        throw WeappHostError(code: .permissionDenied, message: "Profile access denied")
                    }
                    self.status.text = "Profile returned"
                    return .object(["displayName": .string("iOS host")])
                }
                let surface = try WeappContainerView(session: next)
                surface.accessibilityIdentifier = "mini-program"
                surface.isAccessibilityElement = true
                session = next
                self.surface = surface
                surface.frame = content.bounds
                surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                content.addSubview(surface)
                let pack = Bundle.main.resourceURL!.appendingPathComponent("portable-pack")
                try await next.load(packURL: pack)
                try next.setForeground(foreground)
                if session === next { status.text = "Ready" }
            } catch {
                try? await close()
                status.text = error.localizedDescription
            }
        }
    }

    func setForeground(_ active: Bool) {
        foreground = active
        try? session?.setForeground(active)
    }

    func close() async throws {
        let retiring = surface
        surface = nil
        session = nil
        defer { retiring?.removeFromSuperview() }
        try await retiring?.close()
    }
}
