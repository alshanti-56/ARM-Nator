import AppKit
import AVFoundation
import Darwin
import Foundation
import KSPlayer
import Metal
import QuartzCore

private let backendName = "ksplayer-metal"
private let abiVersion = "1"
private let abiVersionCString: UnsafeMutablePointer<CChar> = strdup("1")!

private final class MetalOnlyOptions: KSOptions {
    /// KSPlayer's direct-Metal path queries this for every decoded frame before
    /// assigning CAMetalLayer.drawableSize. Keeping it mutable lets a live
    /// session adopt a new DAR without replacing its decoder or host view.
    var requestedDisplayAspect: CGSize?

    override func isUseDisplayLayer() -> Bool {
        false
    }

    override func customizeDar(sar _: CGSize, par _: CGSize) -> CGSize? {
        requestedDisplayAspect
    }
}

private struct Bounds {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var normalizedWidth: CGFloat { CGFloat(max(width, 0)) }
    var normalizedHeight: CGFloat { CGFloat(max(height, 0)) }
}

private struct FrameSnapshot: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ frame: NSRect) {
        x = Double(frame.origin.x)
        y = Double(frame.origin.y)
        width = Double(frame.width)
        height = Double(frame.height)
    }

    init(_ bounds: Bounds) {
        x = bounds.x
        y = bounds.y
        width = Double(bounds.normalizedWidth)
        height = Double(bounds.normalizedHeight)
    }
}

private struct SizeSnapshot: Encodable {
    let width: Double
    let height: Double

    init(_ size: CGSize) {
        width = Double(size.width)
        height = Double(size.height)
    }
}

private struct ViewIdentity: Encodable {
    let className: String
    /// A stable hierarchy role, deliberately not an address or window title.
    let role: String
}

private struct ViewSnapshot: Encodable {
    let className: String
    let frame: FrameSnapshot
    let bounds: FrameSnapshot
    let isFlipped: Bool
    let isHidden: Bool
    let childCount: Int
    let superview: ViewIdentity?

    init(_ view: NSView, superview: ViewIdentity?) {
        className = String(describing: type(of: view))
        frame = FrameSnapshot(view.frame)
        bounds = FrameSnapshot(view.bounds)
        isFlipped = view.isFlipped
        isHidden = view.isHidden
        childCount = view.subviews.count
        self.superview = superview
    }
}

private struct MetalLayerSnapshot: Encodable {
    let className: String
    let frame: FrameSnapshot
    let bounds: FrameSnapshot
    let drawableSize: SizeSnapshot
    let isHidden: Bool
    let contentsScale: Double

    init(_ layer: CAMetalLayer) {
        className = String(describing: type(of: layer))
        frame = FrameSnapshot(layer.frame)
        bounds = FrameSnapshot(layer.bounds)
        drawableSize = SizeSnapshot(layer.drawableSize)
        isHidden = layer.isHidden
        contentsScale = Double(layer.contentsScale)
    }
}

/// Evidence that a decoded KSPlayer frame reached the direct-Metal branch.
/// This deliberately describes only renderer state and frame geometry; it
/// never includes pixel contents, stream URLs, or request headers.
private struct DecodedFrameSnapshot: Encodable {
    let width: Double
    let height: Double
    let planeCount: Int
    let bitDepth: Int

    init(_ pixelBuffer: any PixelBufferProtocol) {
        width = Double(pixelBuffer.width)
        height = Double(pixelBuffer.height)
        planeCount = pixelBuffer.planeCount
        bitDepth = Int(pixelBuffer.bitDepth)
    }
}

/// KSPlayer's MetalPlayView initially exposes an AVSampleBufferDisplayLayer
/// while its Metal child is hidden. A visible CAMetalLayer alone therefore
/// does not prove a decoded frame was presented through the direct-Metal path.
private struct DirectMetalRenderSnapshot: Encodable {
    let decodedFrame: DecodedFrameSnapshot?
    let metalView: ViewSnapshot?
    let sampleBufferView: ViewSnapshot?
    let metalViewVisible: Bool
    let sampleBufferViewVisible: Bool
    let directMetalActive: Bool
}

private struct EmbeddingChildCounts: Encodable {
    var hostBeforeAttach: Int?
    var hostAfterAttach: Int?
    var containerBeforePlayerAttach: Int?
    var containerAfterPlayerAttach: Int?
    var containerAfterPlayerDispose: Int?
    var hostAfterDispose: Int?
}

/// Live, geometry-only evidence for the native embedding boundary. It is
/// intentionally free of stream URLs, request headers, window titles, and
/// object addresses so it remains safe to expose through the native snapshot.
private struct LiveEmbeddingDiagnostic: Encodable {
    let available: Bool
    let ok: Bool
    let sessionId: String?
    let phase: String
    let requestedBounds: FrameSnapshot?
    let host: ViewSnapshot?
    let container: ViewSnapshot?
    let playerView: ViewSnapshot?
    let metalPlayView: ViewSnapshot?
    let metalLayer: MetalLayerSnapshot?
    let renderPath: DirectMetalRenderSnapshot?
    let childCounts: EmbeddingChildCounts
    let reason: String?

    static func unavailable(_ reason: String) -> LiveEmbeddingDiagnostic {
        LiveEmbeddingDiagnostic(
            available: false,
            ok: false,
            sessionId: nil,
            phase: "unavailable",
            requestedBounds: nil,
            host: nil,
            container: nil,
            playerView: nil,
            metalPlayView: nil,
            metalLayer: nil,
            renderPath: nil,
            childCounts: EmbeddingChildCounts(),
            reason: reason
        )
    }
}

private struct EmbeddingDiagnostic: Encodable {
    let ok: Bool
    let initialFrame: FrameSnapshot
    let updatedFrame: FrameSnapshot
    let childCountAfterAttach: Int
    let childCountAfterDispose: Int
    let reason: String?
}

/// A non-interactive, clipped child boundary between Electron's content view
/// and KSPlayer's AppKit/Metal hierarchy. Mirroring embedded MPV's container
/// prevents a renderer-owned view or CALayer from becoming a direct child of
/// Chromium's content view.
private final class KSPlayerMetalContainerView: NSView {
    override var isFlipped: Bool { true }

    override func hitTest(_: NSPoint) -> NSView? {
        nil
    }
}

/// Subtitle presentation kept outside KSPlayer's video view. The direct
/// Metal renderer intentionally has no control or text subviews, so this
/// transparent sibling lets the runtime display KSPlayer's parsed subtitle
/// parts without changing the renderer hierarchy.
private final class KSPlayerMetalSubtitleView: NSView {
    private let label = NSTextField(labelWithString: "")
    private var position: CGFloat = 92
    private var fontSize: CGFloat = 100
    private var backgroundOpacity: CGFloat = 72
    private var outlineSize: CGFloat = 2
    private var renderedCueKey: String?

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true
        label.alignment = .center
        label.textColor = .white
        label.font = .systemFont(ofSize: 26, weight: .medium)
        label.drawsBackground = false
        label.isBordered = false
        label.isEditable = false
        label.isSelectable = false
        label.usesSingleLineMode = false
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        label.shadow = {
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.9)
            shadow.shadowBlurRadius = 3
            shadow.shadowOffset = NSSize(width: 0, height: -1)
            return shadow
        }()
        addSubview(label)
        apply(
            settings: SubtitleSettingsPayload(
                fontSize: 100,
                textColor: "#FFFFFF",
                backgroundColor: "#000000",
                backgroundOpacity: 72,
                outlineSize: 2,
                position: 92,
                delaySeconds: 0
            )
        )
        isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        let labelWidth = max(bounds.width - 56, 0)
        let measuredHeight = label.attributedStringValue.boundingRect(
            with: NSSize(width: labelWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        ).height
        let maxLabelHeight = max(bounds.height - 18, 34)
        let labelHeight = min(
            max(measuredHeight + 18, 34),
            maxLabelHeight
        )
        let availableHeight = max(bounds.height - labelHeight - 18, 0)
        let originY = availableHeight * min(max(position / 100, 0), 1)
        label.frame = NSRect(
            x: 28,
            y: originY,
            width: labelWidth,
            height: labelHeight
        )
    }

    func apply(settings: SubtitleSettingsPayload) {
        fontSize = min(max(CGFloat(settings.fontSize), 50), 200)
        position = min(max(CGFloat(settings.position), 0), 100)
        backgroundOpacity = min(max(CGFloat(settings.backgroundOpacity), 0), 100)
        outlineSize = min(max(CGFloat(settings.outlineSize), 0), 6)
        label.font = .systemFont(ofSize: 26 * fontSize / 100, weight: .medium)
        label.textColor = NSColor(hex: settings.textColor) ?? .white
        label.backgroundColor = (NSColor(hex: settings.backgroundColor) ?? .black)
            .withAlphaComponent(backgroundOpacity / 100)
        label.drawsBackground = backgroundOpacity > 0
        label.wantsLayer = true
        label.layer?.cornerRadius = 4
        label.shadow = {
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.95)
            shadow.shadowBlurRadius = outlineSize * 2
            shadow.shadowOffset = .zero
            return shadow
        }()
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    func show(part: SubtitlePart?) {
        guard let text = part?.text, text.length > 0 else {
            renderedCueKey = nil
            if isHidden {
                return
            }
            label.attributedStringValue = NSAttributedString(string: "")
            isHidden = true
            return
        }
        let cueKey = "\(part?.start ?? 0)|\(part?.end ?? 0)|\(text.string)"
        if renderedCueKey == cueKey {
            isHidden = false
            return
        }
        renderedCueKey = cueKey
        let attributed = NSMutableAttributedString(attributedString: text)
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.alignment = .center
        paragraphStyle.lineBreakMode = .byWordWrapping
        attributed.addAttribute(
            .paragraphStyle,
            value: paragraphStyle,
            range: NSRange(location: 0, length: attributed.length)
        )
        attributed.addAttribute(
            .font,
            value: label.font ?? NSFont.systemFont(ofSize: 26, weight: .medium),
            range: NSRange(location: 0, length: attributed.length)
        )
        label.attributedStringValue = attributed
        isHidden = false
    }
}

