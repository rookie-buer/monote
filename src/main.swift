// main.swift — MoNote 原生外壳
// 结构照搬 Typora：AppKit 负责窗口/菜单/文件 IO，WKWebView 里的 JS 内核负责渲染与编辑。
import Cocoa
import WebKit
import UniformTypeIdentifiers

let kBridge = "monote"

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var ready = false
    var pendingOpen: URL?
    var currentDocPath: String?

    // MARK: - 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        loadUI()
        NSApp.activate(ignoringOtherApps: true)
        // 欢迎页自检：MONOTE_WELCOME_PROBE=1 时打印欢迎页渲染结果后退出
        if ProcessInfo.processInfo.environment["MONOTE_WELCOME_PROBE"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                let probe = """
                JSON.stringify({
                  blocks: Ed.blocks().length,
                  chars: Ed.text().length,
                  katex: document.querySelectorAll('#write .katex').length,
                  mathBlocks: document.querySelectorAll('#write .md-math-block').length,
                  tableRows: document.querySelectorAll('#write .md-table tbody tr').length,
                  bs: Ed.text().split(String.fromCharCode(92)).length - 1,
                  sample: Ed.text().slice(Ed.text().indexOf('int_{0}') - 3, Ed.text().indexOf('int_{0}') + 8),
                  hasTypora: /typora/i.test(Ed.text())
                })
                """
                self?.webView.evaluateJavaScript(probe) { r, e in
                    print("WELCOME-PROBE:", r ?? "nil", e?.localizedDescription ?? "")
                    NSApp.terminate(nil)
                }
            }
        }

        // 自动化自测：MONOTE_SELFTEST=<要打开的文件> 时，打开它、插入一行、保存、退出
        if let p = ProcessInfo.processInfo.environment["MONOTE_SELFTEST"], !p.isEmpty {
            pendingOpen = URL(fileURLWithPath: p)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                let probe = "JSON.stringify({tree: document.querySelectorAll('.tree-node').length, outline: Ed.outline().length, stats: (document.getElementById('stat-chars')||{}).textContent, dirty: document.getElementById('save-state').textContent, treeInfo: window.__treeInfo, filesHtml: (document.getElementById('file-tree')||{}).innerHTML && document.getElementById('file-tree').innerHTML.length})"
                self?.webView.evaluateJavaScript(probe) { r, e in
                    print("SELFTEST-PROBE:", r ?? "nil", e?.localizedDescription ?? "")
                    let edit = "Ed.focusAt(0,0); Ed.insertText('AUTOSAVE-MARK'); 'edited'"
                    self?.webView.evaluateJavaScript(edit) { r2, e2 in
                        print("SELFTEST-EDIT:", r2 ?? "nil", e2?.localizedDescription ?? "")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                            let txt = (try? String(contentsOf: URL(fileURLWithPath: p), encoding: .utf8)) ?? ""
                            print("SELFTEST-AUTOSAVE:", txt.contains("AUTOSAVE-MARK") ? "WRITTEN" : "NOT-WRITTEN")
                            print("SELFTEST-DONE")
                            NSApp.terminate(nil)
                        }
                    }
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        let url = URL(fileURLWithPath: filename)
        if ready { openDocument(url) } else { pendingOpen = url }
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let first = urls.first else { return }
        if ready { openDocument(first) } else { pendingOpen = first }
    }

    // MARK: - 界面

    func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1180, height: 800)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "MoNote"
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        window.minSize = NSSize(width: 620, height: 420)
        window.center()
        window.setFrameAutosaveName("MoNoteMainWindow")

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: kBridge)
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: rect, configuration: cfg)
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = NSColor.windowBackgroundColor
        webView.allowsBackForwardNavigationGestures = false
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    func loadUI() {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("web"),
              let index = URL(string: "index.html", relativeTo: dir) else { return }
        // 允许读取整个磁盘：文档里的相对路径图片才能显示（本地个人应用，权衡后接受）
        webView.loadFileURL(index, allowingReadAccessTo: URL(fileURLWithPath: "/"))
    }

    // MARK: - JS → 原生

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let cmd = body["cmd"] as? String else { return }
        if ProcessInfo.processInfo.environment["MONOTE_SELFTEST"] != nil { print("BRIDGE-IN:", cmd) }
        switch cmd {
        case "ready":
            ready = true
            if let u = pendingOpen { pendingOpen = nil; openDocument(u) }
            else { send("openDoc", ["path": NSNull(), "name": "未命名.md", "content": welcome]) }
        case "setTitle":
            let title = body["title"] as? String ?? "MoNote"
            window.title = title
            if let p = body["path"] as? String, !p.isEmpty { window.representedURL = URL(fileURLWithPath: p) }
            window.isDocumentEdited = (body["title"] as? String ?? "").contains("•")
        case "open":
            chooseFile { url in if let u = url { self.openDocument(u) } }
        case "save":
            guard let path = body["path"] as? String, let content = body["content"] as? String else {
                send("saveResult", ["ok": false, "error": "缺少路径"])
                return
            }
            let url = URL(fileURLWithPath: path)
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
                self.currentDocPath = path
                send("saveResult", ["ok": true, "path": path])
            } catch {
                send("saveResult", ["ok": false, "path": path, "error": error.localizedDescription])
            }
        case "saveAs":
            savePanel(suggested: body["suggested"] as? String ?? "未命名.md") { url in
                guard let url = url, let content = body["content"] as? String else { return }
                do {
                    try content.write(to: url, atomically: true, encoding: .utf8)
                    self.currentDocPath = url.path
                    self.send("saveResult", ["ok": true, "path": url.path])
                } catch {
                    self.send("saveResult", ["ok": false, "error": error.localizedDescription])
                }
            }
        case "readFile":
            if let p = body["path"] as? String { openDocument(URL(fileURLWithPath: p)) }
        case "listDir":
            guard let p = body["path"] as? String else { return }
            send("tree", ["path": p, "entries": listDir(URL(fileURLWithPath: p))])
        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "打开"
            panel.begin { resp in
                guard resp == .OK, let url = panel.url else { return }
                self.send("tree", ["path": url.path, "entries": self.listDir(url), "focus": true])
            }
        case "exportHTML":
            let html = body["html"] as? String ?? ""
            savePanel(suggested: body["suggested"] as? String ?? "导出.html", types: ["html"]) { url in
                guard let url = url else { return }
                try? html.write(to: url, atomically: true, encoding: .utf8)
            }
        case "saveImage":
            guard let b64 = body["base64"] as? String, let data = Data(base64Encoded: b64) else {
                send("imageSaved", ["ok": false, "error": "无效图片数据"])
                return
            }
            let ext = (body["ext"] as? String) ?? "png"
            let fm = FileManager.default
            let name = "pasted-\(Int(Date().timeIntervalSince1970)).\(ext)"
            do {
                if let doc = currentDocPath {
                    let assets = URL(fileURLWithPath: doc).deletingLastPathComponent()
                        .appendingPathComponent("assets", isDirectory: true)
                    try fm.createDirectory(at: assets, withIntermediateDirectories: true)
                    try data.write(to: assets.appendingPathComponent(name))
                    send("imageSaved", ["ok": true, "rel": "assets/\(name)"])
                } else {
                    let dir = fm.homeDirectoryForCurrentUser.appendingPathComponent("Pictures/MoNote", isDirectory: true)
                    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                    let url = dir.appendingPathComponent(name)
                    try data.write(to: url)
                    send("imageSaved", ["ok": true, "rel": url.path])
                }
            } catch {
                send("imageSaved", ["ok": false, "error": error.localizedDescription])
            }
        case "print":
            let info = NSPrintInfo.shared
            info.horizontalPagination = .fit
            info.verticalPagination = .automatic
            let op = webView.printOperation(with: info)
            op.showsPrintPanel = true
            op.showsProgressPanel = true
            op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
        case "openLink":
            if let s = body["href"] as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
        default:
            break
        }
    }

    func send(_ fn: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        let dbg = ProcessInfo.processInfo.environment["MONOTE_SELFTEST"] != nil
        webView.evaluateJavaScript("window.MoNote && window.MoNote.\(fn)(\(json))") { r, e in
            if dbg { print("SEND \(fn):", e?.localizedDescription ?? "ok", r ?? "") }
        }
    }

    // MARK: - 文件

    func openDocument(_ url: URL) {
        guard let content = readText(url) else {
            NSSound.beep()
            return
        }
        currentDocPath = url.path
        send("openDoc", ["path": url.path, "name": url.lastPathComponent, "content": content])
        var isDir: ObjCBool = false
        let parent = url.deletingLastPathComponent().path
        if FileManager.default.fileExists(atPath: parent, isDirectory: &isDir), isDir.boolValue {
            send("setTreeRoot", ["path": parent])
        }
    }

    func readText(_ url: URL) -> String? {
        if let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        var enc = String.Encoding.utf8
        if let s = try? String(contentsOf: url, usedEncoding: &enc) { return s }
        return try? String(contentsOf: url, encoding: .isoLatin1)
    }

    func listDir(_ url: URL) -> [[String: Any]] {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isHiddenKey, .nameKey]
        guard let items = try? FileManager.default.contentsOfDirectory(at: url,
                                                                     includingPropertiesForKeys: keys,
                                                                     options: [.skipsHiddenFiles]) else { return [] }
        return items.compactMap { u in
            let vals = try? u.resourceValues(forKeys: Set(keys))
            let isDir = vals?.isDirectory ?? false
            return ["name": u.lastPathComponent, "dir": isDir, "path": u.path]
        }
    }

    func chooseFile(completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = docTypes()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = "打开"
        panel.begin { resp in completion(resp == .OK ? panel.url : nil) }
    }

    func savePanel(suggested: String, types: [String] = [], completion: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggested
        if !types.isEmpty {
            panel.allowedContentTypes = types.compactMap { UTType(filenameExtension: $0) }
        } else {
            panel.allowedContentTypes = docTypes()
        }
        panel.begin { resp in completion(resp == .OK ? panel.url : nil) }
    }

    func docTypes() -> [UTType] {
        var t: [UTType] = [.plainText]
        for ext in ["md", "markdown", "mmd", "mdown", "mkd", "mdx", "txt", "rmd", "qmd"] {
            if let u = UTType(filenameExtension: ext) { t.append(u) }
        }
        return t
    }

    // MARK: - 菜单

    func buildMenu() {
        let main = NSMenu()

        // 应用菜单
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 MoNote", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 MoNote", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 MoNote", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // 文件
        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let file = NSMenu(title: "文件")
        file.addItem(item("新建", #selector(actNew), "n"))
        file.addItem(item("打开…", #selector(actOpen), "o"))
        file.addItem(item("打开文件夹…", #selector(actOpenFolder), "O"))
        file.addItem(.separator())
        file.addItem(item("保存", #selector(actSave), "s"))
        file.addItem(item("另存为…", #selector(actSaveAs), "S"))
        file.addItem(.separator())
        file.addItem(item("导出 HTML…", #selector(actExport), "e"))
        file.addItem(item("打印…", #selector(actPrint), "p"))
        file.addItem(.separator())
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        // 编辑
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        edit.addItem(item("撤销", #selector(actUndo), "z"))
        edit.addItem(item("重做", #selector(actRedo), "Z"))
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        edit.addItem(item("查找…", #selector(actFind), "f"))
        let rep = item("查找与替换…", #selector(actReplace), "f")
        rep.keyEquivalentModifierMask = [.command, .option]
        edit.addItem(rep)
        edit.addItem(.separator())
        edit.addItem(item("加粗", #selector(actBold), "b"))
        edit.addItem(item("斜体", #selector(actItalic), "i"))
        edit.addItem(.separator())
        edit.addItem(item("插入表格…", #selector(actTable), "t"))
        editItem.submenu = edit

        // 视图
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "视图")
        view.addItem(item("源码模式", #selector(actSource), "/"))
        view.addItem(item("侧边栏", #selector(actSidebar), "\\"))
        view.addItem(item("切换主题", #selector(actTheme), "t", shift: true))
        view.addItem(.separator())
        view.addItem(item("放大", #selector(actZoomIn), "+"))
        view.addItem(item("缩小", #selector(actZoomOut), "-"))
        view.addItem(item("实际大小", #selector(actZoomReset), "0"))
        viewItem.submenu = view

        // 帮助
        let helpItem = NSMenuItem()
        main.addItem(helpItem)
        let help = NSMenu(title: "帮助")
        help.addItem(item("MoNote 帮助", #selector(actHelp), ""))
        helpItem.submenu = help

        NSApp.mainMenu = main
    }

    func item(_ title: String, _ sel: Selector, _ key: String, shift: Bool = false) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        it.target = self
        if shift { it.keyEquivalentModifierMask = [.command, .shift] }
        return it
    }

    func js(_ cmd: String) {
        webView.evaluateJavaScript("window.MoNote && window.MoNote.command && window.MoNote.command('\(cmd)')", completionHandler: nil)
    }

    @objc func actNew() { js("new") }
    @objc func actOpen() { js("open") }
    @objc func actOpenFolder() { js("openFolder") }
    @objc func actSave() { js("save") }
    @objc func actSaveAs() { js("saveAs") }
    @objc func actExport() { js("export") }
    @objc func actPrint() { js("print") }
    @objc func actFind() { js("find") }
    @objc func actReplace() { js("replace") }
    @objc func actTable() { js("table") }
    @objc func actUndo() { js("undo") }
    @objc func actRedo() { js("redo") }
    @objc func actBold() { js("bold") }
    @objc func actItalic() { js("italic") }
    @objc func actSource() { js("source") }
    @objc func actSidebar() { js("sidebar") }
    @objc func actTheme() { js("theme") }
    @objc func actHelp() { js("help") }
    @objc func actZoomIn() { webView.pageZoom = min(3.0, webView.pageZoom + 0.1) }
    @objc func actZoomOut() { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }
    @objc func actZoomReset() { webView.pageZoom = 1.0 }

    let welcome = """
    # 欢迎使用 MoNote

    单栏、即时渲染：光标在哪一段，那一段的源码标记才出现；移开光标就只看内容。

    ## 快捷键

    | 快捷键 | 作用 |
    |---|---|
    | ⌘N | 新建文档 |
    | ⌘O | 打开文件 |
    | ⌘⇧O | 打开文件夹 |
    | ⌘S | 保存 |
    | ⌘⇧S | 另存为 |
    | ⌘F | 查找 |
    | ⌘⌥F | 查找与替换 |
    | ⌘T | 插入表格 |
    | ⌘/ | 源码模式 |
    | ⌘\\ | 收起 / 展开侧栏 |
    | ⌘⇧T | 切换主题（浅色 → 深色 → 护眼） |
    | ⌘B / ⌘I / ⌘K | 加粗 / 斜体 / 链接 |
    | ⌘E | 导出 HTML |
    | ⌘P | 打印（可存 PDF） |
    | ⌘Z / ⌘⇧Z | 撤销 / 重做 |

    编辑区里直接可用的键：Enter 分段，Shift+Enter 段内换行，列表里 Enter 续写下一项，
    空列表项 Enter 退出列表，行首 Backspace 合并到上一段，Tab 缩进。

    ## 写公式

    行内公式用一对美元符号：$E = mc^2$、$a^2 + b^2 = c^2$、$\\alpha + \\beta = \\gamma$。

    行间公式用两对美元符号单独成段：

    $$
    \\int_{0}^{\\infty} e^{-x^{2}}\\,dx = \\frac{\\sqrt{\\pi}}{2}
    $$

    常用命令：`\\frac{a}{b}` 分数、`\\sqrt{x}` 根号、`\\sum_{i=1}^{n}` 求和、`\\int_{a}^{b}` 积分、
    `^{上标}` 与 `_{下标}`、`\\alpha \\beta \\gamma` 希腊字母。

    公式和其他语法一样：平时显示排版结果，光标点进去就露出源码，改完移开又变回排版。

    ## 支持的写法

    - 标题 `#` 到 `######`、引用 `>`、有序 / 无序 / 任务列表、表格、分割线、脚注
    - 粗体 `**`、斜体 `*`、删除线 `~~`、高亮 `==`、行内代码用反引号、链接、图片
    - 围栏代码块（40+ 语言高亮）、YAML front matter、`[TOC]`、GitHub alerts

    > [!TIP]
    > 把 Markdown 文件拖进窗口就能打开；截图可以直接粘贴，会自动存到文档旁的 assets/ 目录。
    > 忘了写法就按 ⌘/ 看源码，或打开「帮助 → 语法速查」。

    """
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
