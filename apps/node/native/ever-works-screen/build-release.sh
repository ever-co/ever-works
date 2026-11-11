#!/usr/bin/env bash
# Reproducible release build of the screen helper (FL-07, plan T-10) — Linux and macOS.
#
# Builds twice in clean target directories and compares the SHA-256 of both
# binaries; a mismatch fails. Writes unsigned-release-metadata.json with
# productionEligible: false. Uploads nothing. Run by the Screen Helper workflow
# on Linux and macOS (see PACKAGING.md); the released linux-x64 build runs it in
# a pinned container (build-release-linux.sh).
#
# SCREEN_HELPER_TARGET (optional) builds another target than the host's, where
# the host can: darwin-x64 on an Apple silicon Mac, darwin-arm64 on an Intel one,
# and win32-x64 on Linux x64 (x86_64-pc-windows-gnu, linked by the mingw-w64
# cross compiler x86_64-w64-mingw32-gcc: build-release-linux.sh installs a
# pinned one and the target's standard library, see there).
set -euo pipefail

cd "$(dirname "$0")"
out_dir="${1:-dist}"
mkdir -p "$out_dir"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) host_target="linux-x64" ;;
  Darwin-arm64) host_target="darwin-arm64" ;;
  Darwin-x86_64) host_target="darwin-x64" ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

target_name="${SCREEN_HELPER_TARGET:-$host_target}"
cargo_target=()
binary_dir="release"
binary_name="ever-works-screen"
link_flags=""
if [ "$target_name" != "$host_target" ]; then
  case "$host_target>$target_name" in
    darwin-*">darwin-x64") triple="x86_64-apple-darwin" ;;
    darwin-*">darwin-arm64") triple="aarch64-apple-darwin" ;;
    "linux-x64>win32-x64")
      triple="x86_64-pc-windows-gnu"
      binary_name="ever-works-screen.exe"
      if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
        echo "win32-x64 needs the mingw-w64 cross linker x86_64-w64-mingw32-gcc (build-release-linux.sh installs a pinned one)" >&2
        exit 2
      fi
      # --no-insert-timestamp: GNU ld otherwise stamps the link time into the
      # PE header, and two clean builds differ by those bytes alone (the MSVC
      # build's /Brepro). --tsaware and the 6.0 subsystem / OS versions: the
      # PE header flags the MSVC linker sets by default, so Windows treats both
      # builds alike (no Terminal Server compatibility shims in a Remote
      # Desktop session, no pre-Vista window-frame compatibility).
      link_flags="-C link-arg=-Wl,--no-insert-timestamp -C link-arg=-Wl,--tsaware"
      link_flags="$link_flags -C link-arg=-Wl,--major-subsystem-version,6 -C link-arg=-Wl,--minor-subsystem-version,0"
      link_flags="$link_flags -C link-arg=-Wl,--major-os-version,6 -C link-arg=-Wl,--minor-os-version,0"
      ;;
    *) echo "cannot build $target_name on a $host_target host" >&2; exit 2 ;;
  esac
  # The released win32-x64 build installs this target's standard library
  # itself, from a tarball pinned by SHA-256 (build-release-linux.sh), and
  # rustup must not download another: anywhere else rustup adds it.
  if [ -d "$(rustc --print sysroot)/lib/rustlib/$triple/lib" ]; then
    echo "the $triple standard library is already installed; rustup is not asked for it" >&2
  else
    rustup target add "$triple"
  fi
  cargo_target=(--target "$triple")
  binary_dir="$triple/release"
fi

if [ ! -f Cargo.lock ]; then
  echo "Cargo.lock is missing: generate it once (cargo generate-lockfile), review and commit it first" >&2
  exit 2
fi

export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}"
export CARGO_INCREMENTAL=0
here="$(pwd)"
export RUSTFLAGS="${link_flags:+$link_flags }--remap-path-prefix=$here=/build/ever-works-screen --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

for pass in 1 2; do
  rm -rf "target-repro-$pass"
  cargo build --release --locked ${cargo_target[@]+"${cargo_target[@]}"} --target-dir "target-repro-$pass"
done

first="target-repro-1/$binary_dir/$binary_name"
second="target-repro-2/$binary_dir/$binary_name"
sha_one="$(hash_of "$first")"
sha_two="$(hash_of "$second")"
if [ "$sha_one" != "$sha_two" ]; then
  echo "the two builds differ: $sha_one vs $sha_two" >&2
  exit 1
fi

cp "$first" "$out_dir/$binary_name"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1 | tr -d '\r')"
cat > "$out_dir/unsigned-release-metadata.json" <<JSON
{
  "schemaVersion": 1,
  "artifact": "ever-works-screen",
  "version": "$version",
  "target": "$target_name",
  "sha256": "$sha_one",
  "reproducible": true,
  "productionEligible": false
}
JSON
echo "ever-works-screen $version ($target_name) sha256 $sha_one"