private struct SubtitleSettingsPayload: Decodable {
    let fontSize: Double
    let textColor: String
    let backgroundColor: String
    let backgroundOpacity: Double
    let outlineSize: Double
    let position: Double
    let delaySeconds: Double
}

private extension NSColor {
    convenience init?(hex: String) {
        let value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
        guard value.count == 6, let rgb = UInt64(value, radix: 16) else {
            return nil
        }
        self.init(
            calibratedRed: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
    }
}

/// Keeps Electron's content view and KSPlayer's renderer on separate layout
/// paths. KSMEPlayer owns constraints for its internal drawing subviews; only
/// the plain container is explicitly framed in Electron coordinates.
@MainActor
private enum KSPlayerMetalEmbeddingLayout {
    static func attach(
        _ playerView: NSView,
        to hostView: NSView,
        bounds: Bounds,
        childCounts: inout EmbeddingChildCounts
    ) -> KSPlayerMetalContainerView {
        let containerView = KSPlayerMetalContainerView(frame: frame(for: bounds, in: hostView))
        configure(containerView)

        childCounts.hostBeforeAttach = hostView.subviews.count
        hostView.addSubview(containerView, positioned: .above, relativeTo: nil)
        childCounts.hostAfterAttach = hostView.subviews.count

        childCounts.containerBeforePlayerAttach = containerView.subviews.count
        configure(playerView, in: containerView)
        containerView.addSubview(playerView)
        childCounts.containerAfterPlayerAttach = containerView.subviews.count
        apply(bounds, to: containerView, playerView: playerView, in: hostView)
        return containerView
    }

    static func apply(
        _ bounds: Bounds,
        to containerView: NSView,
        playerView: NSView,
        in hostView: NSView,
        subtitleView: NSView? = nil
    ) {
        let containerFrame = frame(for: bounds, in: hostView)
        let isHidden = containerFrame.width <= 0 || containerFrame.height <= 0
        containerView.frame = containerFrame
        containerView.isHidden = isHidden
        playerView.frame = containerView.bounds
        playerView.isHidden = isHidden
        // Subtitles remain in the full presentation viewport. KSPlayer's
        // Metal renderer applies DAR internally, so this preserves the normal
        // subtitle position/settings coordinate system across aspect changes.
        subtitleView?.frame = containerView.bounds
        if isHidden {
            subtitleView?.isHidden = true
        }
        playerView.needsDisplay = true
        containerView.needsDisplay = true
    }

    static func detach(
        _ playerView: NSView?,
        from containerView: NSView?,
        hostView: NSView?,
        childCounts: inout EmbeddingChildCounts
    ) {
        playerView?.removeFromSuperview()
        childCounts.containerAfterPlayerDispose = containerView?.subviews.count
        containerView?.removeFromSuperview()
        childCounts.hostAfterDispose = hostView?.subviews.count
    }

    static func diagnose() -> EmbeddingDiagnostic {
        // This deliberately uses a detached hierarchy: it proves the plain
        // container/frame policy without creating an NSWindow or touching
        // playback. Live Electron evidence is exposed through session
        // snapshots separately.
        let hostView = NSView(frame: NSRect(x: 0, y: 0, width: 1_000, height: 700))
        let playerView = NSView(frame: .zero)
        var childCounts = EmbeddingChildCounts()
        let firstBounds = Bounds(x: 137, y: 83, width: 320, height: 180)
        let expectedFirstFrame = frame(for: firstBounds, in: hostView)
        let containerView = attach(
            playerView,
            to: hostView,
            bounds: firstBounds,
            childCounts: &childCounts
        )
        let initialFrame = containerView.frame

        let secondBounds = Bounds(x: 211, y: 117, width: 240, height: 135)
        let expectedSecondFrame = frame(for: secondBounds, in: hostView)
        apply(secondBounds, to: containerView, playerView: playerView, in: hostView)
        let updatedFrame = containerView.frame

        let layoutIsFrameControlled =
            containerView.translatesAutoresizingMaskIntoConstraints &&
            containerView.autoresizingMask.isEmpty &&
            playerView.translatesAutoresizingMaskIntoConstraints &&
            playerView.autoresizingMask.isEmpty
        let safePresentation =
            containerView.layer?.masksToBounds == true &&
            containerView.layer?.backgroundColor != nil &&
            containerView.isFlipped
        let remainsWithinHost =
            isContained(initialFrame, in: hostView.bounds) &&
            isContained(updatedFrame, in: hostView.bounds) &&
            initialFrame.width < hostView.bounds.width &&
            initialFrame.height < hostView.bounds.height &&
            updatedFrame.width < hostView.bounds.width &&
            updatedFrame.height < hostView.bounds.height
        let repeatedBoundsWorked =
            matches(initialFrame, expectedFirstFrame) &&
            matches(updatedFrame, expectedSecondFrame) &&
            !matches(initialFrame, updatedFrame)
        let playerFillsContainer = matches(playerView.frame, containerView.bounds)
        let childCountAfterAttach = childCounts.hostAfterAttach ?? hostView.subviews.count

        detach(
            playerView,
            from: containerView,
            hostView: hostView,
            childCounts: &childCounts
        )
        let childCountAfterDispose = childCounts.hostAfterDispose ?? hostView.subviews.count
        let disposed =
            playerView.superview == nil &&
            containerView.superview == nil &&
            childCounts.containerAfterPlayerDispose == 0 &&
            childCountAfterDispose == 0

        var failures: [String] = []
        if !layoutIsFrameControlled {
            failures.append("The container or player view retained an expanding Auto Layout or autoresizing policy.")
        }
        if !safePresentation {
            failures.append("The container did not retain its flipped clipped black backing layer.")
        }
        if !remainsWithinHost {
            failures.append("The requested container frame expanded beyond the host view.")
        }
        if !repeatedBoundsWorked {
            failures.append("Repeated setBounds frame updates did not preserve the requested rectangles.")
        }
        if !playerFillsContainer {
            failures.append("The player view did not fill the dedicated container bounds.")
        }
        if childCountAfterAttach != 1 || !disposed {
            failures.append("Disposing the session did not remove the player and its only host container.")
        }

        return EmbeddingDiagnostic(
            ok: failures.isEmpty,
            initialFrame: FrameSnapshot(initialFrame),
            updatedFrame: FrameSnapshot(updatedFrame),
            childCountAfterAttach: childCountAfterAttach,
            childCountAfterDispose: childCountAfterDispose,
            reason: failures.isEmpty ? nil : failures.joined(separator: " ")
        )
    }

    static func liveDiagnostic(
        sessionId: String,
        phase: String,
        requestedBounds: Bounds,
        hostView: NSView?,
        containerView: NSView?,
        playerView: NSView?,
        childCounts: EmbeddingChildCounts,
        reason: String?
    ) -> LiveEmbeddingDiagnostic {
        let metalPlayView = findMetalPlayView(in: playerView)
        let metalSurface = findMetalLayer(in: playerView)
        let sampleBufferSurface = findSampleBufferDisplayLayer(in: playerView)
        let metalLayer = metalSurface?.layer
        let host = snapshot(of: hostView, hostView: hostView, containerView: containerView)
        let container = snapshot(of: containerView, hostView: hostView, containerView: containerView)
        let player = snapshot(of: playerView, hostView: hostView, containerView: containerView)
        let metal = snapshot(of: metalPlayView, hostView: hostView, containerView: containerView)
        let renderPath = directMetalRenderSnapshot(
            metalPlayView: metalPlayView,
            metalSurface: metalSurface,
            sampleBufferSurface: sampleBufferSurface,
            hostView: hostView,
            containerView: containerView
        )

        var failures: [String] = []
        if phase == "attached" {
            if containerView?.superview !== hostView {
                failures.append("The dedicated player container is not attached to the Electron content view.")
            }
            if playerView?.superview !== containerView {
                failures.append("The KSPlayer view is not attached to its dedicated container.")
            }
            if let containerView, let playerView,
               !matches(playerView.frame, containerView.bounds) {
                failures.append("The KSPlayer view does not fill the dedicated container bounds.")
            }
        }
        if phase == "disposed" {
            if childCounts.containerAfterPlayerDispose != 0 {
                failures.append("The dedicated container retained child views after disposal.")
            }
            if let before = childCounts.hostBeforeAttach,
               let after = childCounts.hostAfterDispose,
               before != after {
                failures.append("Electron's content view child count did not return to its pre-attach value.")
            }
        }
        if let reason, !reason.isEmpty {
            failures.append(reason)
        }

        return LiveEmbeddingDiagnostic(
            available: true,
            ok: failures.isEmpty,
            sessionId: sessionId,
            phase: phase,
            requestedBounds: FrameSnapshot(requestedBounds),
            host: host,
            container: container,
            playerView: player,
            metalPlayView: metal,
            metalLayer: metalLayer.map(MetalLayerSnapshot.init),
            renderPath: renderPath,
            childCounts: childCounts,
            reason: failures.isEmpty ? nil : failures.joined(separator: " ")
        )
    }

