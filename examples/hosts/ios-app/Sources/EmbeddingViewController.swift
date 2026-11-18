#if canImport(UIKit)
import UIKit
#if canImport(WeappContainerHost)
import WeappContainerHost
#endif

/// App embedding example with a live native surface. The host chooses a
/// verified pack directory and engine; normal navigation can remove and
/// reattach this controller without destroying the mini-program session.
/// Call `close()` when permanently retiring the feature.
final class WeappContainerEmbeddingViewController: UIViewController {
    private let packDirectory: URL
    private let engine: String
    private let sessionID: String
    private let route: String?
    private var startAttempted = false
    private weak var failureLabel: UILabel?
    private(set) var containerView: WeappContainerView?
    private(set) var startupError: Error?
    var onStartup: ((WeappPortablePackStartup) -> Void)?
    /// Install operation/GPU callbacks before the surface enters a window.
    var onConfigure: ((WeappContainerView) -> Void)?
    var onError: ((Error) -> Void)?

    init(packDirectory: URL, engine: String = "quickjs",
         sessionID: String = UUID().uuidString, route: String? = nil) {
        self.packDirectory = packDirectory
        self.engine = engine
        self.sessionID = sessionID
        self.route = route
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable, message: "Supply a portable pack directory")
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // onLoad may synchronously query window dimensions. Wait for the
        // attached controller's actual safe-area viewport before startup.
        let viewport = view.safeAreaLayoutGuide.layoutFrame
        guard !startAttempted, view.window != nil,
              viewport.width.isFinite, viewport.height.isFinite,
              viewport.width >= 1, viewport.height >= 1 else { return }
        startAttempted = true
        do {
            let pack = try WeappPortablePack(directory: packDirectory)
            let container = try WeappContainerView(pack: pack, engine: engine, sessionID: sessionID, route: route,
                                                    width: Double(viewport.width), height: Double(viewport.height))
            container.onError = { [weak self] error in self?.showFailure(error) }
            containerView = container
            onConfigure?(container)
            onStartup?(container.session.startup)
            container.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(container)
            NSLayoutConstraint.activate([
                container.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
                container.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
                container.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                container.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            ])
        } catch {
            startupError = error
            showFailure(error)
        }
    }

    func close() throws {
        try containerView?.close()
    }

    private func showFailure(_ error: Error) {
        onError?(error)
        let label: UILabel
        if let existing = failureLabel {
            label = existing
        } else {
            label = UILabel()
            label.translatesAutoresizingMaskIntoConstraints = false
            label.numberOfLines = 0
            label.font = .preferredFont(forTextStyle: .body)
            label.textColor = .systemRed
            label.backgroundColor = .systemBackground
            view.addSubview(label)
            failureLabel = label
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
                label.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
                label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            ])
        }
        label.text = "Weapp Container\n\(error)"
    }
}
#endif
