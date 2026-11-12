import UIKit

// Opt-in host instrumentation. This lives in the independent consumer and
// exercises UIKit geometry; it does not call or modify SDK viewport APIs.
@MainActor final class ConsumerSceneRotation: UIView {
    static var supportedOrientations: UIInterfaceOrientationMask = .allButUpsideDown
    private let button = UIButton(type: .system)
    private let observation = SceneObservation()

    static func install(in window: UIWindow?) {
        guard ProcessInfo.processInfo.arguments.contains("--weapp-scene-rotation"), let window else { return }
        let host = ConsumerSceneRotation(frame: .zero)
        host.translatesAutoresizingMaskIntoConstraints = false
        window.addSubview(host)
        NSLayoutConstraint.activate([
            host.topAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor),
            host.leadingAnchor.constraint(equalTo: window.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: window.trailingAnchor),
            host.heightAnchor.constraint(equalToConstant: 28),
        ])
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground
        button.setTitle("Rotate host", for: .normal)
        button.accessibilityIdentifier = "consumer-scene-rotate"
        button.addTarget(self, action: #selector(rotate), for: .touchUpInside)
        observation.text = "Host scene"
        observation.font = .systemFont(ofSize: 10)
        observation.isAccessibilityElement = true
        observation.accessibilityIdentifier = "consumer-scene-observation"
        addSubview(button); addSubview(observation)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        button.frame = CGRect(x: 8, y: 0, width: 110, height: bounds.height)
        observation.frame = CGRect(x: 126, y: 0, width: max(1, bounds.width - 134), height: bounds.height)
    }

    @objc private func rotate() {
        guard let window, let scene = window.windowScene else { return }
        Self.supportedOrientations = scene.interfaceOrientation.isLandscape ? .portrait : .landscapeRight
        window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: Self.supportedOrientations)) { [weak self] error in
            self?.observation.failure = error.localizedDescription
        }
    }

    private final class SceneObservation: UILabel {
        var failure: String?
        override var accessibilityValue: String? {
            get {
                guard let window, let scene = window.windowScene else { return nil }
                var value: [String: Any] = ["interfaceOrientation": scene.interfaceOrientation.rawValue,
                                            "windowWidth": window.bounds.width,
                                            "windowHeight": window.bounds.height]
                if let failure { value["error"] = failure }
                guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
                return String(data: data, encoding: .utf8)
            }
            set { }
        }
    }
}
