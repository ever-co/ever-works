#!/usr/bin/env bash
# The linux-x64 release build of the screen helper, inside a pinned container.
#
# Runs build-release.sh (two clean builds, compared) in the Rust image below,
# pinned by digest, on this folder AS COMMITTED (git archive of HEAD, LF line
# endings), so the binary depends on the commit and the image, not on the
# machine or its checkout: a GitHub runner, an in-cluster runner and a
# workstation with Docker produce the same bytes, and anyone can check a
# published fingerprint by running this script at the release's commit. The
# image is Debian 12; the helper it builds needs glibc 2.34 or newer (Debian 12,
# Ubuntu 22.04 and newer). publish-node.yml builds the released linux-x64 helper with
# it (see PACKAGING.md, "Release builds").
#
# Uncommitted changes in this folder are NOT built (the script says so).
#
# Usage: bash build-release-linux.sh [out_dir]   (needs Docker and git; default dist)
set -euo pipefail

cd "$(dirname "$0")"
out_dir="${1:-dist}"
# Emptied first, so it must be a plain folder name inside this one that git
# tracks nothing in (dist, dist-linux, ...), never a path such as src or C:/x.
if ! printf '%s' "$out_dir" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9._-]*$'; then
  echo "out_dir must be a plain folder name inside this folder (got: $out_dir)" >&2
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

echo "ever-works-screen linux-x64 release build of $commit ($folder) in $image" >&2
# The sources go in on stdin and the outputs come back on stdout, both as tar:
# no bind mount, so any Docker daemon works (local, remote, Docker-in-Docker).
# The build log goes to stderr. RUSTUP_TOOLCHAIN: use the image's toolchain as
# it is (rust-toolchain.toml would also ask rustup for clippy and rustfmt,
# which a release build does not need). The build runs in
# /build/ever-works-screen, the path build-release.sh remaps. (git archive runs
# from the top: from a subdirectory it would archive only that part of the tree.)
git -C "$top" -c core.autocrlf=false -c core.eol=lf archive --format=tar "$commit:$folder" |
  MSYS_NO_PATHCONV=1 docker run --rm -i --platform linux/amd64 \
    --env "SOURCE_DATE_EPOCH=$epoch" \
    --env "RUSTUP_TOOLCHAIN=$toolchain" \
    "$image" \
    bash -c 'set -euo pipefail
      mkdir -p /build/ever-works-screen /out
      tar -C /build/ever-works-screen -xf -
      cd /build/ever-works-screen
      bash build-release.sh /out >&2
      tar -C /out -cf - .' |
  tar -C "$out_dir" -xf -
cat "$out_dir/unsigned-release-metadata.json"