    private static func configure(_ containerView: NSView) {
        containerView.translatesAutoresizingMaskIntoConstraints = true
        containerView.autoresizingMask = []
        containerView.wantsLayer = true
        containerView.layer?.backgroundColor = NSColor.black.cgColor
        containerView.layer?.masksToBounds = true
    }

    private static func configure(_ playerView: NSView, in containerView: NSView) {
        // Keep KSMEPlayer's internal subviews/layers untouched. Only its
        // top-level view is explicitly framed inside the container.
        playerView.translatesAutoresizingMaskIntoConstraints = true
        playerView.autoresizingMask = []
        deactivateFrameConstraints(for: playerView, in: containerView)
    }

    private static func deactivateFrameConstraints(
        for playerView: NSView,
        in containerView: NSView
    ) {
        let constraints = containerView.constraints.filter { constraint in
            (constraint.firstItem as? NSView) === playerView ||
                (constraint.secondItem as? NSView) === playerView
        }
        if !constraints.isEmpty {
            NSLayoutConstraint.deactivate(constraints)
        }
    }

    private static func snapshot(
        of view: NSView?,
        hostView: NSView?,
        containerView: NSView?
    ) -> ViewSnapshot? {
        guard let view else { return nil }
        let superview = view.superview.map { superview -> ViewIdentity in
            let role: String
            if superview === containerView {
                role = "player-container"
            } else if superview === hostView {
                role = "electron-content-view"
            } else {
                role = "other"
            }
            return ViewIdentity(
                className: String(describing: type(of: superview)),
                role: role
            )
        }
        return ViewSnapshot(view, superview: superview)
    }

    static func findMetalPlayView(in view: NSView?) -> NSView? {
        guard let view else { return nil }
        if view is MetalPlayView {
            return view
        }
        for subview in view.subviews {
            if let match = findMetalPlayView(in: subview) {
                return match
            }
        }
        return nil
    }

    private static func findMetalLayer(in view: NSView?) -> (view: NSView, layer: CAMetalLayer)? {
        guard let view else { return nil }
        if let layer = view.layer as? CAMetalLayer {
            return (view, layer)
        }
        for subview in view.subviews {
            if let match = findMetalLayer(in: subview) {
                return match
            }
        }
        return nil
    }

    private static func findSampleBufferDisplayLayer(
        in view: NSView?
    ) -> (view: NSView, layer: AVSampleBufferDisplayLayer)? {
        guard let view else { return nil }
        if let layer = view.layer as? AVSampleBufferDisplayLayer {
            return (view, layer)
        }
        for subview in view.subviews {
            if let match = findSampleBufferDisplayLayer(in: subview) {
                return match
            }
        }
        return nil
    }

    private static func directMetalRenderSnapshot(
        metalPlayView: NSView?,
        metalSurface: (view: NSView, layer: CAMetalLayer)?,
        sampleBufferSurface: (view: NSView, layer: AVSampleBufferDisplayLayer)?,
        hostView: NSView?,
        containerView: NSView?
    ) -> DirectMetalRenderSnapshot? {
        guard let metalPlayView else { return nil }
        let pixelBuffer = (metalPlayView as? MetalPlayView)?.pixelBuffer
        let decodedFrame = pixelBuffer.map { DecodedFrameSnapshot($0) }
        let metalViewVisible = metalSurface.map {
            !$0.view.isHidden && !$0.layer.isHidden
        } ?? false
        let sampleBufferViewVisible = sampleBufferSurface.map {
            !$0.view.isHidden && !$0.layer.isHidden
        } ?? false
        return DirectMetalRenderSnapshot(
            decodedFrame: decodedFrame,
            metalView: snapshot(
                of: metalSurface?.view,
                hostView: hostView,
                containerView: containerView
            ),
            sampleBufferView: snapshot(
                of: sampleBufferSurface?.view,
                hostView: hostView,
                containerView: containerView
            ),
            metalViewVisible: metalViewVisible,
            sampleBufferViewVisible: sampleBufferViewVisible,
            directMetalActive: decodedFrame != nil &&
                metalViewVisible &&
                !sampleBufferViewVisible
        )
    }

    private static func frame(for bounds: Bounds, in hostView: NSView) -> NSRect {
        let hostBounds = hostView.bounds
        let originY = hostView.isFlipped
            ? CGFloat(bounds.y)
            : hostBounds.maxY - CGFloat(bounds.y) - bounds.normalizedHeight
        return NSRect(
            x: CGFloat(bounds.x),
            y: originY,
            width: bounds.normalizedWidth,
            height: bounds.normalizedHeight
        )
    }

    private static func isContained(_ frame: NSRect, in bounds: NSRect) -> Bool {
        frame.minX >= bounds.minX &&
            frame.maxX <= bounds.maxX &&
            frame.minY >= bounds.minY &&
            frame.maxY <= bounds.maxY
    }

    private static func matches(_ lhs: NSRect, _ rhs: NSRect) -> Bool {
        abs(lhs.minX - rhs.minX) < 0.001 &&
            abs(lhs.minY - rhs.minY) < 0.001 &&
            abs(lhs.width - rhs.width) < 0.001 &&
            abs(lhs.height - rhs.height) < 0.001
    }
}

private struct Resolution: Encodable {
    let width: Double
    let height: Double
}

private struct Support: Encodable {
    let supported: Bool
    let reason: String?
    let architecture: String
}

private struct Controls: Encodable {
    let pause: Bool
    let seek: Bool
    let volume: Bool
    let audioTracks: Bool
    let subtitles: Bool
    let playbackSpeed: Bool
    let displayMode: Bool
    let aspectOverride: Bool
    let pictureAdjustments: Bool
}

private struct PictureSettingsPayload: Codable {
    let brightness: Double
    let contrast: Double
    let blackLevel: Double
    let saturation: Double
    let gamma: Double

    static let `default` = PictureSettingsPayload(
        brightness: 0, contrast: 0, blackLevel: 0, saturation: 0, gamma: 0
    )

    var isValid: Bool {
        [brightness, contrast, blackLevel, saturation, gamma].allSatisfy {
            $0.isFinite && (-100 ... 100).contains($0)
        }
    }
}

private enum AspectOverride: String, CaseIterable {
    case `default` = "no"
    case widescreen = "16:9"
    case standard = "4:3"
    case ultrawide = "21:9"
    case cinema = "2.35:1"

    var ratio: CGFloat? {
        switch self {
        case .default: return nil
        case .widescreen: return 16.0 / 9.0
        case .standard: return 4.0 / 3.0
        case .ultrawide: return 21.0 / 9.0
        case .cinema: return 2.35
        }
    }

    var dar: CGSize? {
        ratio.map { CGSize(width: $0, height: 1) }
    }
}

private struct TrackSnapshot: Encodable {
    let id: Int
    let title: String?
    let language: String?
    let selected: Bool
}

private struct SeekTestEvidence: Encodable {
    let timeoutRecoveryCount: Int
    let ignoredCompletionCount: Int
}

private struct Snapshot: Encodable {
    let backend: String = backendName
    let state: String
    // `status` and video dimensions are additive compatibility aliases for the
    // existing EmbeddedMpvSession TypeScript lane. `state` and `resolution`
    // remain the canonical KSPlayer Metal fields.
    let status: String
    let streamUrl: String?
    let positionSeconds: Double?
    let durationSeconds: Double?
    let paused: Bool?
    let volume: Double?
    let audioTracks: [TrackSnapshot]
    let selectedAudioTrackId: Int?
    let subtitleTracks: [TrackSnapshot]
    let selectedSubtitleTrackId: Int?
    let playbackSpeed: Double?
    let aspectOverride: String
    let picture: PictureSettingsPayload
    let resolution: Resolution?
    let videoWidth: Double?
    let videoHeight: Double?
    let container: String?
    let videoCodec: String?
    let audioCodec: String?
    let fps: Double?
    let bitrate: Double?
    let droppedFrames: UInt32?
    let bufferedSeconds: Double?
    let error: String?
    let message: String?
    /// Additive live native-view evidence. It contains geometry only; stream
    /// URLs and request headers are never copied into this diagnostic.
    let embedding: LiveEmbeddingDiagnostic?
    /// Present only for harness-designated sessions.
    let seekTestEvidence: SeekTestEvidence?

    static func error(
        _ message: String,
        seekTestEvidence: SeekTestEvidence? = nil
    ) -> Snapshot {
        Snapshot(
            state: "error",
            status: "error",
            streamUrl: nil,
            positionSeconds: nil,
            durationSeconds: nil,
            paused: nil,
            volume: nil,
            audioTracks: [],
            selectedAudioTrackId: nil,
            subtitleTracks: [],
            selectedSubtitleTrackId: nil,
            playbackSpeed: nil,
            aspectOverride: AspectOverride.default.rawValue,
            picture: .default,
            resolution: nil,
            videoWidth: nil,
            videoHeight: nil,
            container: nil,
            videoCodec: nil,
            audioCodec: nil,
            fps: nil,
            bitrate: nil,
            droppedFrames: nil,
            bufferedSeconds: nil,
            error: message,
            message: message,
            embedding: nil,
            seekTestEvidence: seekTestEvidence
        )
    }
}

private struct OperationResult: Encodable {
    let ok: Bool
    let backend: String = backendName
    let reason: String?
    let message: String?
    let sessionId: String?
    let snapshot: Snapshot?

    static func success(sessionId: String? = nil, snapshot: Snapshot? = nil) -> OperationResult {
        OperationResult(
            ok: true,
            reason: nil,
            message: nil,
            sessionId: sessionId,
            snapshot: snapshot
        )
    }

