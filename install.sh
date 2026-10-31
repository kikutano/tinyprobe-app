#!/bin/sh
# tinyprobe-app installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/kikutano/tinyprobe-app/main/install.sh | sh
#
# It downloads the app, checks it against the release's SHA256SUMS, then runs `tinyprobe-app --install`:
# the app copies itself to its folder, adds the tinyprobe icon, and downloads tinyprobe if it is missing.
# Run it again to update the app.
#
# Environment variables:
#   TINYPROBE_APP_VERSION   version to install, e.g. 0.1.0 (default: latest release)
#   TINYPROBE_APP_BIN       where to link the tinyprobe-app command (default: $HOME/.local/bin)
#   TINYPROBE_APP_BASE_URL  where the archives and SHA256SUMS are (default: the GitHub release; for tests)
set -eu

REPO="kikutano/tinyprobe-app"
BIN_DIR="${TINYPROBE_APP_BIN:-$HOME/.local/bin}"

fail() { echo "tinyprobe-app install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux)  os="linux" ;;
  Darwin) os="osx" ;;
  *) fail "unsupported OS '$(uname -s)'. On Windows use install.ps1." ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) fail "unsupported architecture '$(uname -m)'." ;;
esac

# Alpine and other musl distributions cannot run the glibc binary.
if [ "$os" = "linux" ] && ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
  os="linux-musl"
fi

rid="$os-$arch"
case "$rid" in
  linux-x64|linux-arm64|linux-musl-x64|linux-musl-arm64|osx-arm64) ;;
  *) fail "no prebuilt app for $rid." ;;
esac

if [ -n "${TINYPROBE_APP_BASE_URL:-}" ]; then
  base_url="$TINYPROBE_APP_BASE_URL"
elif [ -n "${TINYPROBE_APP_VERSION:-}" ]; then
  base_url="https://github.com/$REPO/releases/download/v${TINYPROBE_APP_VERSION#v}"
else
  base_url="https://github.com/$REPO/releases/latest/download"
fi

archive="tinyprobe-app-$rid.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    fail "curl or wget is required."
  fi
}

echo "Downloading $base_url/$archive"
download "$base_url/$archive" "$tmp/$archive" || fail "download failed."
download "$base_url/SHA256SUMS" "$tmp/SHA256SUMS" || fail "the checksums could not be downloaded."
expected="$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive: nothing was installed."

tar -xzf "$tmp/$archive" -C "$tmp"
chmod +x "$tmp/tinyprobe-app"
"$tmp/tinyprobe-app" --install

# The command too, next to tinyprobe's: `tinyprobe-app` in a terminal starts the installed copy.
if [ "$os" = "osx" ]; then data="$HOME/Library/Application Support/tinyprobe-app"; else data="${XDG_DATA_HOME:-$HOME/.local/share}/tinyprobe-app"; fi
if [ -n "${TINYPROBE_APP_DATA:-}" ]; then data="$TINYPROBE_APP_DATA"; fi
mkdir -p "$BIN_DIR"
ln -sf "$data/app/tinyprobe-app" "$BIN_DIR/tinyprobe-app"
echo "  Command  : $BIN_DIR/tinyprobe-app"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  Add $BIN_DIR to your PATH to use it, e.g.: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;;
esac
