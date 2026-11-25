#!/bin/bash
# Builds "Sticker Desk.app" into desktop/build/. Needs the Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Sticker Desk.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

# Universal: runs natively on Apple silicon and Intel Macs.
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" \
    -o "build/StickerDesk-$arch" main.swift -framework Cocoa -framework WebKit
done
lipo -create -output "$APP/Contents/MacOS/StickerDesk" build/StickerDesk-arm64 build/StickerDesk-x86_64
rm build/StickerDesk-arm64 build/StickerDesk-x86_64

cp desk.html maker.html "$APP/Contents/Resources/web/"
cp ../sticker-board.js "$APP/Contents/Resources/web/sticker-board.js"

# The app icon is drawn by icon.swift; it's only redrawn if AppIcon.icns is deleted.
if [ ! -f AppIcon.icns ]; then
  rm -rf build/AppIcon.iconset
  swift icon.swift build/AppIcon.iconset
  iconutil -c icns build/AppIcon.iconset -o AppIcon.icns
fi
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sticker Desk</string>
  <key>CFBundleDisplayName</key><string>Sticker Desk</string>
  <key>CFBundleIdentifier</key><string>local.stickerdesk.app</string>
  <key>CFBundleExecutable</key><string>StickerDesk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHumanReadableCopyright</key><string>Peel, stick, repeat.</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Image</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.image</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null
# A zip for the GitHub release (ditto keeps the bundle's attributes and signature intact).
(cd build && rm -f Sticker-Desk-mac.zip && ditto -c -k --keepParent "Sticker Desk.app" Sticker-Desk-mac.zip)
echo "Built $APP and build/Sticker-Desk-mac.zip"
