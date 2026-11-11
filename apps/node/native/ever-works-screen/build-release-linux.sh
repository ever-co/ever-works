#!/usr/bin/env bash
# The release builds of the screen helper made on Linux, inside a pinned
# container: linux-x64 (the default) and win32-x64 (SCREEN_HELPER_TARGET=win32-x64,
# cross-compiled for x86_64-pc-windows-gnu with mingw-w64).
#
# Runs build-release.sh (two clean builds, compared) in the Rust image below,
# pinned by digest, on this folder AS COMMITTED (git archive of HEAD, LF line
# endings), so the binary depends on the commit and the image, not on the
# machine or its checkout: a GitHub runner, an in-cluster runner and a
# workstation with Docker produce the same bytes, and anyone can check a
# published fingerprint by running this script at the release's commit. The
# image is Debian 12; the linux-x64 helper it builds needs glibc 2.34 or newer
# (Debian 12, Ubuntu 22.04 and newer). For win32-x64 the container first
# installs the mingw-w64 cross toolchain at exact versions from
# snapshot.debian.org (the snapshot the image itself was made from, below), so
# that toolchain is pinned as well; the .exe imports only DLLs Windows ships
# (msvcrt, kernel32, user32, gdi32, ntdll, bcryptprimitives and two API sets).
# publish-node.yml builds the released helpers with it (see PACKAGING.md,
# "Release builds").
#
# Uncommitted changes in this folder are NOT built (the script says so).
#
# Usage: [SCREEN_HELPER_TARGET=win32-x64] bash build-release-linux.sh [out_dir]
#        (needs Docker and git; default out_dir: dist)
set -euo pipefail

cd "$(dirname "$0")"
out_dir="${1:-dist}"
target="${SCREEN_HELPER_TARGET:-linux-x64}"
case "$target" in
  linux-x64 | win32-x64) ;;
  *) echo "SCREEN_HELPER_TARGET must be linux-x64 or win32-x64 here (got: $target)" >&2; exit 2 ;;
esac
# Emptied first, so it must be a plain folder name inside this one, or one
# level below one (dist, dist-linux, dist/win32-x64, ...), that git tracks
# nothing in: never a path such as src, ../x or C:/x, nor one through a link.
if ! printf '%s' "$out_dir" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)?$'; then
  echo "out_dir must be a plain folder name inside this folder, or one level below one (got: $out_dir)" >&2
  exit 2
fi
if [ -L "${out_dir%%/*}" ] || [ -L "$out_dir" ]; then
  echo "out_dir $out_dir is or goes through a symbolic link; pick another name (nothing was deleted)" >&2
  exit 2
fi
if [ -e "$out_dir" ] && [ ! -d "$out_dir" ]; then
  echo "out_dir $out_dir is a file, not a folder; pick another name (nothing was deleted)" >&2
  exit 2
fi
if [ -n "$(git ls-files -- "$out_dir")" ]; then
  echo "out_dir $out_dir holds files git tracks; pick another name (nothing was deleted)" >&2
  exit 2
fi
if [ -d "$out_dir" ] && [ -n "$(ls -A "$out_dir")" ] && [ ! -f "$out_dir/unsigned-release-metadata.json" ]; then
  echo "out_dir $out_dir is not empty and is not an earlier release build; pick another name (nothing was deleted)" >&2
  exit 2
fi

# rust:1.88.0-slim-bookworm (the channel rust-toolchain.toml pins). Change both together.
image="${SCREEN_HELPER_LINUX_IMAGE:-docker.io/library/rust:1.88.0-slim-bookworm@sha256:38bc5a86d998772d4aec2348656ed21438d20fcdce2795b56ca434cf21430d89}"
toolchain="$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml | tr -d '\r')"
case "$image" in
  *"rust:$toolchain-"*) ;;
  *) echo "the build image ($image) is not Rust $toolchain, the channel rust-toolchain.toml pins" >&2; exit 2 ;;
