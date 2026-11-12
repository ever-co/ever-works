# `ever-works-screen`

The native screen helper behind the **Desktop** source of a computer's live view (FL-07): it captures one display and,
only while the node grants control, injects the controller's input into it. The node starts it after re-verifying it
against the owner's admission record and talks to it over stdin / stdout (`src/protocol.rs`). What ships, the trust
model and the release builds: [`PACKAGING.md`](PACKAGING.md).

## Build the helper

You need [rustup](https://rustup.rs). `rust-toolchain.toml` pins Rust **1.88.0**; the first `cargo` command in this
folder installs it with `clippy` and `rustfmt`.

| OS      | Also needed                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------ |
| Windows | MSVC build tools (Visual Studio Build Tools, "Desktop development with C++": MSVC + Windows SDK) |
| Linux   | Nothing more: the X11 client is pure Rust. It captures an X11 session; Wayland is refused        |
| macOS   | Xcode Command Line Tools (`xcode-select --install`)                                              |

```sh
cd apps/node/native/ever-works-screen
cargo build --release --locked
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --all -- --check
```

The binary is `target/release/ever-works-screen` (`ever-works-screen.exe` on Windows). `--version` prints its
version; with no argument it waits for the node's messages on stdin and exits when stdin closes.

A **release build** (twice in clean target directories, the two SHA-256 compared, `dist/` with the binary and
`unsigned-release-metadata.json`): `./build-release.ps1 -OutDir dist` on Windows, `bash build-release.sh dist` on Linux
and macOS. The `Screen Helper` workflow (`.github/workflows/screen-helper.yml`) runs all of the above on Windows, Linux
and macOS for pull requests that touch this folder, and on demand. The builds a node release publishes come from
`build-release-linux.sh`, the same in a pinned container (needs Docker), from the committed tree, so they give the same
bytes on any machine: `bash build-release-linux.sh dist/linux-x64` for Linux, and
`SCREEN_HELPER_TARGET=win32-x64 bash build-release-linux.sh dist/win32-x64` for Windows (cross-compiled with a pinned
mingw-w64 and a hash-pinned Rust standard library; Docker Desktop on Windows works).

## Install the published helper

A node release publishes the linux-x64 and win32-x64 helpers
([`PACKAGING.md`](PACKAGING.md#how-a-node-release-publishes-the-helper)), so on a Linux or Windows machine you only fetch
and approve it:

```sh
ever-works-node helper install   # downloads it and checks it against the fingerprint the node version bakes in
ever-works-node helper admit     # compare the fingerprints it prints, then type "admit"
ever-works-node helper status    # "trust  hash-pinned (Reduced trust)", no "(unpublished build)"
```

On macOS, and with a node version that publishes no helper for the machine's platform (0.2.11 and older publish none),
`helper install` says that this version publishes none: build and admit the helper yourself as below. A Windows build
of your own (`build-release.ps1`, MSVC) works the same as the published one but has another fingerprint, so it is
admitted as unpublished.

## Admit a build of your own

The node starts no helper the owner has not approved **on that machine**, and a build of your own is not in the node
package's published manifest, so it is admitted as unpublished (hash-pinned, "Reduced trust"):

```sh
# 1. Put the build somewhere stable: the node re-hashes the file before every start, and a rebuild
#    in target/ changes its bytes. The install path is "installedPath" in:
ever-works-node helper status --json
#    (<node config directory>/screen-helper/ever-works-screen[.exe]); copy the binary there.
# 2. Approve it: compare the fingerprint it prints, then type "admit".
ever-works-node helper admit --allow-unpublished
#    or approve another file, by its ABSOLUTE path:
ever-works-node helper admit --path /absolute/path/to/ever-works-screen --allow-unpublished
# 3. Check it: "trust  hash-pinned (Reduced trust)".
ever-works-node helper status
```

A running node picks the helper up on its next check. Watching needs nothing more (macOS asks for Screen Recording the
first time). **Control** of the mouse and keyboard is a second, separate approval, typed on the machine:
`ever-works-node helper control allow` (type `control`). `helper control deny` withdraws it and `helper revoke`
withdraws the helper. Replacing the file — a new build included — makes the node refuse it (`helper-untrusted`) until
you admit it again, and admitting again turns control off.

A helper from a **signed release** is approved with `ever-works-node helper admit --signed` instead, and keeps its
approval across updates by the same publisher. How a release is signed: [`PACKAGING.md`](PACKAGING.md#release-signing).
