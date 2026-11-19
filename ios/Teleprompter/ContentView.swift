import SwiftUI

struct ContentView: View {
    @StateObject private var camera = CameraModel()

    @AppStorage("script") private var script = ""
    @AppStorage("speed") private var speed = 40.0
    @AppStorage("fontSize") private var fontSize = 30.0

    @State private var showEditor = false
    @State private var startedAt: Date?

    var body: some View {
        ZStack {
            CameraPreview(session: camera.session)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                PrompterView(text: script, fontSize: fontSize, speed: speed, startedAt: startedAt)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .containerRelativeFrame(.vertical) { height, _ in height * 0.4 }
                    .background(Color.black.opacity(0.45).ignoresSafeArea(edges: .top))

                Spacer()

                controls
                    .padding(.bottom, 16)
            }

            if let message = camera.message {
                Text(message)
                    .font(.callout)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .transition(.opacity)
            }
        }
        .background(Color.black)
        .statusBarHidden()
        .animation(.easeInOut(duration: 0.2), value: camera.message)
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            camera.start()
        }
        .onChange(of: camera.isRecording) { _, recording in
            startedAt = recording ? Date() : nil
        }
        .task(id: camera.message) {
            guard camera.message != nil else { return }
            try? await Task.sleep(for: .seconds(2.5))
            camera.message = nil
        }
        .sheet(isPresented: $showEditor) {
            ScriptEditor(script: $script, speed: $speed, fontSize: $fontSize)
        }
    }

    private var controls: some View {
        HStack {
            Button {
                showEditor = true
            } label: {
                VStack(spacing: 4) {
                    Image(systemName: "text.alignleft")
                        .font(.title2)
                    Text("台词")
                        .font(.caption)
                }
                .foregroundStyle(.white)
            }
            .disabled(camera.isRecording)
            .opacity(camera.isRecording ? 0.3 : 1)
            .frame(width: 80)

            Spacer()

            recordButton

            Spacer()

            elapsedLabel
                .frame(width: 80)
        }
        .padding(.horizontal, 28)
    }

    private var recordButton: some View {
        Button {
            camera.toggleRecording()
        } label: {
            ZStack {
                Circle()
                    .stroke(.white, lineWidth: 4)
                    .frame(width: 76, height: 76)
                RoundedRectangle(cornerRadius: camera.isRecording ? 8 : 31)
                    .fill(.red)
                    .frame(
                        width: camera.isRecording ? 32 : 62,
                        height: camera.isRecording ? 32 : 62
                    )
            }
            .animation(.easeInOut(duration: 0.2), value: camera.isRecording)
        }
        .disabled(!camera.isReady)
        .opacity(camera.isReady ? 1 : 0.4)
    }

    @ViewBuilder
    private var elapsedLabel: some View {
        if let startedAt {
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                let seconds = max(0, Int(context.date.timeIntervalSince(startedAt)))
                Text(String(format: "%02d:%02d", seconds / 60, seconds % 60))
                    .font(.system(.body, design: .monospaced).weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(.red, in: Capsule())
            }
        } else {
            Color.clear.frame(height: 1)
        }
    }
}