esac
# win32-x64: the mingw-w64 cross toolchain (linker, binutils, Windows import
# libraries and CRT start-up files: every byte of the .exe that is not Rust's
# comes from these), at exact versions from the Debian snapshot the image above
# was made from (its /etc/apt/sources.list.d/debian.sources names it), so the
# toolchain is as fixed as the image. Change all three together. apt checks
# every package against the archive's signed Release file. When
# snapshot.debian.org cannot be reached, the same exact versions come from
# deb.debian.org while bookworm still carries them: Debian never reuses a
# version for other bytes, so the build is the same; otherwise the build fails.
debian_snapshot="20250721T000000Z"
if [ "$target" = win32-x64 ]; then
  case "$image" in
    *bookworm*) ;;
    *) echo "win32-x64 installs the bookworm mingw-w64 toolchain, so the build image must be bookworm (got: $image)" >&2; exit 2 ;;
  esac
fi
mingw_packages="binutils-mingw-w64-x86-64=2.40-2+10.4 \
gcc-mingw-w64-base=12.2.0-14+deb12u1+25.2+b1 \
gcc-mingw-w64-x86-64-win32=12.2.0-14+deb12u1+25.2+b1 \
gcc-mingw-w64-x86-64-win32-runtime=12.2.0-14+deb12u1+25.2+b1 \
mingw-w64-common=10.0.0-3 \
mingw-w64-x86-64-dev=10.0.0-3"

commit="$(git rev-parse --verify HEAD)"
top="$(git rev-parse --show-toplevel)"
folder="$(git rev-parse --show-prefix)"
folder="${folder%/}"
if [ -n "$(git status --porcelain -- .)" ]; then
  echo "note: building $folder as committed in $commit; these uncommitted changes are not part of the build:" >&2
  git status --short -- . >&2
fi
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct "$commit")}"

rm -rf "$out_dir"
mkdir -p "$out_dir"

echo "ever-works-screen $target release build of $commit ($folder) in $image" >&2
# The sources go in on stdin and the outputs come back on stdout, both as tar:
# no bind mount, so any Docker daemon works (local, remote, Docker-in-Docker).
# The build log goes to stderr. RUSTUP_TOOLCHAIN: use the image's toolchain as
# it is (rust-toolchain.toml would also ask rustup for clippy and rustfmt,
# which a release build does not need). The build runs in
# /build/ever-works-screen, the path build-release.sh remaps. (git archive runs
# from the top: from a subdirectory it would archive only that part of the tree.)
# Check-Valid-Until: a snapshot's Release file is past its expiry date by
# design; its signature is still checked.
git -C "$top" -c core.autocrlf=false -c core.eol=lf archive --format=tar "$commit:$folder" |
  MSYS_NO_PATHCONV=1 docker run --rm -i --platform linux/amd64 \
    --env "SOURCE_DATE_EPOCH=$epoch" \
    --env "RUSTUP_TOOLCHAIN=$toolchain" \
    --env "SCREEN_HELPER_TARGET=$target" \
    --env "DEBIAN_SNAPSHOT=$debian_snapshot" \
    --env "MINGW_PACKAGES=$mingw_packages" \
    "$image" \
    bash -c 'set -euo pipefail
      if [ "$SCREEN_HELPER_TARGET" = win32-x64 ]; then
        install_mingw() {
          printf "%s\n" "Types: deb" "URIs: $1" "Suites: bookworm" "Components: main" \
            "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg" > /etc/apt/sources.list.d/debian.sources
          # shellcheck disable=SC2086 # one word per package=version
          apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Retries=5 update -qq >&2 &&
            DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends $MINGW_PACKAGES >&2
        }
        if ! install_mingw "https://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT"; then
          echo "snapshot.debian.org failed; the same exact versions from deb.debian.org" >&2
          install_mingw "https://deb.debian.org/debian"
        fi
        x86_64-w64-mingw32-gcc --version | head -1 >&2
      fi
      mkdir -p /build/ever-works-screen /out
      tar -C /build/ever-works-screen -xf -
      cd /build/ever-works-screen
      bash build-release.sh /out >&2
      tar -C /out -cf - .' |
  tar -C "$out_dir" -xf -
cat "$out_dir/unsigned-release-metadata.json"
