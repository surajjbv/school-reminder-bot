// Text from an image (Vision OCR) or a PDF (text layer, OCR for scanned pages).
// Usage: extract <file>
import Foundation
import PDFKit
import Vision

func ocr(_ image: CGImage) -> String {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: image).perform([req])
    return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func render(_ page: PDFPage) -> CGImage? {
    let box = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2
    let w = Int(box.width * scale), h = Int(box.height * scale)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

let args = CommandLine.arguments
guard args.count == 2 else { FileHandle.standardError.write("usage: extract <file>\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])

if url.pathExtension.lowercased() == "pdf", let pdf = PDFDocument(url: url) {
    for i in 0..<min(pdf.pageCount, 20) {
        guard let page = pdf.page(at: i) else { continue }
        let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.count > 20 { print(text) } else if let img = render(page) { print(ocr(img)) }
    }
} else if let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
    print(ocr(img))
} else {
    FileHandle.standardError.write("unsupported file\n".data(using: .utf8)!)
    exit(1)
}
