#!/usr/bin/env bash
set -euo pipefail

# Re-sign the .app bundle after tauri build.
# Tauri's bundler leaves only a linker-signed ad-hoc signature on the main
# binary, which doesn't account for bundle resources (sidecar, icons, plist).
# This script applies a proper ad-hoc signature to the entire .app so macOS
# can verify the bundle integrity and allow it to launch.

APP_DIR="src-tauri/target/release/bundle/macos"
DMG_DIR="src-tauri/target/release/bundle/dmg"
APP_NAME="Zvec Studio.app"

if [ ! -d "$APP_DIR/$APP_NAME" ]; then
  echo "ERROR: $APP_DIR/$APP_NAME not found. Run 'tauri build' first."
  exit 1
fi

echo "Signing sidecar..."
codesign --force --sign - "$APP_DIR/$APP_NAME/Contents/MacOS/zvec-studio-sidecar"

echo "Signing app bundle..."
codesign --force --sign - "$APP_DIR/$APP_NAME"

echo "Verifying signature..."
codesign -vvv "$APP_DIR/$APP_NAME"

echo "Recreating DMG with Applications symlink..."
DMG_STAGE=$(mktemp -d)
cp -R "$APP_DIR/$APP_NAME" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"

# Find the existing DMG produced by Tauri and replace it in-place.
EXISTING_DMG=$(find "$DMG_DIR" -name '*.dmg' -print -quit 2>/dev/null || true)
if [ -n "$EXISTING_DMG" ]; then
  DMG_OUT="$EXISTING_DMG"
else
  ARCH=$(uname -m)
  DMG_OUT="$DMG_DIR/Zvec Studio_0.1.0_${ARCH}.dmg"
fi

rm -f "$DMG_OUT"
hdiutil create \
  -volname "Zvec Studio" \
  -srcfolder "$DMG_STAGE" \
  -ov -format UDZO \
  "$DMG_OUT"

rm -rf "$DMG_STAGE"
echo "Done: $DMG_OUT"
