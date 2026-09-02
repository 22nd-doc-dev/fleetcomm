#!/usr/bin/env bash
# Repack the AppImage electron-builder produced with the CURRENT upstream
# AppImage runtime.
#
# electron-builder 26 bundles AppImage tooling 12.0.1, whose runtime needs
# libfuse2 — absent on current distros, so the first Linux tester had to run
# with --appimage-extract-and-run. The upstream type2 runtime (release
# 20251108) is statically built against FUSE 3 and falls back cleanly.
# Both tools are pinned by release AND sha256; a mismatch fails the build.
set -euo pipefail
cd "$(dirname "$0")/../dist"

APPIMAGE=$(ls FleetComm-*.AppImage)
TOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
TOOL_SHA="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
RUNTIME_SHA="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"

curl -sSL -o appimagetool "$TOOL_URL"
curl -sSL -o runtime-x86_64 "$RUNTIME_URL"
echo "$TOOL_SHA  appimagetool" | sha256sum -c -
echo "$RUNTIME_SHA  runtime-x86_64" | sha256sum -c -
chmod +x appimagetool "$APPIMAGE"

# unpack what electron-builder made (works without FUSE), then repack the same
# AppDir under the new runtime, same file name
./"$APPIMAGE" --appimage-extract >/dev/null
rm -f "$APPIMAGE"
ARCH=x86_64 ./appimagetool --appimage-extract-and-run --no-appstream \
  --runtime-file runtime-x86_64 squashfs-root "$APPIMAGE"
rm -rf squashfs-root appimagetool runtime-x86_64

chmod +x "$APPIMAGE"
ls -la "$APPIMAGE"
file "$APPIMAGE"
# the new runtime answers this without FUSE — proves the image is well-formed
./"$APPIMAGE" --appimage-offset
echo "repacked $APPIMAGE with type2-runtime 20251108"
