# `ever-works-screen` — packaging and trust

The native screen helper behind the **Desktop** source of a computer's live view (FL-07). It captures one display of
the machine and hands the node JPEG keyframes and changed 64 × 64 tiles over its stdin / stdout. This file states
what is and is not shipped.

> **Build status (2026-10-27).** First compiled with the pinned Rust 1.88.0. On Windows (MSVC) `cargo build`,
> `cargo test`, `cargo clippy -- -D warnings` and `cargo fmt --check` pass, and `cargo clippy` is also clean for
> Linux x64 and macOS x64 / arm64. `Cargo.lock` is committed and `build-release.ps1` produces byte-identical builds.
> A Windows build streamed this machine's desktop end to end (hello, keyframe, tiles, exit on stdin close). The
> `Screen Helper` workflow (`.github/workflows/screen-helper.yml`, not a required check) runs the same on Windows,
> Linux and macOS for pull requests that touch this folder, and on demand. How to build and admit a build of your
> own: [`README.md`](README.md).

## What it is

| Concern      | P1 (this crate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport    | The helper's own stdin / stdout, length-prefixed (`src/protocol.rs`). Same user, same session. No network port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Linux        | X11: RandR monitors, `GetImage` of the monitor's rectangle, XFixes pointer. Wayland is refused by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Windows      | GDI `BitBlt` (with `CAPTUREBLT`) of the monitor's rectangle, the pointer drawn in; per-monitor DPI aware.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| macOS        | CoreGraphics `CGDisplayCreateImage` after a Screen Recording preflight; Accessibility preflighted for control.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Changes      | 64 × 64 tiles diffed at the stream's width, each JPEG-encoded; a keyframe on cadence; ≤ 512 KiB per publish.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Input (P2)   | X11 XTest, Windows `SendInput` + `SetCursorPos`, macOS Quartz events (Accessibility). Pointer mapped from picture pixels to the display (`src/input/`); the blocked shortcuts refused a second time; every pressed key and button released on `releaseAll`, `stop`, a lost display and stdin close. The injector opens on the first input only. After a crash during control, the node starts a fresh helper whose only command is `releaseHeld` (every modifier and button the OS reports held is released; nothing is pressed), and a helper that panics after injecting does the same before it aborts. |
| Marker       | While the node says a stream is controlled (`controlMarker`, offered in `hello.features`), a 6-pixel orange-red border inside the controlled display. Windows: topmost, click-through, never-activated windows, excluded from screen capture. X11: override-redirect windows with an empty input shape (no marker without the Shape extension). macOS: not yet, so not offered. Removed when control ends, the stream stops or the helper exits.                                                                                                                                                           |
| Virtual (P3) | Linux X11 only (`addDisplay` / `removeDisplay`, answered `displayChange`): a display with a name and a size from a fixed list, made with RandR requests on a free output (no `xrandr` process), tagged in the X server so every later helper lists it as virtual. It lasts until removed or the X server stops. Only a tagged display can be removed. Refused by name elsewhere: `unsupported` (macOS, Windows), `unsupported-session`, `randr-unavailable`, `no-free-output` (Xvfb, or every output in use), `screen-too-large`, `size-not-offered`, `invalid-name`, `not-virtual`.                       |
| Environment  | The node passes `DISPLAY`, `XAUTHORITY`, `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY` (Linux) and nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Faster capture paths are follow-ups behind the same `Capturer` trait: XShm on X11, DXGI desktop duplication on
Windows (dirty rectangles for free), ScreenCaptureKit on macOS (`CGDisplayCreateImage` is deprecated on recent
macOS releases and does not draw the pointer).

## Where it runs

P1 runs the helper as a **direct child of the node**. That works when the node itself runs in the person's desktop
session (started from a terminal, or as a per-user login item). When the node runs as a system service it has no
desktop to capture, and the helper says so (`no-display-session` on Windows session 0, no `DISPLAY` on Linux). The
plan's launches into the interactive session — a per-user LaunchAgent on macOS with a `0600` Unix socket, a one-off
scheduled task into the console session on Windows with an owner-only named pipe — are follow-ups.

On macOS the Screen Recording permission is granted to the process macOS holds responsible for the helper (the
terminal or app that started the node). A hash-pinned helper asks again after each update; a signed one (P3) keeps
the grant.

## Trust

The node never starts a helper it has not verified **immediately before the start** against the owner's admission
record (`helper-policy.json` in the node's config directory, written `0600`):

1. `ever-works-node helper install` downloads the build the node package's `helper-manifest.json` names for this
   platform and checks its SHA-256 against the manifest before keeping it.
2. `ever-works-node helper admit` prints the file's SHA-256 beside the published one and records the admission only
   after the owner types `admit` (**hash-pinned**, shown as "Reduced trust"). A fingerprint the manifest does not
   publish needs `--allow-unpublished` and is recorded as unpublished.
3. Before every start the node re-hashes the file; a different byte refuses the start with `helper-untrusted`, reports
   `helperTrust: none` and writes `node.helper.verify-failed` to the fleet audit.
4. `ever-works-node helper revoke` removes the record and stops a running helper within 2 seconds.
5. **Control** (P2) needs one more act on the machine: `ever-works-node helper control allow` explains what control
   means and records it only after the owner types `control`, bound to this admission (approving the helper again
   turns control off). `helper control deny` releases every key and button and ends a live control within a second.

**Signed** admission (P3, `ever-works-node helper admit --signed`): the node accepts a helper the operating system
judges signed by the publisher the node package names as the manifest target's `signer` — the Developer ID Team ID on
macOS, the Authenticode signer's subject under a machine root on Windows. The check is
`apps/node/src/core/screen/helper/helper-signature.ts`. Linux is always hash-pinned. Producing such a helper is the
release signing below.

## Release builds

`build-release.sh` (Linux, macOS) and `build-release.ps1` (Windows) build `--release --locked` twice in clean
target directories and compare the SHA-256 of both outputs; a mismatch fails the build. They write
`unsigned-release-metadata.json` with `productionEligible: false` (an unsigned build never counts as a signed one) and
the fingerprint the node package's `helper-manifest.json` (`helper-manifest.schema.json`) carries for that version and
target. `SCREEN_HELPER_TARGET=darwin-x64 bash build-release.sh <dir>` builds the Intel Mac helper on an Apple silicon
Mac. The build scripts upload nothing.

`build-release-linux.sh` runs `build-release.sh` on this folder as committed (`git archive` of `HEAD`, so neither the
checkout's line endings nor uncommitted files reach the build) in a Rust image pinned by digest
(`rust:1.88.0-slim-bookworm`, Debian 12; the linux-x64 helper needs glibc 2.34 or newer: Debian 12, Ubuntu 22.04 and
newer). The fingerprint therefore depends on the commit and the image, not on the machine: a CI runner and a
workstation with Docker produce the same bytes, and anyone can check a released fingerprint by running
`bash build-release-linux.sh` at the release's commit. The sources go into the container and the outputs come back as
tar streams, so any Docker daemon works (local, remote, Docker-in-Docker).

`SCREEN_HELPER_TARGET=win32-x64 bash build-release-linux.sh dist/win32-x64` builds the **Windows** helper the same way,
cross-compiled for `x86_64-pc-windows-gnu`:

- The container first installs the mingw-w64 cross toolchain (GCC 12.2 driver, binutils 2.40 `ld`, mingw-w64 10.0 CRT
  and import libraries) at **exact versions from `snapshot.debian.org`**, at the snapshot the image itself was made
  from, so the toolchain is as fixed as the image (apt checks every package against the snapshot's signed Release
  file). The image digest, the snapshot and the package versions sit together in the script and change together.
- The PE is deterministic: `--no-insert-timestamp` (the link time is otherwise stamped into the header; the MSVC build's
  `/Brepro`), and the header flags the MSVC linker sets (`--tsaware`, subsystem and OS version 6.0), so Windows treats
  both builds alike.
- The `.exe` imports only DLLs every Windows ships (`msvcrt`, `kernel32`, `user32`, `gdi32`, `ntdll`, `bcryptprimitives`
  and two API sets). The MSVC build also needs `VCRUNTIME140.dll` (the Visual C++ redistributable), so the gnu build is
  the one that runs on any Windows 10 / 11 machine.

Proven on Windows 10 Pro 22H2 (19045) against the MSVC build of the same commit (`build-release.ps1`): both answer
`--version`, say `hello` with the same displays and features, answer a malformed command with `error`, refuse an input
while nothing streams, start a stream and send a 1280 × 720 keyframe and changed tiles, and exit within 40 ms of stdin
closing. Neither embeds an application manifest; DPI awareness is set by the helper at start in both.

The macOS builds are reproducible on the machine that built them (two builds there are byte-identical), but another
machine matches only with the same linker and system libraries, so for those targets a release would take the
fingerprint of its own build. The same holds for a Windows build of your own with `build-release.ps1` (MSVC): it works
like the published one but has another fingerprint, so it is admitted as unpublished.

### How a node release publishes the helper

`.github/workflows/publish-node.yml`, on the owner's `node-v<version>` tag. It runs in our cluster, not on GitHub
Actions (owner, 2026-11-11): the ci-builds engine (Argo Workflows + act, `ever-co/k8s-gitops` `apps/ci-builds`) runs the
file for every `node-v*` tag.

1. `build` builds the linux-x64 and win32-x64 helpers with `build-release-linux.sh` (pinned container, two builds
   compared, from the committed tree; `dist/linux-x64` and `dist/win32-x64`), then stages the node bundle with them
   (`apps/node/build.js`, `SCREEN_HELPER_RELEASE_DIR=native/ever-works-screen/dist`,
   `SCREEN_HELPER_REQUIRED_TARGETS=linux-x64,win32-x64`). `apps/node/screen-helper-release.js` checks each binary
   against its metadata and bakes its SHA-256 and URL,
   `https://github.com/ever-co/ever-works/releases/download/node-v<version>/ever-works-screen-<helper version>-linux-x64`
   and `…-win32-x64.exe`, into `cli.js`, which also ships the manifest as `helper-manifest.json`. A required target
   that was not built fails the release;
2. `release-screen-helper` checks the assets against the bundle npm will publish (the same `helper-manifest.json`,
   every SHA-256 in `cli.js`), uploads the binaries, `SHA256SUMS` and `helper-manifest.json` to a draft GitHub release
   of that tag and publishes the release once every asset is there (release assets of this public repository, uploaded
   with the build's token; not marked Latest). A re-run compares an asset already there with the build and never
   replaces it;
3. only then `publish` publishes the npm package that points at them (with npm provenance only where GitHub's OIDC
   token exists, so not in the cluster).

On a machine, `ever-works-node helper install` downloads its target's build and keeps it only when it hashes to the
baked fingerprint; `helper admit` shows both fingerprints and records a **published** hash-pinned admission (no
`--allow-unpublished`). A dispatch of the workflow is a dry run: it builds and bakes, uploads nothing and runs
`npm publish --dry-run`. In the cluster, by hand from the homelab repo:
`python scripts/ci-builds-run.py ever-co/ever-works <branch> publish-node.yml 4 --event workflow_dispatch --no-push`.

**macOS is not published yet.** Its helpers need a macOS build machine (Apple's SDK and linker), and the in-cluster
engine runs Linux only. Until one builds them, Macs build and admit the helper themselves (below and
[`README.md`](README.md)). `screen-helper-release.js` already takes any number of targets: a release that drops a
macOS build (binary + `unsigned-release-metadata.json`, from `build-release.sh`, `SCREEN_HELPER_TARGET=darwin-x64` for
the Intel build on Apple silicon) under `SCREEN_HELPER_RELEASE_DIR` and lists the target in
`SCREEN_HELPER_REQUIRED_TARGETS` publishes it too. Build it on a machine that runs no pull-request jobs: whatever a
release builds is baked in as the published helper.

The published builds are unsigned (hash-pinned, "Reduced trust"). Once the owner holds the signing identities, a
release adds the signed builds below and the manifest's `signedSha256` and `signer`.

## Release signing

`release-signing.json` holds the public half: the signing **identifier** stamped into every macOS signature
(`works.ever.screen-helper`), and the publisher a release names as `signer` — `darwin.teamId` and `win32.subject`, both
`null` until the owner decides who signs and publishes helper releases (FL-07 owner question 7). The identity itself
(a keychain identity, a certificate with its private key) never enters the repository; the signing machine provides it
through the environment.

| OS      | Command (after the release build)                                                                               | Environment                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| macOS   | `bash sign-release.sh dist`: `codesign` with Developer ID, the identifier, the hardened runtime and a timestamp | `SCREEN_HELPER_SIGN_IDENTITY`, `SCREEN_HELPER_TEAM_ID` (or the config) |
| Windows | `./sign-release.ps1 -OutDir dist`: Authenticode SHA-256, chain without the root, RFC 3161 timestamp             | `SCREEN_HELPER_SIGN_CERT_THUMBPRINT`, `SCREEN_HELPER_TIMESTAMP_URL`    |

Each script then checks the signature the way the node will — macOS: the Developer ID requirement of the Team ID, and
the identifier as well; Windows: `Valid`, a machine root, a timestamp — and refuses to finish otherwise. It writes
`dist/signed/` with the signed binary and `signed-release-metadata.json`, whose `sha256` (the reproducible unsigned
build), `signedSha256` and `signer` are the manifest target's fields in
`apps/node/src/core/screen/helper/helper-manifest.ts`; a release adds the download `url`. Neither script uploads
anything. The `Screen Helper` workflow
runs both as dry runs (`SCREEN_HELPER_DRY_RUN=1`: an ad hoc signature; `-DryRun`: a throwaway self-signed certificate,
removed again), which prove the commands and that such a signature is not mistaken for a release.

Open, for the owner: who holds the identities and signs (question 7); the final identifier (question 17: changing it
after the first signed release re-asks every macOS permission and breaks a requirement that pins it); and whether the
node should pin the identifier and a minimum helper version beside the Team ID (question 17), and the issuing CA on
Windows (question 18). `helper install` checks a download against `sha256` only, so a release that serves the signed
build also needs the node to accept `signedSha256` there.
