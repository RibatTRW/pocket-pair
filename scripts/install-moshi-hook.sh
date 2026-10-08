#!/usr/bin/env bash
# Install moshi-hook the way Moshi's own installer does, minus the pipe to a
# shell: fetch a named release, check it against the release's checksums.txt,
# and refuse to install anything that does not match.
#
# Pocket Pair runs this when you press "Install helper". It needs no root.
#
#   POCKET_PAIR_CDN          override the download host (tests only)
#   POCKET_PAIR_INSTALL_DIR  default ~/.local/bin
#   POCKET_PAIR_SKIP_SERVICE set to 1 to skip `moshi-hook service install`
set -euo pipefail

cdn="${POCKET_PAIR_CDN:-https://cdn.getmoshi.app}"
dir="${POCKET_PAIR_INSTALL_DIR:-$HOME/.local/bin}"
proto='=https'
[[ -n ${POCKET_PAIR_CDN:-} ]] && proto='=https,file'

step() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
fetch() { curl --proto "$proto" --fail --silent --show-error --location --max-time 120 "$1" -o "$2"; }

case "$(uname -s)" in Linux) ;; *) fail "this installer is for Linux" ;; esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac
for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

step "finding the latest release"
fetch "$cdn/hook/latest/version.txt" "$tmp/version.txt" || fail "could not reach $cdn"
version="$(tr -d '[:space:]' <"$tmp/version.txt")"
[[ $version =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "unexpected version string"
version="v${version#v}"

asset="moshi-hook_Linux_${arch}.tar.gz"
base="$cdn/hook/$version"

step "downloading moshi-hook $version"
fetch "$base/$asset" "$tmp/$asset" || fail "download failed: $asset"
fetch "$base/checksums.txt" "$tmp/checksums.txt" || fail "checksums.txt is unavailable, so the download cannot be verified"

step "verifying the download"
expected="$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/checksums.txt")"
[[ $expected =~ ^[0-9a-f]{64}$ ]] || fail "checksums.txt has no usable entry for $asset"
actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
[[ $actual == "$expected" ]] || fail "checksum mismatch for $asset; nothing was installed"

step "installing to $dir"
tar -xzf "$tmp/$asset" -C "$tmp" moshi-hook
mkdir -p "$dir"
install -m 755 "$tmp/moshi-hook" "$dir/.moshi-hook.new"
mv -f "$dir/.moshi-hook.new" "$dir/moshi-hook"
if [[ -L $dir/moshi || ! -e $dir/moshi ]]; then
  ln -sfn moshi-hook "$dir/moshi"
fi

if [[ ${POCKET_PAIR_SKIP_SERVICE:-} != 1 ]] && command -v systemctl >/dev/null; then
  step "starting the background service"
  "$dir/moshi-hook" service install || printf 'warning: could not start the service; run: moshi-hook service install\n' >&2
fi

step "installed moshi-hook $version"
