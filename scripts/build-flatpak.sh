#!/usr/bin/env bash
# Build the FleetComm Flatpak bundle from electron-builder's unpacked Linux app.
#
# Inputs : dist/linux-unpacked (from `electron-builder --linux AppImage`, which
#          leaves the unpacked tree behind), build/flatpak/* (manifest,
#          launcher, desktop entry), build/icon.png.
# Needs  : flatpak, flatpak-builder, the runtimes named in the manifest
#          (installed system-wide on the runner), ImageMagick's `convert`.
# Output : dist/FleetComm-<version>.flatpak (single-file bundle, branch stable)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./package.json").version')
APP_ID=space.fleetcomm.app
MANIFEST=build/flatpak/$APP_ID.yml
[ -d dist/linux-unpacked ] || { echo "dist/linux-unpacked missing — run electron-builder --linux AppImage first"; exit 1; }

# icons the manifest installs (hicolor sizes; Flatpak rejects >512)
mkdir -p build/flatpak/gen
convert build/icon.png -resize 512x512 build/flatpak/gen/icon-512.png
convert build/icon.png -resize 256x256 build/flatpak/gen/icon-256.png

REPO=/tmp/fleetcomm-flatpak-repo
BUILD=/tmp/fleetcomm-flatpak-build
rm -rf "$REPO" "$BUILD"
flatpak-builder --force-clean --disable-rofiles-fuse --repo="$REPO" "$BUILD" "$MANIFEST"
flatpak build-bundle "$REPO" "dist/FleetComm-$VERSION.flatpak" "$APP_ID" stable
ls -la "dist/FleetComm-$VERSION.flatpak"
echo "built dist/FleetComm-$VERSION.flatpak from $MANIFEST"
