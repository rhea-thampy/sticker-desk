// Draws the app icon: a die-cut sticker with its corner peeling up, on a warm tile.
// Usage: swift icon.swift AppIcon.iconset   (build.sh then runs iconutil on it)

import Cocoa

func drawIcon(_ s: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(s), pixelsHigh: Int(s), bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let c = NSGraphicsContext.current!.cgContext
    let u = s / 1024

    // Tile, inset like the standard macOS icon grid.
    let tile = CGRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u)
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: -10 * u), blur: 24 * u, color: NSColor.black.withAlphaComponent(0.28).cgColor)
    c.addPath(CGPath(roundedRect: tile, cornerWidth: 185 * u, cornerHeight: 185 * u, transform: nil))
    c.setFillColor(NSColor.white.cgColor)
    c.fillPath()
    c.restoreGState()
    c.saveGState()
    c.addPath(CGPath(roundedRect: tile, cornerWidth: 185 * u, cornerHeight: 185 * u, transform: nil))
    c.clip()
    let bg = CGGradient(colorsSpace: nil, colors: [
        NSColor(red: 1.0, green: 0.80, blue: 0.45, alpha: 1).cgColor,
        NSColor(red: 1.0, green: 0.42, blue: 0.55, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 1])!
    c.drawLinearGradient(bg, start: CGPoint(x: tile.minX, y: tile.maxY), end: CGPoint(x: tile.maxX, y: tile.minY), options: [])
    c.restoreGState()

    // The sticker: a rounded square, tilted, with its bottom-right corner folded back.
    c.saveGState()
    c.translateBy(x: 512 * u, y: 512 * u)
    c.rotate(by: 8 * .pi / 180)
    let half = 250 * u, r = 70 * u, fold = 190 * u
    let body = CGMutablePath()
    body.move(to: CGPoint(x: -half + r, y: half))
    body.addArc(tangent1End: CGPoint(x: half, y: half), tangent2End: CGPoint(x: half, y: -half), radius: r)
    body.addLine(to: CGPoint(x: half, y: -half + fold))
    body.addLine(to: CGPoint(x: half - fold, y: -half))
    body.addArc(tangent1End: CGPoint(x: -half, y: -half), tangent2End: CGPoint(x: -half, y: half), radius: r)
    body.addArc(tangent1End: CGPoint(x: -half, y: half), tangent2End: CGPoint(x: half, y: half), radius: r)
    body.closeSubpath()

    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: -14 * u), blur: 30 * u, color: NSColor.black.withAlphaComponent(0.25).cgColor)
    c.addPath(body)
    c.setFillColor(NSColor.white.cgColor)
    c.fillPath()
    c.restoreGState()

    // Artwork inside the white die-cut border.
    c.saveGState()
    c.addPath(body)
    c.clip()
    let inner = CGRect(x: -half + 42 * u, y: -half + 42 * u, width: 2 * half - 84 * u, height: 2 * half - 84 * u)
    c.addPath(CGPath(roundedRect: inner, cornerWidth: 40 * u, cornerHeight: 40 * u, transform: nil))
    c.clip()
    let art = CGGradient(colorsSpace: nil, colors: [
        NSColor(red: 0.55, green: 0.85, blue: 1.0, alpha: 1).cgColor,
        NSColor(red: 0.62, green: 0.55, blue: 1.0, alpha: 1).cgColor,
        NSColor(red: 1.0, green: 0.6, blue: 0.85, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 0.55, 1])!
    c.drawLinearGradient(art, start: CGPoint(x: inner.minX, y: inner.maxY), end: CGPoint(x: inner.maxX, y: inner.minY), options: [])
    // A star in the middle.
    let star = CGMutablePath()
    for i in 0..<10 {
        let a = CGFloat(i) * .pi / 5 + .pi / 2, rad = (i % 2 == 0 ? 120 : 52) * u
        let p = CGPoint(x: cos(a) * rad - 10 * u, y: sin(a) * rad + 12 * u)
        i == 0 ? star.move(to: p) : star.addLine(to: p)
    }
    star.closeSubpath()
    c.addPath(star)
    c.setFillColor(NSColor.white.withAlphaComponent(0.95).cgColor)
    c.fillPath()
    // Shine.
    c.setFillColor(NSColor.white.withAlphaComponent(0.25).cgColor)
    c.move(to: CGPoint(x: inner.minX, y: inner.maxY - 90 * u))
    c.addLine(to: CGPoint(x: inner.minX + 120 * u, y: inner.maxY))
    c.addLine(to: CGPoint(x: inner.minX + 200 * u, y: inner.maxY))
    c.addLine(to: CGPoint(x: inner.minX, y: inner.maxY - 170 * u))
    c.fillPath()
    c.restoreGState()

    // The peeled flap: the cut-off corner reflected over the fold line, showing the paper back.
    let a = CGPoint(x: half, y: -half + fold), b = CGPoint(x: half - fold, y: -half)
    let tip = CGPoint(x: half - fold * 0.86, y: -half + fold * 0.86)
    let flap = CGMutablePath()
    flap.move(to: a)
    flap.addLine(to: b)
    flap.addQuadCurve(to: tip, control: CGPoint(x: half - fold * 1.0, y: -half + fold * 0.42))
    flap.addQuadCurve(to: a, control: CGPoint(x: half - fold * 0.42, y: -half + fold * 1.0))
    c.saveGState()
    c.setShadow(offset: CGSize(width: -6 * u, height: -10 * u), blur: 22 * u, color: NSColor.black.withAlphaComponent(0.3).cgColor)
    c.addPath(flap)
    c.setFillColor(NSColor(white: 0.93, alpha: 1).cgColor)
    c.fillPath()
    c.restoreGState()
    c.saveGState()
    c.addPath(flap)
    c.clip()
    let back = CGGradient(colorsSpace: nil, colors: [
        NSColor(white: 0.80, alpha: 1).cgColor, NSColor(white: 0.98, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 1])!
    c.drawLinearGradient(back, start: CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2), end: tip, options: [])
    c.restoreGState()
    c.restoreGState()

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(size)x\(size).png" : "icon_\(size)x\(size)@2x.png"
        let png = drawIcon(CGFloat(size * scale)).representation(using: .png, properties: [:])!
        try! png.write(to: out.appendingPathComponent(name))
    }
}