    static func failure(
        _ reason: String,
        sessionId: String? = nil,
        snapshot: Snapshot? = nil
    ) -> OperationResult {
        OperationResult(
            ok: false,
            reason: reason,
            message: reason,
            sessionId: sessionId,
            snapshot: snapshot
        )
    }
}

@MainActor
private final class KSPlayerMetalSession: NSObject, MediaPlayerDelegate {
    private enum SessionState: String {
        case idle
        case loading
        case seeking
        case playing
        case paused
        case ended
        case error
        case disposed
    }

    /// KSPlayer's KSMEPlayer only retains one seek completion handler. The
    /// runtime therefore owns the request queue and never hands it concurrent
    /// seek calls. A later renderer request replaces the queued target while
    /// the in-flight seek is allowed to finish.
    private struct PendingSeek {
        let generation: UInt64
        var latestTarget: Double?
    }

    let id: String
    private weak var hostView: NSView?
    private var player: KSMEPlayer?
    private var containerView: KSPlayerMetalContainerView?
    private var playerView: NSView?
    private var subtitleView: KSPlayerMetalSubtitleView?
    private var options: MetalOnlyOptions?
    private var bounds: Bounds
    private var childCounts = EmbeddingChildCounts()
    private var lastEmbeddingDiagnostic: LiveEmbeddingDiagnostic?
    private var requestedPaused: Bool?
    private var requestedVolume: Float = 1
    private var requestedPlaybackSpeed: Float = 1
    private var requestedDisplayMode = "fit"
    private var requestedAspectOverride: AspectOverride = .default
    private var pictureSettings = PictureSettingsPayload.default
    private var streamURL: String?
    private var loadedURL: URL?
    private var loadedHeaders: [String: String] = [:]
    private var loadedSubtitleURL: URL?
    private var externalSubtitleInfos: [Int: any SubtitleInfo] = [:]
    private var selectedSubtitleTrackID: Int?
    private var subtitleUpdateTimer: Timer?
    private var subtitleDelay: TimeInterval = 0
    private var displayedSubtitlePart: SubtitlePart?
    private var state: SessionState = .idle
    private var lastError: String?
    private var lastSeekError: String?
    private var pendingSeek: PendingSeek?
    private var seekGeneration: UInt64 = 0
    private var seekTimeoutWorkItem: DispatchWorkItem?
    private var testLateCompletionBudget: Int
    private var testTimeoutRecoveryCount = 0
    private var testIgnoredCompletionCount = 0

    // A seek happens on KSPlayer's decoding thread. This timeout is only a
    // recovery guard: it schedules a fresh source load on the main actor and
    // never blocks Electron's main thread waiting for decode or GPU work.
    private static let productionSeekTimeout = DispatchTimeInterval.seconds(15)
    private static let testSessionIDs: Set<String> = {
        let raw = ProcessInfo.processInfo.environment[
            "ARM_NATOR_KSPLAYER_METAL_TEST_SESSION_IDS"
        ] ?? ""
        return Set(raw.split(separator: ",").map(String.init))
    }()
    private static let testSeekTimeoutMilliseconds: Int? = {
        guard let raw = ProcessInfo.processInfo.environment[
            "ARM_NATOR_KSPLAYER_METAL_TEST_SEEK_TIMEOUT_MS"
        ], let milliseconds = Int(raw), milliseconds > 0 else {
            return nil
        }
        return milliseconds
    }()
    private static let testLateCompletionDelayMilliseconds: Int? = {
        guard let raw = ProcessInfo.processInfo.environment[
            "ARM_NATOR_KSPLAYER_METAL_TEST_LATE_COMPLETION_MS"
        ], let milliseconds = Int(raw), milliseconds > 0 else {
            return nil
        }
        return milliseconds
    }()

    private var isHarnessTestSession: Bool {
        Self.testSessionIDs.contains(id)
    }

    private var seekTimeout: DispatchTimeInterval {
        guard
            isHarnessTestSession,
            let milliseconds = Self.testSeekTimeoutMilliseconds
        else {
            return Self.productionSeekTimeout
        }
        return .milliseconds(milliseconds)
    }

    init(id: String, hostView: NSView, bounds: Bounds) {
        self.id = id
        self.hostView = hostView
        self.bounds = bounds
        self.testLateCompletionBudget = Self.testSessionIDs.contains(id) &&
            Self.testLateCompletionDelayMilliseconds != nil ? 1 : 0
    }

    func load(
        url: URL,
        headers: [String: String],
        subtitleURL: URL? = nil
    ) -> OperationResult {
        invalidatePendingSeek()
        guard let hostView else {
            return .failure("Electron BrowserWindow content view is unavailable.", sessionId: id)
        }

        detachPlayer()
        let options = MetalOnlyOptions()
        options.requestedDisplayAspect = requestedAspectOverride.dar
        // The retained-packet backward-seek optimization is unsafe for this
        // short, fully-buffered local VOD path: it can feed a stale output
        // queue after a seek. Prefer KSPlayer's authoritative FFmpeg seek,
        // which resets the decoder and clock as one operation.
        options.inBufferBackwardSeek = false
        // The direct Metal view is configured globally by KSPlayer. Reassert it
        // for every replacement in case another in-process user changed it.
        KSOptions.videoPlayerType = MetalPlayView.self
        options.automaticWindowResize = false
        options.registerRemoteControll = false
        if !headers.isEmpty {
            options.appendHeader(headers)
        }

        let player = KSMEPlayer(url: url, options: options)
        player.delegate = self
        guard let playerView = player.view else {
            player.shutdown()
            return .failure("KSMEPlayer did not create a Metal player view.", sessionId: id)
        }

        self.player = player
        self.options = options
        streamURL = url.absoluteString
        loadedURL = url
        loadedHeaders = headers
        loadedSubtitleURL = subtitleURL
        externalSubtitleInfos.removeAll()
        selectedSubtitleTrackID = nil
        subtitleUpdateTimer?.invalidate()
        subtitleUpdateTimer = nil
        lastError = nil
        lastSeekError = nil
        state = .loading
        childCounts = EmbeddingChildCounts()
        let containerView = KSPlayerMetalEmbeddingLayout.attach(
            playerView,
            to: hostView,
            bounds: bounds,
            childCounts: &childCounts
        )
        self.containerView = containerView
        self.playerView = playerView
        applyDisplayMode(to: player)
        applyPictureSettings()
        let subtitleView = KSPlayerMetalSubtitleView(frame: containerView.bounds)
        containerView.addSubview(subtitleView, positioned: .above, relativeTo: nil)
        self.subtitleView = subtitleView
        applyBounds()
        startSubtitleUpdates()
        if let subtitleURL {
            _ = setSubtitleFile(subtitleURL.absoluteString)
        }

        player.playbackVolume = requestedVolume
        player.playbackRate = requestedPlaybackSpeed
        player.prepareToPlay()
        if requestedPaused == true {
            player.pause()
            state = .paused
        } else {
            requestedPaused = false
            player.play()
        }

        return .success(sessionId: id, snapshot: snapshot())
    }

