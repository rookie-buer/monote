#!/bin/bash
# 构建 MoNote.app（无需 Xcode 工程，只用 Command Line Tools 的 swiftc）
set -euo pipefail
cd "$(dirname "$0")"

APP="build/MoNote.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> 编译 Swift 外壳"
swiftc -O -o "$APP/Contents/MacOS/MoNote" src/main.swift \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers

echo "==> 拷贝 Web 内核"
cp -R web "$APP/Contents/Resources/web"
rm -f "$APP/Contents/Resources/web/sample.md" \
      "$APP/Contents/Resources/web/sample2.md" \
      "$APP/Contents/Resources/web/sample3.md" \
      "$APP/Contents/Resources/web/test.html" \
      "$APP/Contents/Resources/web/bridge-test.html" \
      "$APP/Contents/Resources/web/welcome-preview.md"

echo "==> 图标"
if [ -f icon.icns ]; then cp icon.icns "$APP/Contents/Resources/MoNote.icns"; fi

echo "==> 写入 Info.plist"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MoNote</string>
  <key>CFBundleDisplayName</key><string>MoNote</string>
  <key>CFBundleIdentifier</key><string>com.blockbuer.monote</string>
  <key>CFBundleExecutable</key><string>MoNote</string>
  <key>CFBundleIconFile</key><string>MoNote</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Markdown</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>net.daringfireball.markdown</string>
        <string>public.plain-text</string>
      </array>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>md</string><string>markdown</string><string>mmd</string>
        <string>mdown</string><string>mkd</string><string>mdx</string><string>txt</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

echo "==> 临时签名"
codesign --force --sign - "$APP" 2>/dev/null || echo "(跳过签名)"

echo "==> 完成: $(pwd)/$APP"
