import Cocoa

// 生成 1024x1024 图标 PNG：渐变圆角底 + 白色 "M↓"
let size = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()

let rect = NSRect(x: 0, y: 0, width: size, height: size)
let path = NSBezierPath(roundedRect: rect.insetBy(dx: 40, dy: 40), xRadius: 210, yRadius: 210)
let grad = NSGradient(colors: [
    NSColor(srgbRed: 0.32, green: 0.36, blue: 0.92, alpha: 1),
    NSColor(srgbRed: 0.55, green: 0.30, blue: 0.86, alpha: 1)
])!
grad.draw(in: path, angle: -60)

let shadow = NSShadow()
shadow.shadowColor = NSColor(white: 0, alpha: 0.25)
shadow.shadowBlurRadius = 24
shadow.shadowOffset = NSSize(width: 0, height: -6)
shadow.set()

let para = NSMutableParagraphStyle()
para.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 520, weight: .bold),
    .foregroundColor: NSColor.white,
    .paragraphStyle: para,
]
let text = "M↓" as NSString
let tsize = text.size(withAttributes: attrs)
text.draw(in: NSRect(x: 0, y: (CGFloat(size) - tsize.height) / 2 + 40,
                     width: CGFloat(size), height: tsize.height), withAttributes: attrs)

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("icon render failed\n".data(using: .utf8)!)
    exit(1)
}
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
try! png.write(to: URL(fileURLWithPath: out))
print(out)