    func setBounds(_ bounds: Bounds) -> OperationResult {
        self.bounds = bounds
        applyBounds()
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setPaused(_ paused: Bool) -> OperationResult {
        requestedPaused = paused
        guard let player else {
            return .success(sessionId: id, snapshot: snapshot())
        }

        // KSMEPlayer has already paused its outputs while it is seeking. Do
        // not overwrite its transient `.seeking` state; the completion below
        // applies the latest user pause intent once the decoder is ready.
        if pendingSeek != nil {
            state = .seeking
            return .success(sessionId: id, snapshot: snapshot())
        }

        if paused {
            player.pause()
            state = .paused
        } else {
            player.play()
            state = player.loadState == .playable ? .playing : .loading
        }
        return .success(sessionId: id, snapshot: snapshot())
    }

    func seek(_ seconds: Double) -> OperationResult {
        guard seconds.isFinite, seconds >= 0 else {
            return .failure("Seek time must be a finite non-negative number.", sessionId: id)
        }
        guard let player else {
            return .failure("KSPlayer session has not loaded a stream.", sessionId: id)
        }
        guard player.isReadyToPlay else {
            return .failure(
                "KSPlayer Metal cannot seek until the current stream is ready.",
                sessionId: id,
                snapshot: snapshot()
            )
        }
        guard player.seekable else {
            return .failure(
                "KSPlayer Metal cannot seek a live or non-seekable stream.",
                sessionId: id,
                snapshot: snapshot()
            )
        }
        let duration = player.duration
        guard duration.isFinite, duration > 0 else {
            return .failure(
                "KSPlayer Metal cannot seek a live stream without a finite duration.",
                sessionId: id,
                snapshot: snapshot()
            )
        }

        let target = min(seconds, duration)
        if var pendingSeek {
            // Keep exactly one KSMEPlayer seek in flight. KSPlayer would
            // otherwise replace its only completion handler, leaving an older
            // caller's state transition stranded in `.seeking`.
            pendingSeek.latestTarget = target
            self.pendingSeek = pendingSeek
            return .success(sessionId: id, snapshot: snapshot())
        }

        // Preserve the pre-seek intent. A later pause/play command updates
        // `requestedPaused` and deliberately wins when this seek completes.
        requestedPaused = requestedPaused == true || player.playbackState == .paused
        beginSeek(to: target, player: player)
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setVolume(_ volume: Double) -> OperationResult {
        guard volume.isFinite else {
            return .failure("Volume must be a finite number.", sessionId: id)
        }
        let normalized = Float(min(max(volume, 0), 1))
        requestedVolume = normalized
        player?.playbackVolume = normalized
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setAudioTrack(_ trackID: Double) -> OperationResult {
        guard trackID.isFinite,
              trackID.rounded() == trackID,
              trackID >= Double(Int32.min),
              trackID <= Double(Int32.max) else {
            return .failure("Audio track id must be a valid integer.", sessionId: id)
        }
        let targetID = Int32(trackID)
        guard let track = player?.tracks(mediaType: .audio).first(where: {
            $0.trackID == targetID
        }) else {
            return .failure("Audio track was not found.", sessionId: id)
        }
        player?.select(track: track)
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setSubtitleTrack(_ trackID: Double) -> OperationResult {
        guard trackID.isFinite,
              trackID.rounded() == trackID,
              trackID >= Double(Int32.min),
              trackID <= Double(Int32.max) else {
            return .failure("Subtitle track id must be a valid integer.", sessionId: id)
        }
        let targetID = Int(trackID)
        if targetID == -1 {
            player?.tracks(mediaType: .subtitle).forEach { $0.isEnabled = false }
            externalSubtitleInfos.values.forEach { $0.isEnabled = false }
            selectedSubtitleTrackID = nil
            displayedSubtitlePart = nil
            subtitleView?.show(part: nil)
            return .success(sessionId: id, snapshot: snapshot())
        }

        if let external = externalSubtitleInfos[targetID] {
            player?.tracks(mediaType: .subtitle).forEach { $0.isEnabled = false }
            externalSubtitleInfos.values.forEach { $0.isEnabled = false }
            external.isEnabled = true
            selectedSubtitleTrackID = targetID
            displayedSubtitlePart = nil
            return .success(sessionId: id, snapshot: snapshot())
        }

        guard let player,
              let track = player.tracks(mediaType: .subtitle).first(where: {
                  Int($0.trackID) == targetID
              }) else {
            return .failure("Subtitle track was not found.", sessionId: id)
        }
        externalSubtitleInfos.values.forEach { $0.isEnabled = false }
        player.select(track: track)
        selectedSubtitleTrackID = targetID
        displayedSubtitlePart = nil
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setSubtitleFile(_ rawURL: String) -> OperationResult {
        guard let url = subtitleURL(from: rawURL) else {
            return .failure("Subtitle URL or file path is invalid.", sessionId: id)
        }
        let id = nextExternalSubtitleID()
        let info = URLSubtitleInfo(url: url)
        loadedSubtitleURL = url
        externalSubtitleInfos[id] = info
        externalSubtitleInfos.values.forEach { $0.isEnabled = false }
        info.isEnabled = true
        selectedSubtitleTrackID = id
        displayedSubtitlePart = nil
        startSubtitleUpdates()
        return .success(sessionId: self.id, snapshot: snapshot())
    }

    func setSubtitleSettings(_ json: String) -> OperationResult {
        guard let data = json.data(using: .utf8),
              let settings = try? JSONDecoder().decode(SubtitleSettingsPayload.self, from: data),
              settings.fontSize.isFinite,
              settings.backgroundOpacity.isFinite,
              settings.outlineSize.isFinite,
              settings.position.isFinite,
              settings.delaySeconds.isFinite else {
            return .failure("Subtitle settings are invalid.", sessionId: id)
        }
        subtitleDelay = min(max(settings.delaySeconds, -30), 30)
        subtitleView?.apply(settings: settings)
        updateSubtitleView()
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setPlaybackSpeed(_ speed: Double) -> OperationResult {
        guard speed.isFinite, speed > 0 else {
            return .failure("Playback speed must be a finite positive number.", sessionId: id)
        }
        let normalized = Float(min(max(speed, 0.25), 4.0))
        requestedPlaybackSpeed = normalized
        player?.playbackRate = normalized
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setDisplayMode(_ mode: String) -> OperationResult {
        guard mode == "fit" || mode == "fill" else {
            return .failure(
                "KSPlayer display mode must be fit or fill.",
                sessionId: id
            )
        }
        requestedDisplayMode = mode
        if let player {
            applyDisplayMode(to: player)
        }
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setAspect(_ rawAspect: String) -> OperationResult {
        guard let aspect = AspectOverride(rawValue: rawAspect) else {
            return .failure(
                "Unsupported aspect override. Use no, 16:9, 4:3, 21:9, or 2.35:1.",
                sessionId: id
            )
        }
        requestedAspectOverride = aspect
        options?.requestedDisplayAspect = aspect.dar
        // A paused frame has no display-link tick; request one safe redraw so
        // the layer's observable drawable size updates immediately.
        (KSPlayerMetalEmbeddingLayout.findMetalPlayView(in: playerView) as? MetalPlayView)?.readNextFrame()
        return .success(sessionId: id, snapshot: snapshot())
    }

    func setPicture(_ json: String) -> OperationResult {
        guard let data = json.data(using: .utf8),
              let picture = try? JSONDecoder().decode(PictureSettingsPayload.self, from: data),
              picture.isValid else {
            return .failure("Picture settings must be finite values between -100 and 100.", sessionId: id)
        }
        pictureSettings = picture
        applyPictureSettings()
        return .success(sessionId: id, snapshot: snapshot())
    }

    func dispose() {
        state = .disposed
        detachPlayer()
    }

    func snapshot() -> Snapshot {
        reconcileEmbeddingState()
        let player = player
        let derivedState = currentState(player: player)
        // `EmbeddedMpvSessionStatus` intentionally has no `seeking` value.
        // Report the transient operation as loading while retaining the
        // requested paused/playing intent separately.
        let externalState = derivedState == .seeking ? SessionState.loading.rawValue : derivedState.rawValue
        let currentTime = player.flatMap { finiteValue($0.currentPlaybackTime) }
        let duration = player.flatMap { player -> Double? in
            let value = player.duration
            return value.isFinite && value > 0 ? value : nil
        }
        let resolution = player.flatMap { player -> Resolution? in
            let size = player.naturalSize
            guard size.width > 0, size.height > 0 else { return nil }
            return Resolution(width: size.width, height: size.height)
        }
        let videoTrack = player?.tracks(mediaType: .video).first { $0.isEnabled }
        let audioTrack = player?.tracks(mediaType: .audio).first { $0.isEnabled }
        let videoCodec = codecName(from: videoTrack)
        let audioCodec = codecName(from: audioTrack)
        let nominalFps = player.map { Double($0.nominalFrameRate) }
        let fps = nominalFps.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let bitrate = videoTrack.map { Double($0.bitRate) }.flatMap {
            $0.isFinite && $0 > 0 ? $0 : nil
        }
        let dynamicInfo = player?.dynamicInfo
        let bufferedSeconds = player.flatMap { player -> Double? in
            let buffered = player.playableTime - player.currentPlaybackTime
            return buffered.isFinite ? max(buffered, 0) : nil
        }
        let hasPlayer = player != nil
        let audioTracks = player?.tracks(mediaType: .audio).map { track in
            TrackSnapshot(
                id: Int(track.trackID),
                title: nonEmpty(track.name),
                language: nonEmpty(track.languageCode),
                selected: track.isEnabled
            )
        } ?? []
        let selectedAudioTrackId = audioTracks.first(where: { $0.selected })?.id
        let embeddedSubtitleTracks = player?.tracks(mediaType: .subtitle).map { track in
            TrackSnapshot(
                id: Int(track.trackID),
                title: nonEmpty(track.name),
                language: nonEmpty(track.languageCode),
                selected: selectedSubtitleTrackID == Int(track.trackID) && track.isEnabled
            )
        } ?? []
        let externalSubtitleTracks = externalSubtitleInfos.map { id, info in
            TrackSnapshot(
                id: id,
                title: nonEmpty(info.name),
                language: nil,
                selected: selectedSubtitleTrackID == id && info.isEnabled
            )
        }.sorted { $0.id < $1.id }
        let subtitleTracks = [
            TrackSnapshot(id: -1, title: "Off", language: nil, selected: selectedSubtitleTrackID == nil),
        ] + embeddedSubtitleTracks + externalSubtitleTracks

        return Snapshot(
            state: externalState,
            status: externalState,
            streamUrl: streamURL,
            positionSeconds: currentTime,
            durationSeconds: duration,
            paused: requestedPaused,
            volume: hasPlayer ? Double(player?.playbackVolume ?? requestedVolume) : Double(requestedVolume),
            audioTracks: audioTracks,
            selectedAudioTrackId: selectedAudioTrackId,
            subtitleTracks: subtitleTracks,
            selectedSubtitleTrackId: selectedSubtitleTrackID,
            playbackSpeed: hasPlayer ? Double(player?.playbackRate ?? requestedPlaybackSpeed) : Double(requestedPlaybackSpeed),
            aspectOverride: requestedAspectOverride.rawValue,
            picture: pictureSettings,
            resolution: resolution,
            videoWidth: resolution?.width,
            videoHeight: resolution?.height,
            container: nonEmpty(options?.formatName),
            videoCodec: videoCodec,
            audioCodec: audioCodec,
            fps: fps,
            bitrate: bitrate,
            droppedFrames: dynamicInfo?.droppedVideoFrameCount,
            bufferedSeconds: bufferedSeconds,
            error: lastError ?? lastSeekError,
            message: lastError ?? lastSeekError,
            embedding: embeddingDiagnostic(),
            seekTestEvidence: seekTestEvidence
        )
    }

    fileprivate var seekTestEvidence: SeekTestEvidence? {
        guard isHarnessTestSession else { return nil }
        return SeekTestEvidence(
            timeoutRecoveryCount: testTimeoutRecoveryCount,
            ignoredCompletionCount: testIgnoredCompletionCount
        )
    }

    func readyToPlay(player _: some MediaPlayerProtocol) {
        guard pendingSeek == nil else {
            state = .seeking
            return
        }
        state = requestedPaused == true ? .paused : .playing
    }

    func changeLoadState(player _: some MediaPlayerProtocol) {
        guard pendingSeek == nil else {
            state = .seeking
            return
        }
        guard let player else { return }
        if requestedPaused == true || player.playbackState == .paused {
            state = .paused
        } else if player.loadState == .playable && player.playbackState == .playing {
            state = .playing
        } else if state != .ended, state != .error {
            state = .loading
        }
    }

    func changeBuffering(player _: some MediaPlayerProtocol, progress _: Int) {}

    func playBack(player _: some MediaPlayerProtocol, loopCount _: Int) {
        guard pendingSeek == nil else {
            state = .seeking
            return
        }
        state = requestedPaused == true ? .paused : .playing
    }

    func finish(player _: some MediaPlayerProtocol, error: Error?) {
        guard state != .disposed else { return }
        if pendingSeek != nil {
            // Reaching the old EOF while FFmpeg moves to the requested target
            // must not overwrite the active seek. A real source error remains
            // terminal and invalidates its completion.
            if let error {
                invalidatePendingSeek()
                lastError = error.localizedDescription
                state = .error
            }
            return
        }
        if let error {
            lastError = error.localizedDescription
            state = .error
        } else {
            state = .ended
        }
    }

    private func currentState(player: KSMEPlayer?) -> SessionState {
        guard let player, state != .error, state != .ended, state != .disposed else {
            return state
        }
        if pendingSeek != nil {
            return .seeking
        }
        if requestedPaused == true || player.playbackState == .paused {
            return .paused
        }
        if player.playbackState == .finished {
            return .ended
        }
        if player.playbackState == .playing, player.loadState == .playable {
            return .playing
        }
        return state == .idle ? .idle : .loading
    }

    private func applyBounds() {
        guard let hostView, let containerView, let playerView else {
            return
        }
        KSPlayerMetalEmbeddingLayout.apply(
            bounds,
            to: containerView,
            playerView: playerView,
            in: hostView,
            subtitleView: subtitleView
        )
    }

    private func startSubtitleUpdates() {
        subtitleUpdateTimer?.invalidate()
        guard subtitleView != nil else { return }
        subtitleUpdateTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) {
            [weak self] _ in
            Task { @MainActor [weak self] in
                self?.updateSubtitleView()
            }
        }
        updateSubtitleView()
    }

    private func updateSubtitleView() {
        guard
            let player,
            let selectedSubtitleTrackID,
            selectedSubtitleTrackID != -1,
            let info = subtitleInfo(for: selectedSubtitleTrackID)
        else {
            displayedSubtitlePart = nil
            subtitleView?.show(part: nil)
            return
        }
        let currentTime = player.currentPlaybackTime
        guard currentTime.isFinite else {
            displayedSubtitlePart = nil
            subtitleView?.show(part: nil)
            return
        }
        let subtitleTime = currentTime - info.delay - subtitleDelay
        if let part = info.search(for: subtitleTime).first {
            displayedSubtitlePart = part
            subtitleView?.show(part: part)
            return
        }

        // KSPlayer's subtitle search is an exact interval lookup. Playback
        // time can advance past a cue boundary between timer ticks, and a
        // decoder can briefly report a slightly stale time while buffering.
        // Keep the last cue on screen through that tiny boundary instead of
        // turning it off for one frame and making subtitles visibly blink.
        if let displayedSubtitlePart,
           subtitleTime >= displayedSubtitlePart.start - 0.15,
           subtitleTime <= displayedSubtitlePart.end + 0.15 {
            subtitleView?.show(part: displayedSubtitlePart)
            return
        }

        displayedSubtitlePart = nil
        subtitleView?.show(part: nil)
    }

    private func subtitleInfo(for trackID: Int) -> (any SubtitleInfo)? {
        if let external = externalSubtitleInfos[trackID] {
            return external
        }
        return player?.subtitleDataSouce?.infos.first {
            $0.subtitleID == String(trackID)
        }
    }

    private func nextExternalSubtitleID() -> Int {
        // `-1` is the public Off sentinel. Keep externally-added subtitles in
        // a disjoint negative range and avoid IDs exposed by the decoder.
        let embeddedIDs = Set(player?.tracks(mediaType: .subtitle).map { Int($0.trackID) } ?? [])
        var candidate = -2
        while externalSubtitleInfos[candidate] != nil || embeddedIDs.contains(candidate) {
            candidate -= 1
        }
        return candidate
    }

    private func subtitleURL(from raw: String) -> URL? {
        let expanded = (raw as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded)
        }
        guard let url = URL(string: raw), url.scheme != nil else {
            return nil
        }
        return url
    }

    private func beginSeek(to target: Double, player: KSMEPlayer) {
        seekGeneration &+= 1
        let generation = seekGeneration
        pendingSeek = PendingSeek(generation: generation, latestTarget: nil)
        lastSeekError = nil
        state = .seeking
        scheduleSeekTimeout(for: generation)

        if let delay = consumeTestLateCompletionDelay() {
            // This harness-only path retains the session until the delayed
            // callback runs, so disposal exercises the disposed-state guard.
            player.seek(time: target) { [self] succeeded in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
                    self.completeSeek(generation: generation, succeeded: succeeded)
                }
            }
        } else {
            player.seek(time: target) { [weak self] succeeded in
                // KSPlayer invokes this after its decoder/renderer work. Hop back
                // to the actor without making the Electron/N-API call wait.
                Task { @MainActor [weak self] in
                    self?.completeSeek(generation: generation, succeeded: succeeded)
                }
            }
        }
    }

    private func completeSeek(generation: UInt64, succeeded: Bool) {
        guard
            state != .disposed,
            let pendingSeek,
            pendingSeek.generation == generation,
            let player
        else {
            if isHarnessTestSession {
                testIgnoredCompletionCount += 1
            }
            return
        }

        cancelSeekTimeout()
        self.pendingSeek = nil

        if let latestTarget = pendingSeek.latestTarget {
            if !succeeded {
                lastSeekError = "KSPlayer Metal could not complete an earlier seek; attempting the latest requested position."
            }
            beginSeek(to: latestTarget, player: player)
            return
        }

        if succeeded {
            lastSeekError = nil
        } else {
            lastSeekError = "KSPlayer Metal could not complete the seek; playback was restored."
        }
        restorePlaybackIntent(on: player)
    }

    private func scheduleSeekTimeout(for generation: UInt64) {
        cancelSeekTimeout()
        let workItem = DispatchWorkItem { [weak self] in
            Task { @MainActor [weak self] in
                self?.handleSeekTimeout(generation: generation)
            }
        }
        seekTimeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + seekTimeout,
            execute: workItem
        )
    }

    private func handleSeekTimeout(generation: UInt64) {
        guard
            state != .disposed,
            let pendingSeek,
            pendingSeek.generation == generation
        else {
            return
        }

        // A timed-out FFmpeg seek cannot be cancelled through KSPlayer's
        // public API. Recreate the source instead of leaving its read thread
        // wedged in `.seeking`; the generation invalidates any late callback.
        self.pendingSeek = nil
        cancelSeekTimeout()
        seekGeneration &+= 1
        if isHarnessTestSession {
            testTimeoutRecoveryCount += 1
        }
        let recoveryMessage = "KSPlayer Metal seek timed out; the source was reloaded to recover playback."

        guard let loadedURL else {
            lastError = "KSPlayer Metal seek timed out and no loaded source is available for recovery."
            state = .error
            return
        }

        let recovery = load(
            url: loadedURL,
            headers: loadedHeaders,
            subtitleURL: loadedSubtitleURL
        )
        if recovery.ok {
            lastSeekError = recoveryMessage
        } else {
            lastError = "KSPlayer Metal seek timed out and source recovery failed: \(recovery.reason ?? "unknown error")"
            state = .error
        }
    }

    private func consumeTestLateCompletionDelay() -> DispatchTimeInterval? {
        guard
            isHarnessTestSession,
            testLateCompletionBudget > 0,
            let milliseconds = Self.testLateCompletionDelayMilliseconds
        else {
            return nil
        }
        testLateCompletionBudget -= 1
        return .milliseconds(milliseconds)
    }

    private func restorePlaybackIntent(on player: KSMEPlayer) {
        if requestedPaused == true {
            player.pause()
            state = .paused
        } else {
            player.play()
            state = player.loadState == .playable ? .playing : .loading
        }
    }

    private func applyDisplayMode(to player: KSMEPlayer) {
        player.contentMode = requestedDisplayMode == "fill"
            ? .scaleAspectFill
            : .scaleAspectFit
    }

    private func applyPictureSettings() {
        guard let metalPlayView = KSPlayerMetalEmbeddingLayout.findMetalPlayView(in: playerView) as? MetalPlayView else {
            return
        }
        metalPlayView.setPictureAdjustments(
            brightness: Float(pictureSettings.brightness),
            contrast: Float(pictureSettings.contrast),
            blackLevel: Float(pictureSettings.blackLevel),
            saturation: Float(pictureSettings.saturation),
            gamma: Float(pictureSettings.gamma)
        )
    }

    private func cancelSeekTimeout() {
        seekTimeoutWorkItem?.cancel()
        seekTimeoutWorkItem = nil
    }

    private func invalidatePendingSeek() {
        seekGeneration &+= 1
        pendingSeek = nil
        cancelSeekTimeout()
    }

    private func detachPlayer() {
        invalidatePendingSeek()
        subtitleUpdateTimer?.invalidate()
        subtitleUpdateTimer = nil
        displayedSubtitlePart = nil
        subtitleView?.removeFromSuperview()
        subtitleView = nil
        externalSubtitleInfos.removeAll()
        selectedSubtitleTrackID = nil
        let attachedPlayerView = playerView ?? player?.view
        let attachedContainerView = containerView
        KSPlayerMetalEmbeddingLayout.detach(
            attachedPlayerView,
            from: attachedContainerView,
            hostView: hostView,
            childCounts: &childCounts
        )
        lastEmbeddingDiagnostic = KSPlayerMetalEmbeddingLayout.liveDiagnostic(
            sessionId: id,
            phase: "disposed",
            requestedBounds: bounds,
            hostView: hostView,
            containerView: attachedContainerView,
            playerView: attachedPlayerView,
            childCounts: childCounts,
            reason: lastError
        )
        playerView = nil
        containerView = nil
        guard let player else {
            options = nil
            return
        }
        player.delegate = nil
        player.shutdown()
        self.player = nil
        options = nil
    }

    func embeddingDiagnostic() -> LiveEmbeddingDiagnostic {
        if state == .disposed, let lastEmbeddingDiagnostic {
            return lastEmbeddingDiagnostic
        }
        return KSPlayerMetalEmbeddingLayout.liveDiagnostic(
            sessionId: id,
            phase: containerView == nil ? "created" : "attached",
            requestedBounds: bounds,
            hostView: hostView,
            containerView: containerView,
            playerView: playerView,
            childCounts: childCounts,
            reason: lastError
        )
    }

    private func reconcileEmbeddingState() {
        guard
            state != .disposed,
            let containerView,
            let playerView,
            playerView.superview !== containerView
        else {
            return
        }
        // KSMEPlayer can asynchronously remove its output when a source fails
        // or exposes no video. Keep the overlay in place for inspection, but
        // surface that failed attachment through the regular session snapshot.
        lastError = "KSPlayer Metal player view detached from its dedicated container."
        state = .error
    }

    private func codecName(from track: MediaPlayerTrack?) -> String? {
        guard let track else { return nil }
        if let ffmpegTrack = track as? FFmpegAssetTrack {
            return nonEmpty(ffmpegTrack.codecName)
        }
        return nil
    }
}

@MainActor
private final class KSPlayerMetalRuntime {
    static let shared = KSPlayerMetalRuntime()

    private var sessions: [String: KSPlayerMetalSession] = [:]
    // Retain the most recent teardown evidence so callers can prove that a
    // closed session removed both its player view and its host container.
    private var lastEmbeddingDiagnostic: LiveEmbeddingDiagnostic?
    // Harness-only sessions are retained until a deliberately delayed callback
    // has run, allowing the disposed-state guard to be observed deterministically.
    private var disposedTestSessions: [String: KSPlayerMetalSession] = [:]

    private init() {}

    func getSupport() -> Support {
        #if arch(arm64)
        guard MTLCreateSystemDefaultDevice() != nil else {
            return Support(
                supported: false,
                reason: "No Metal device is available on this Mac.",
                architecture: "arm64"
            )
        }
        return Support(supported: true, reason: nil, architecture: "arm64")
        #else
        return Support(
            supported: false,
            reason: "KSPlayer Metal requires an arm64 process.",
            architecture: "unsupported"
        )
        #endif
    }

    func prepare() -> Support {
        let support = getSupport()
        guard support.supported else {
            return support
        }
        guard let device = MTLCreateSystemDefaultDevice() else {
            return Support(
                supported: false,
                reason: "No Metal device is available on this Mac.",
                architecture: "arm64"
            )
        }
        // A packaged app must resolve this from Contents/Resources. Failing
        // early keeps KSPlayer's internal `.module` fallback from reaching its
        // generated SwiftPM accessor (which only knows the build-tree path).
        // Development runs intentionally use that fallback because they do not
        // have the host app's packaged resource directory yet.
        if device.makeDefaultLibrary() == nil,
           let resourceURL = Bundle.main.resourceURL,
           FileManager.default.fileExists(
               atPath: resourceURL
                   .appendingPathComponent("KSPlayer_KSPlayer.bundle")
                   .appendingPathComponent("Contents/Resources/default.metallib")
                   .path
           ) {
            return Support(
                supported: false,
                reason: "The packaged KSPlayer default.metallib could not be loaded by Metal.",
                architecture: "arm64"
            )
        }
        // This is the one renderer selection point. MetalOnlyOptions forces
        // MetalPlayView's CAMetalLayer path instead of AVSampleBufferDisplayLayer.
        KSOptions.videoPlayerType = MetalPlayView.self
        return support
    }

    func diagnoseEmbedding() -> EmbeddingDiagnostic {
        KSPlayerMetalEmbeddingLayout.diagnose()
    }

    func createSession(
        id: String,
        electronParentView: UnsafeMutableRawPointer?,
        bounds: Bounds
    ) -> OperationResult {
        guard !id.isEmpty else {
            return .failure("Session id cannot be empty.")
        }
        guard getSupport().supported else {
            return .failure("KSPlayer Metal is unsupported on this host.", sessionId: id)
        }
        guard let electronParentView else {
            return .failure("Electron native view handle is unavailable.", sessionId: id)
        }

        if let existing = sessions.removeValue(forKey: id) {
            existing.dispose()
            lastEmbeddingDiagnostic = existing.embeddingDiagnostic()
        }
        disposedTestSessions.removeValue(forKey: id)

        // The N-API bridge resolves Electron's opaque view handle to the
        // BrowserWindow content view before crossing this ABI. Bounds are
        // therefore already expressed in this view's coordinate system.
        let hostView = Unmanaged<NSView>
            .fromOpaque(electronParentView)
            .takeUnretainedValue()
        let session = KSPlayerMetalSession(
            id: id,
            hostView: hostView,
            bounds: bounds
        )
        sessions[id] = session
        return .success(sessionId: id, snapshot: session.snapshot())
    }

    func load(id: String, urlString: String, headersJSON: String?) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        guard let url = playbackURL(from: urlString) else {
            return .failure("Playback URL is invalid.", sessionId: id, snapshot: session.snapshot())
        }
        return session.load(url: url, headers: parseHeaders(headersJSON))
    }

    func setBounds(id: String, bounds: Bounds) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setBounds(bounds)
    }

    func setPaused(id: String, paused: Bool) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setPaused(paused)
    }

    func seek(id: String, seconds: Double) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.seek(seconds)
    }

