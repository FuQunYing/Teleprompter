import AVFoundation
import SwiftUI

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        override func layoutSubviews() {
            super.layoutSubviews()
            // 会话配置完成后才有 connection
            if let connection = previewLayer.connection,
               connection.isVideoRotationAngleSupported(90),
               connection.videoRotationAngle != 90 {
                connection.videoRotationAngle = 90
            }
        }
    }
}
