import SwiftUI

/// 台词浮层：只显示在屏幕上，不会录进视频。开始录制后按固定速度向上滚动。
struct PrompterView: View {
    let text: String
    let fontSize: Double
    let speed: Double
    let startedAt: Date?

    @State private var textHeight: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(paused: startedAt == nil)) { context in
                Text(text.isEmpty ? "点下方「台词」输入内容，开始录制后会自动滚动" : text)
                    .font(.system(size: fontSize, weight: .semibold))
                    .lineSpacing(fontSize * 0.3)
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.9), radius: 2, y: 1)
                    .frame(width: geo.size.width, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(
                        GeometryReader { textGeo in
                            Color.clear.preference(key: TextHeightKey.self, value: textGeo.size.height)
                        }
                    )
                    .offset(y: -scrollOffset(at: context.date))
            }
        }
        .clipped()
        .onPreferenceChange(TextHeightKey.self) { textHeight = $0 }
    }

    private func scrollOffset(at date: Date) -> CGFloat {
        guard let startedAt else { return 0 }
        let scrolled = CGFloat(date.timeIntervalSince(startedAt) * speed)
        // 滚到最后两行停住，不让台词整个滚出去
        let limit = max(0, textHeight - CGFloat(fontSize) * 2)
        return min(scrolled, limit)
    }
}

private struct TextHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