    func setVolume(id: String, volume: Double) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setVolume(volume)
    }

    func setAudioTrack(id: String, trackID: Double) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setAudioTrack(trackID)
    }

    func setSubtitleTrack(id: String, trackID: Double) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setSubtitleTrack(trackID)
    }

    func setSubtitleFile(id: String, rawURL: String) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setSubtitleFile(rawURL)
    }

    func setSubtitleSettings(id: String, json: String) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setSubtitleSettings(json)
    }

    func setPlaybackSpeed(id: String, speed: Double) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setPlaybackSpeed(speed)
    }

    func setDisplayMode(id: String, mode: String) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setDisplayMode(mode)
    }

    func setAspect(id: String, aspect: String) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setAspect(aspect)
    }

    func setPicture(id: String, json: String) -> OperationResult {
        guard let session = sessions[id] else {
            return .failure("KSPlayer session was not found.", sessionId: id)
        }
        return session.setPicture(json)
    }

    func getSupportedControls(id _: String?) -> Controls {
        Controls(
            pause: true,
            seek: true,
            volume: true,
            audioTracks: true,
            subtitles: true,
            playbackSpeed: true,
            displayMode: true,
            aspectOverride: true,
            pictureAdjustments: true
        )
    }

    func getSnapshot(id: String) -> Snapshot {
        guard let session = sessions[id] else {
            return Snapshot.error(
                "KSPlayer session was not found.",
                seekTestEvidence: disposedTestSessions[id]?.seekTestEvidence
            )
        }
        return session.snapshot()
    }

    func getEmbeddingDiagnostic(id: String?) -> LiveEmbeddingDiagnostic {
        if let id {
            if let session = sessions[id] {
                return session.embeddingDiagnostic()
            }
            if lastEmbeddingDiagnostic?.sessionId == id {
                return lastEmbeddingDiagnostic!
            }
            return .unavailable("KSPlayer session was not found.")
        }
        if let session = sessions.values.first {
            return session.embeddingDiagnostic()
        }
        return lastEmbeddingDiagnostic ?? .unavailable("No KSPlayer embedding diagnostic is available.")
    }

    func disposeSession(id: String) -> OperationResult {
        guard let session = sessions.removeValue(forKey: id) else {
            return .success(sessionId: id)
        }
        session.dispose()
        if session.seekTestEvidence != nil {
            disposedTestSessions[id] = session
        }
        lastEmbeddingDiagnostic = session.embeddingDiagnostic()
        return .success(sessionId: id)
    }

    func disposeAll() -> OperationResult {
        let values = sessions.values
        sessions.removeAll()
        for session in values {
            session.dispose()
            if session.seekTestEvidence != nil {
                disposedTestSessions[session.id] = session
            }
            lastEmbeddingDiagnostic = session.embeddingDiagnostic()
        }
        return .success()
    }

    private func playbackURL(from value: String) -> URL? {
        guard !value.isEmpty else { return nil }
        if let url = URL(string: value), url.scheme != nil {
            return url
        }
        if value.hasPrefix("/") {
            return URL(fileURLWithPath: value)
        }
        return nil
    }

    private func parseHeaders(_ json: String?) -> [String: String] {
        guard let json, let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let objectHeaders = object as? [String: Any]
        else {
            return [:]
        }

        return objectHeaders.reduce(into: [:]) { result, item in
            guard let value = item.value as? String, !item.key.isEmpty else {
                return
            }
            result[item.key] = value
        }
    }
}

