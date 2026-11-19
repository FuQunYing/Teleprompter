import SwiftUI

struct ScriptEditor: View {
    @Binding var script: String
    @Binding var speed: Double
    @Binding var fontSize: Double

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("台词") {
                    TextEditor(text: $script)
                        .frame(minHeight: 260)
                }
                Section("滚动速度：\(Int(speed))") {
                    Slider(value: $speed, in: 10...120, step: 5)
                }
                Section("字号：\(Int(fontSize))") {
                    Slider(value: $fontSize, in: 18...48, step: 1)
                }
            }
            .navigationTitle("台词")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}
