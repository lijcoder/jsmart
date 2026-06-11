#!/bin/bash
# Generate macOS .icns and .png from icon.svg
# Uses qlmanage for per-size rendering (preserves alpha edges)

set -e
cd "$(dirname "$0")"

ICONSET="icon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Map of size -> output filename
sizes=(
  "16:icon_16x16.png"
  "32:icon_16x16@2x.png"
  "32:icon_32x32.png"
  "64:icon_32x32@2x.png"
  "128:icon_128x128.png"
  "256:icon_128x128@2x.png"
  "256:icon_256x256.png"
  "512:icon_256x256@2x.png"
  "512:icon_512x512.png"
  "1024:icon_512x512@2x.png"
)

echo "→ Rendering each size directly from SVG..."
for entry in "${sizes[@]}"; do
  size="${entry%%:*}"
  name="${entry##*:}"
  tmpdir=$(mktemp -d)
  qlmanage -t -s "$size" -o "$tmpdir" icon.svg 2>/dev/null
  mv "$tmpdir/icon.svg.png" "$ICONSET/$name"
  rm -rf "$tmpdir"
done

echo "→ Creating icon.icns..."
iconutil -c icns "$ICONSET" -o icon.icns

# 1024 PNG for Linux / dock icon
cp "$ICONSET/icon_512x512@2x.png" icon.png

rm -rf "$ICONSET"
echo "✅ Done: icon.icns + icon.png"