private func finiteValue(_ value: Double) -> Double? {
    value.isFinite ? value : nil
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}

private final class MainResultBox: @unchecked Sendable {
    var value: String?
}

private func encodedJSON<Value: Encodable>(_ value: Value) -> String {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(value),
          let string = String(data: data, encoding: .utf8)
    else {
        return "{\"ok\":false,\"backend\":\"ksplayer-metal\",\"reason\":\"Failed to encode KSPlayer Metal runtime result.\"}"
    }
    return string
}

private func copiedCString(_ value: String) -> UnsafeMutablePointer<CChar>? {
    value.withCString { strdup($0) }
}

private func stringArgument(_ value: UnsafePointer<CChar>?) -> String? {
    guard let value else { return nil }
    return String(validatingUTF8: value)
}

private func invokeOnMain(_ operation: @escaping @MainActor () -> String) -> UnsafeMutablePointer<CChar>? {
    let result: String
    if Thread.isMainThread {
        result = MainActor.assumeIsolated { operation() }
    } else {
        let box = MainResultBox()
        DispatchQueue.main.sync {
            box.value = MainActor.assumeIsolated { operation() }
        }
        result = box.value ?? encodedJSON(OperationResult.failure("Main actor invocation did not return a result."))
    }
    return copiedCString(result)
}

