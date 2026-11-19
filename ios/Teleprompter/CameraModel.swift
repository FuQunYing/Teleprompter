import AVFoundation
import Photos
import SwiftUI

/// 前置摄像头 + 麦克风，用系统录像组件直接写文件，录完存相册。
final class CameraModel: NSObject, ObservableObject {
    @Published private(set) var isReady = false
    @Published private(set) var isRecording = false
    @Published var message: String?

    let session = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "teleprompter.camera")
    private var configured = false

    func start() {
        Task {
            let videoAllowed = await AVCaptureDevice.requestAccess(for: .video)
            let audioAllowed = await AVCaptureDevice.requestAccess(for: .audio)
            guard videoAllowed else {
                show("请在「设置」里允许提词器使用相机")
                return
            }
            if !audioAllowed { show("没有麦克风权限，录像将没有声音") }

            queue.async {
                if !self.configured { self.configure(withAudio: audioAllowed) }
                if self.configured && !self.session.isRunning { self.session.startRunning() }
                let ready = self.configured
                DispatchQueue.main.async { self.isReady = ready }
            }
        }
    }

    func toggleRecording() {
        if isRecording { stopRecording() } else { startRecording() }
    }

    private func startRecording() {
        guard isReady else { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("teleprompter-\(UUID().uuidString).mov")
        queue.async {
            guard !self.movieOutput.isRecording else { return }
            self.movieOutput.startRecording(to: url, recordingDelegate: self)
        }
    }

    private func stopRecording() {
        queue.async {
            if self.movieOutput.isRecording { self.movieOutput.stopRecording() }
        }
    }

    private func configure(withAudio: Bool) {
        session.beginConfiguration()
        session.sessionPreset = .high

        guard
            let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
            let cameraInput = try? AVCaptureDeviceInput(device: camera),
            session.canAddInput(cameraInput)
        else {
            session.commitConfiguration()
            show("无法打开前置摄像头")
            return
        }
        session.addInput(cameraInput)

        if withAudio,
           let mic = AVCaptureDevice.default(for: .audio),
           let micInput = try? AVCaptureDeviceInput(device: mic),
           session.canAddInput(micInput) {
            session.addInput(micInput)
        }

        guard session.canAddOutput(movieOutput) else {
            session.commitConfiguration()
            show("无法录像")
            return
        }
        session.addOutput(movieOutput)

        if let connection = movieOutput.connection(with: .video) {
            // App 只支持竖屏，成片固定为竖屏
            if connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }
            // 和预览一致：前置镜头录出来是镜像的
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = true
            }
        }

        session.commitConfiguration()
        // sessionPreset 会在提交配置时重置帧率，所以要在 commit 之后锁
        lockFrameRate(camera, fps: 30)
        configured = true
    }

    /// 固定 30 帧，避免暗光下自动降帧导致可变帧率。
    private func lockFrameRate(_ device: AVCaptureDevice, fps: Int32) {
        let duration = CMTime(value: 1, timescale: fps)
        let supported = device.activeFormat.videoSupportedFrameRateRanges.contains {
            $0.minFrameDuration <= duration && duration <= $0.maxFrameDuration
        }
        guard supported, (try? device.lockForConfiguration()) != nil else { return }
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
        device.unlockForConfiguration()
    }

    private func saveToPhotos(_ url: URL) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                try? FileManager.default.removeItem(at: url)
                self.show("没有相册权限，视频未保存")
                return
            }
            PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
            } completionHandler: { success, error in
                try? FileManager.default.removeItem(at: url)
                self.show(success ? "已保存到相册" : "保存失败：\(error?.localizedDescription ?? "未知错误")")
            }
        }
    }

    private func show(_ text: String) {
        DispatchQueue.main.async { self.message = text }
    }
}

extension CameraModel: AVCaptureFileOutputRecordingDelegate {
    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        from connections: [AVCaptureConnection]
    ) {
        DispatchQueue.main.async { self.isRecording = true }
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        DispatchQueue.main.async { self.isRecording = false }

        // 来电、切到后台等情况会带 error 结束，但文件仍然完整可用
        if let error {
            let finished = (error as NSError).userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false
            if !finished {
                try? FileManager.default.removeItem(at: outputFileURL)
                show("录制失败：\(error.localizedDescription)")
                return
            }
        }
        saveToPhotos(outputFileURL)
    }
}
