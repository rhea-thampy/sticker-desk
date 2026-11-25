// Sticker Desk — peelable stickers that live on your Mac desktop.
//
// The app window is the sticker maker. The stickers themselves live in a transparent,
// click-through layer that covers the screen and hosts the same <sticker-board> engine
// as the website. That layer only catches the mouse while the pointer is over a sticker,
// so the rest of the desktop works as normal.

import Cocoa
import UniformTypeIdentifiers
import WebKit

/// Serves the bundled web pages, plus imported image files, over stickerdesk://
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    var imports: [String: URL] = [:]

    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path
        let file: URL
        if path.hasPrefix("/import/"), let f = imports[String(path.dropFirst("/import/".count))] {
            file = f
        } else {
            file = root.appendingPathComponent(String(path.dropFirst()))
        }
        guard let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        let ext = file.pathExtension.lowercased()
        let mime = ext == "js" ? "text/javascript"
            : UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mime, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// Takes the first click even when another app is active, so stickers peel straight away.
final class StickerWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Can take key focus (Esc, scroll to rotate) without bringing the app forward.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    var panel: OverlayPanel!
    var deskWeb: StickerWebView!
    var window: NSWindow!
    var makerWeb: WKWebView!
    var scheme: SchemeHandler!
    var topItem: NSMenuItem!
    var pollTimer: Timer?
    var liftTimer: Timer?
    var lastMouse = NSPoint(x: -1, y: -1)
    var idleTicks = 0
    var hitInFlight = false
    var deskReady = false
    var makerReady = false
    var lifted = false
    var pendingImports: [URL] = []
    let defaults = UserDefaults.standard

    lazy var supportDir: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Sticker Desk")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    var stateFile: URL { supportDir.appendingPathComponent("desk.json") }

    var onTop: Bool {
        get { defaults.bool(forKey: "onTop") }
        set { defaults.set(newValue, forKey: "onTop") }
    }

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        scheme = SchemeHandler(root: Bundle.main.resourceURL!.appendingPathComponent("web"))
        buildDesk()
        buildWindow()
        buildMenu()
        startMousePolling()
        NotificationCenter.default.addObserver(
            self, selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        // Clicking anywhere off a sticker (another app, or this window) closes its finish toolbar.
        NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.desk("window.__sd && __sd.deselect()")
        }
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            if event.window !== self?.panel { self?.desk("window.__sd && __sd.deselect()") }
            return event
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        showWindow()
        urls.prefix(1).forEach(importFile) // the maker makes one sticker at a time
    }

    /// Clicking the Dock icon brings the sticker maker back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    /// Closing the window keeps the stickers on your desktop; quitting takes them away until next time.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    var deskFrame: NSRect { (NSScreen.screens.first ?? NSScreen.main!).visibleFrame }

    func webConfig(store: Bool) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: "stickerdesk")
        config.userContentController.add(self, name: "desk")
        config.userContentController.addUserScript(WKUserScript(
            source: (store ? storeScript() : "") + logScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        return config
    }

    /// The see-through layer over the desktop that the stickers live in.
    func buildDesk() {
        panel = OverlayPanel(contentRect: deskFrame, styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        applyLevel()

        deskWeb = StickerWebView(frame: NSRect(origin: .zero, size: deskFrame.size), configuration: webConfig(store: true))
        deskWeb.setValue(false, forKey: "drawsBackground")
        deskWeb.uiDelegate = self
        deskWeb.navigationDelegate = self
        if #available(macOS 13.3, *) { deskWeb.isInspectable = true }
        panel.contentView = deskWeb
        deskWeb.load(URLRequest(url: URL(string: "stickerdesk://app/desk.html")!))
        panel.orderFrontRegardless()
    }

    /// The app window: the sticker maker, plus a few controls for the desktop.
    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Sticker Desk"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 460, height: 640)
        window.center()
        window.setFrameAutosaveName("StickerMaker")

        makerWeb = WKWebView(frame: window.contentLayoutRect, configuration: webConfig(store: false))
        makerWeb.uiDelegate = self
        makerWeb.navigationDelegate = self
        if #available(macOS 13.3, *) { makerWeb.isInspectable = true }
        window.contentView = makerWeb
        makerWeb.load(URLRequest(url: URL(string: "stickerdesk://app/maker.html")!))
        window.makeKeyAndOrderFront(nil)
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The board saves through window.STICKER_STORE; we keep it in Application Support.
    func storeScript() -> String {
        let saved = (try? String(contentsOf: stateFile, encoding: .utf8)).map(jsString) ?? "null"
        return """
        window.__SD_SAVED = \(saved);
        window.STICKER_STORE = {
          get: () => window.__SD_SAVED,
          set: (k, v) => { window.__SD_SAVED = v; webkit.messageHandlers.desk.postMessage({ type: 'save', value: v }); },
          remove: () => { window.__SD_SAVED = null; webkit.messageHandlers.desk.postMessage({ type: 'save', value: null }); },
        };

        """
    }

    let logScript = """
    const __sdLog = (msg) => webkit.messageHandlers.desk.postMessage({ type: 'log', value: String(msg) });
    addEventListener('error', (e) => __sdLog(e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
    addEventListener('unhandledrejection', (e) => __sdLog('promise: ' + (e.reason && (e.reason.stack || e.reason))));
    for (const k of ['warn', 'error']) { const f = console[k]; console[k] = (...a) => { __sdLog(k + ': ' + a.join(' ')); f.apply(console, a); }; }
    """

    func applyLevel() {
        // Default: on the wallpaper, under every app window, like stickers on a desk.
        // A sticker you just made is lifted above everything for a moment so you see it land.
        panel.level = onTop || lifted
            ? .floating
            : NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    }

    func liftBriefly() {
        liftTimer?.invalidate()
        lifted = true
        applyLevel()
        liftTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] timer in
            guard let self, NSEvent.pressedMouseButtons == 0 else { return } // never drop a sticker mid-drag
            timer.invalidate()
            self.lifted = false
            self.applyLevel()
        }
    }

    @objc func screensChanged() {
        panel.setFrame(deskFrame, display: true)
    }

    // MARK: Click-through

    func startMousePolling() {
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.pollMouse() }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    /// Asks the board whether the pointer is over a sticker and only then lets the layer take clicks.
    func pollMouse() {
        guard deskReady, !hitInFlight else { return }
        let m = NSEvent.mouseLocation
        if m == lastMouse {
            idleTicks += 1
            if idleTicks % 10 != 0 { return }
        } else {
            idleTicks = 0
        }
        lastMouse = m
        let f = panel.frame
        hitInFlight = true
        deskWeb.evaluateJavaScript("window.__sd ? __sd.wants(\(m.x - f.minX), \(f.maxY - m.y)) : false") { [weak self] result, _ in
            guard let self else { return }
            self.hitInFlight = false
            let wants = (result as? Bool) ?? false
            if self.panel.ignoresMouseEvents == wants { self.panel.ignoresMouseEvents = !wants }
        }
    }

    // MARK: Menus

    func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let m = NSMenu(title: title)
            main.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = m
            return m
        }
        func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "",
                 _ mods: NSEvent.ModifierFlags = .command, mine: Bool = true) -> NSMenuItem {
            let i = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            if mine { i.target = self }
            return i
        }

        let app = submenu("Sticker Desk")
        _ = add(app, "About Sticker Desk", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), mine: false)
        app.addItem(.separator())
        _ = add(app, "Hide Sticker Desk", #selector(NSApplication.hide(_:)), "h", mine: false)
        _ = add(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], mine: false)
        _ = add(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)), mine: false)
        app.addItem(.separator())
        _ = add(app, "Quit Sticker Desk", #selector(NSApplication.terminate(_:)), "q", mine: false)

        let file = submenu("File")
        _ = add(file, "Make Sticker", #selector(makeSticker), "n")
        file.addItem(.separator())
        _ = add(file, "Close", #selector(NSWindow.performClose(_:)), "w", mine: false)

        // Needed for ⌘V to paste a photo into the maker.
        let edit = submenu("Edit")
        _ = add(edit, "Undo", Selector(("undo:")), "z", mine: false)
        _ = add(edit, "Redo", Selector(("redo:")), "z", [.command, .shift], mine: false)
        edit.addItem(.separator())
        _ = add(edit, "Cut", #selector(NSText.cut(_:)), "x", mine: false)
        _ = add(edit, "Copy", #selector(NSText.copy(_:)), "c", mine: false)
        _ = add(edit, "Paste", #selector(NSText.paste(_:)), "v", mine: false)
        _ = add(edit, "Select All", #selector(NSText.selectAll(_:)), "a", mine: false)

        let stickers = submenu("Stickers")
        _ = add(stickers, "Add Sample Stickers", #selector(addSamples))
        topItem = add(stickers, "Stick on Top of Windows", #selector(toggleTop), "t", [.command, .option])
        stickers.addItem(.separator())
        _ = add(stickers, "Peel All Stickers Off…", #selector(clearAll))

        let win = submenu("Window")
        _ = add(win, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m", mine: false)
        _ = add(win, "Zoom", #selector(NSWindow.performZoom(_:)), mine: false)
        win.addItem(.separator())
        _ = add(win, "Sticker Desk", #selector(showWindow), "0")
        NSApp.windowsMenu = win

        let help = submenu("Help")
        _ = add(help, "Sticker Desk Website", #selector(openWebsite))
        NSApp.helpMenu = help

        NSApp.mainMenu = main
        refreshState()
    }

    /// Keeps the menu and the window's footer in step with the desktop.
    func refreshState() {
        topItem.state = onTop ? .on : .off
        guard deskReady else { return }
        deskWeb.evaluateJavaScript("__sd.count()") { [weak self] result, _ in
            guard let self, self.makerReady else { return }
            let count = (result as? Int) ?? 0
            self.maker("window.setDesk && setDesk({ count: \(count), onTop: \(self.onTop) })")
        }
    }

    /// Back to a fresh sticker maker: drop in, browse for or paste a photo.
    @objc func makeSticker() {
        showWindow()
        maker("window.__maker && __maker.reset()")
    }

    @objc func addSamples() { desk("__sd.samples()") }

    @objc func toggleTop() {
        onTop.toggle()
        applyLevel()
        refreshState()
    }

    @objc func clearAll() {
        let alert = NSAlert()
        alert.messageText = "Peel all stickers off?"
        alert.informativeText = "Every sticker on your desktop will be removed."
        alert.addButton(withTitle: "Peel Them Off")
        alert.addButton(withTitle: "Cancel")
        showWindow()
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.desk("__sd.clear()") }
        }
    }

    // MARK: Importing

    /// Opens an image in the sticker maker, where you pick its finish and size.
    func importFile(_ url: URL) {
        guard makerReady else {
            pendingImports = [url]
            return
        }
        let id = UUID().uuidString
        scheme.imports[id] = url
        maker("__maker.import('stickerdesk://app/import/\(id)', \(jsString(url.lastPathComponent)))")
    }

    // MARK: Saving

    /// Download: saves a sticker (a PNG data URL from the page) wherever you choose, Downloads by default.
    func saveSticker(_ src: String, name: String, fromMaker: Bool) {
        guard let comma = src.firstIndex(of: ","), let data = Data(base64Encoded: String(src[src.index(after: comma)...])) else {
            return log("download: not a data URL")
        }
        if let dir = ProcessInfo.processInfo.environment["STICKERDESK_DEBUG"] { // tests save without a dialog
            try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
            return log("download: saved \(name) (\(data.count) bytes)")
        }
        let p = NSSavePanel()
        p.allowedContentTypes = [.png]
        p.nameFieldStringValue = name
        p.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        p.message = "Save your sticker as a transparent PNG image."
        let save: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let url = p.url else { return }
            do {
                try data.write(to: url)
            } catch {
                self?.log("download failed: \(error)")
                NSAlert(error: error).runModal()
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        if fromMaker && window.isVisible {
            p.beginSheetModal(for: window, completionHandler: save)
        } else {
            // From a sticker on the desktop: the dialog must sit above the sticker layer, which may be floating.
            p.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
            p.begin(completionHandler: save)
        }
    }

    // MARK: Web views

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Belt and braces: make sure the board's module has run (it then sends "ready").
        webView.evaluateJavaScript(
            "if (!window.__sd && !window.__maker) import('./sticker-board.js').catch((e) => __sdLog('module failed: ' + e))")
    }

    func ready(_ webView: WKWebView?) {
        if webView === makerWeb {
            guard !makerReady else { return }
            makerReady = true
            pendingImports.forEach(importFile)
            pendingImports = []
        } else {
            guard !deskReady else { return }
            deskReady = true
            if !defaults.bool(forKey: "launchedBefore") {
                defaults.set(true, forKey: "launchedBefore")
                desk("__sd.samples()")
            }
        }
        refreshState()
        if let dir = ProcessInfo.processInfo.environment["STICKERDESK_DEBUG"], webView === makerWeb { startDebugging(dir) }
    }

    /// Debugging aid: STICKERDESK_DEBUG=/some/dir writes both views to desk.png and maker.png every
    /// few seconds, runs (then deletes) maker.js or desk.js if you put one there, and saves downloads there.
    func startDebugging(_ dir: String) {
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            for (name, view) in [("desk", self.deskWeb as WKWebView), ("maker", self.makerWeb!)] {
                let script = URL(fileURLWithPath: dir).appendingPathComponent("\(name).js")
                if let code = try? String(contentsOf: script, encoding: .utf8) {
                    try? FileManager.default.removeItem(at: script)
                    view.evaluateJavaScript(code) { r, e in self.log("\(name).js -> \(r ?? "nil") \(e.map { "\($0)" } ?? "")") }
                }
                view.takeSnapshot(with: nil) { image, _ in
                    guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                          let png = rep.representation(using: .png, properties: [:]) else { return }
                    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
                }
            }
        }
    }

    /// The sticker maker's "browse your files".
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.image]
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.message = "Pick a photo with a clear object in the centre, a transparent PNG, or a sticker you downloaded."
        p.beginSheetModal(for: window) { completionHandler($0 == .OK ? p.urls : nil) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "log":
            log(body["value"] as? String ?? "")
        case "ready":
            ready(message.webView)
        case "restored":
            refreshState()
        case "place":
            // A sticker from the maker goes onto the desktop.
            guard let src = body["src"] as? String else { return }
            let finish = body["finish"] as? String ?? "vinyl"
            let size = body["size"] as? Int ?? 190
            let name = body["name"] as? String ?? "my sticker"
            desk("__sd.place(\(jsString(src)), \(jsString(finish)), \(size), \(jsString(name)))")
            liftBriefly()
        case "download":
            guard let src = body["src"] as? String else { return }
            saveSticker(src, name: body["name"] as? String ?? "sticker.png", fromMaker: message.webView === makerWeb)
        case "cmd":
            switch body["name"] as? String {
            case "samples": addSamples()
            case "top": toggleTop()
            case "clear": clearAll()
            case "website": openWebsite()
            default: break
            }
        case "save":
            if let value = body["value"] as? String {
                try? value.write(to: stateFile, atomically: true, encoding: .utf8)
            } else {
                try? FileManager.default.removeItem(at: stateFile)
            }
            refreshState()
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("navigation failed: \(error)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("navigation failed: \(error)")
    }

    // MARK: Helpers

    @objc func openWebsite() {
        NSWorkspace.shared.open(URL(string: "https://rhea-thampy.github.io/sticker-desk/")!)
    }

    /// Page errors go to ~/Library/Application Support/Sticker Desk/log.txt.
    func log(_ line: String) {
        let url = supportDir.appendingPathComponent("log.txt")
        let entry = "\(Date()) \(line)\n"
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(Data(entry.utf8))
            try? h.close()
        } else {
            try? entry.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    func desk(_ code: String) { deskWeb?.evaluateJavaScript(code, completionHandler: nil) }
    func maker(_ code: String) { makerWeb?.evaluateJavaScript(code, completionHandler: nil) }

    func jsString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s])
        return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