private func operationFailure(_ reason: String, sessionId: String? = nil) -> String {
    encodedJSON(OperationResult.failure(reason, sessionId: sessionId))
}

@_cdecl("ksplayer_metal_abi_version")
public func ksplayer_metal_abi_version() -> UnsafePointer<CChar>? {
    UnsafePointer(abiVersionCString)
}

@_cdecl("ksplayer_metal_get_support")
public func ksplayer_metal_get_support() -> UnsafeMutablePointer<CChar>? {
    invokeOnMain { encodedJSON(KSPlayerMetalRuntime.shared.getSupport()) }
}

@_cdecl("ksplayer_metal_prepare")
public func ksplayer_metal_prepare() -> UnsafeMutablePointer<CChar>? {
    invokeOnMain { encodedJSON(KSPlayerMetalRuntime.shared.prepare()) }
}

@_cdecl("ksplayer_metal_diagnose_embedding")
public func ksplayer_metal_diagnose_embedding() -> UnsafeMutablePointer<CChar>? {
    invokeOnMain { encodedJSON(KSPlayerMetalRuntime.shared.diagnoseEmbedding()) }
}

@_cdecl("ksplayer_metal_get_embedding_diagnostic")
public func ksplayer_metal_get_embedding_diagnostic(
    _ sessionID: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    let sessionID = stringArgument(sessionID).flatMap { $0.isEmpty ? nil : $0 }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.getEmbeddingDiagnostic(id: sessionID))
    }
}

@_cdecl("ksplayer_metal_create_session")
public func ksplayer_metal_create_session(
    _ sessionID: UnsafePointer<CChar>?,
    _ electronParentView: UnsafeMutableRawPointer?,
    _ x: Double,
    _ y: Double,
    _ width: Double,
    _ height: Double
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(
            KSPlayerMetalRuntime.shared.createSession(
                id: sessionID,
                electronParentView: electronParentView,
                bounds: Bounds(x: x, y: y, width: width, height: height)
            )
        )
    }
}

@_cdecl("ksplayer_metal_load")
public func ksplayer_metal_load(
    _ sessionID: UnsafePointer<CChar>?,
    _ url: UnsafePointer<CChar>?,
    _ headersJSON: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID), let url = stringArgument(url) else {
        return copiedCString(operationFailure("Session id and URL must be valid UTF-8."))
    }
    let headers = stringArgument(headersJSON)
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.load(id: sessionID, urlString: url, headersJSON: headers))
    }
}

@_cdecl("ksplayer_metal_set_bounds")
public func ksplayer_metal_set_bounds(
    _ sessionID: UnsafePointer<CChar>?,
    _ x: Double,
    _ y: Double,
    _ width: Double,
    _ height: Double
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(
            KSPlayerMetalRuntime.shared.setBounds(
                id: sessionID,
                bounds: Bounds(x: x, y: y, width: width, height: height)
            )
        )
    }
}

@_cdecl("ksplayer_metal_set_paused")
public func ksplayer_metal_set_paused(
    _ sessionID: UnsafePointer<CChar>?,
    _ paused: Int32
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setPaused(id: sessionID, paused: paused != 0))
    }
}

@_cdecl("ksplayer_metal_seek")
public func ksplayer_metal_seek(
    _ sessionID: UnsafePointer<CChar>?,
    _ seconds: Double
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.seek(id: sessionID, seconds: seconds))
    }
}

@_cdecl("ksplayer_metal_set_volume")
public func ksplayer_metal_set_volume(
    _ sessionID: UnsafePointer<CChar>?,
    _ volume: Double
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setVolume(id: sessionID, volume: volume))
    }
}

@_cdecl("ksplayer_metal_set_audio_track")
public func ksplayer_metal_set_audio_track(
    _ sessionID: UnsafePointer<CChar>?,
    _ trackID: Double
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setAudioTrack(id: sessionID, trackID: trackID))
    }
}

@_cdecl("ksplayer_metal_set_subtitle_track")
public func ksplayer_metal_set_subtitle_track(
    _ sessionID: UnsafePointer<CChar>?,
    _ trackID: Double
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setSubtitleTrack(id: sessionID, trackID: trackID))
    }
}

@_cdecl("ksplayer_metal_set_subtitle_file")
public func ksplayer_metal_set_subtitle_file(
    _ sessionID: UnsafePointer<CChar>?,
    _ rawURL: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID),
          let rawURL = stringArgument(rawURL) else {
        return copiedCString(operationFailure("Session id and subtitle URL must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setSubtitleFile(id: sessionID, rawURL: rawURL))
    }
}

@_cdecl("ksplayer_metal_set_subtitle_settings")
public func ksplayer_metal_set_subtitle_settings(
    _ sessionID: UnsafePointer<CChar>?,
    _ settingsJSON: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID),
          let settingsJSON = stringArgument(settingsJSON) else {
        return copiedCString(operationFailure("Session id and subtitle settings must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setSubtitleSettings(id: sessionID, json: settingsJSON))
    }
}

@_cdecl("ksplayer_metal_set_playback_speed")
public func ksplayer_metal_set_playback_speed(
    _ sessionID: UnsafePointer<CChar>?,
    _ speed: Double
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setPlaybackSpeed(id: sessionID, speed: speed))
    }
}

@_cdecl("ksplayer_metal_set_display_mode")
public func ksplayer_metal_set_display_mode(
    _ sessionID: UnsafePointer<CChar>?,
    _ mode: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID),
          let mode = stringArgument(mode) else {
        return copiedCString(operationFailure("Session id and display mode must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setDisplayMode(id: sessionID, mode: mode))
    }
}

@_cdecl("ksplayer_metal_set_aspect")
public func ksplayer_metal_set_aspect(
    _ sessionID: UnsafePointer<CChar>?,
    _ aspect: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID),
          let aspect = stringArgument(aspect) else {
        return copiedCString(operationFailure("Session id and aspect override must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setAspect(id: sessionID, aspect: aspect))
    }
}

@_cdecl("ksplayer_metal_set_picture")
public func ksplayer_metal_set_picture(
    _ sessionID: UnsafePointer<CChar>?,
    _ pictureJSON: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID),
          let pictureJSON = stringArgument(pictureJSON) else {
        return copiedCString(operationFailure("Session id and picture settings must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.setPicture(id: sessionID, json: pictureJSON))
    }
}

@_cdecl("ksplayer_metal_get_supported_controls")
public func ksplayer_metal_get_supported_controls(
    _ sessionID: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    let sessionID = stringArgument(sessionID)
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.getSupportedControls(id: sessionID))
    }
}

@_cdecl("ksplayer_metal_get_snapshot")
public func ksplayer_metal_get_snapshot(
    _ sessionID: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(encodedJSON(Snapshot.error("Session id must be valid UTF-8.")))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.getSnapshot(id: sessionID))
    }
}

@_cdecl("ksplayer_metal_dispose_session")
public func ksplayer_metal_dispose_session(
    _ sessionID: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    guard let sessionID = stringArgument(sessionID) else {
        return copiedCString(operationFailure("Session id must be valid UTF-8."))
    }
    return invokeOnMain {
        encodedJSON(KSPlayerMetalRuntime.shared.disposeSession(id: sessionID))
    }
}

@_cdecl("ksplayer_metal_dispose_all")
public func ksplayer_metal_dispose_all() -> UnsafeMutablePointer<CChar>? {
    invokeOnMain { encodedJSON(KSPlayerMetalRuntime.shared.disposeAll()) }
}

@_cdecl("ksplayer_metal_free_string")
public func ksplayer_metal_free_string(_ value: UnsafeMutablePointer<CChar>?) {
    if let value {
        free(value)
    }
}
