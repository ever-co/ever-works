import { randomUUID } from 'node:crypto';

/**
 * What makes ONE credentialed `git` child — the scoped push of a finalize,
 * the scoped fetches of a provision — safe to run inside a repository whose
 * own Git config an earlier run may have written.
 *
 * ## The hole this module closes
 *
 * The credential rides the child's environment (`GIT_CONFIG_VALUE_<n>` =
 * `Authorization: Basic …`), so ANY program that child starts inherits it.
 * The checkout's shared config is writable by a run (a linked worktree's
 * `git config` lands in the bare pool's `config`), and Git lets config name
 * programs and move requests. An independent review of the scoped FETCH
 * credential reproduced it with git 2.52 against the first version of this
 * code, which judged the pool with a denylist (`credential.*`, `http.*`,
 * `url.*.insteadOf`, `remote.*.proxy`):
 *
 *     git config remote.<the https URL>.url        <a local path>
 *     git config remote.<the https URL>.uploadpack "<harvester>; git-upload-pack"
 *
 * Nothing on the denylist matched, the credential was handed over, `git
 * fetch <the https URL>` resolved the `[remote "<the https URL>"]` section,
 * followed `url` onto the file transport and ran `uploadpack` — which read
 * the header out of its environment. The merged PUSH path had the same
 * shape (`remote.<url>.receivepack`), with a `contents: write` token.
 *
 * ## Two layers, in this order
 *
 * **1. At exec time — holds whatever the config says, and whenever it was
 * written.** Jobs run in parallel on a node, so a config that was clean
 * when it was read can be poisoned a millisecond later. Everything that
 * matters for the token is therefore forced on the child itself, through
 * its environment and argv, where no config file can reach:
 *
 *  - `GIT_ALLOW_PROTOCOL` = the transport of the URL the credential was
 *    issued for (`https` for every credential the fleet issues). An
 *    ENVIRONMENT variable, not `protocol.*.allow`: measured, a pool that
 *    sets `protocol.file.allow=always` beats a command-scope
 *    `protocol.allow=never`, because the more specific key wins whatever
 *    its scope. `GIT_ALLOW_PROTOCOL` replaces the whole policy.
 *  - the remote is addressed by a PRIVATE NAME that exists only in this
 *    child's environment ({@link privateRemoteName}), never by its URL. Git
 *    reads `remote.<name>.*` for a fetch-by-URL when a section is NAMED by
 *    that URL; a name minted per invocation is one no config can describe.
 *  - {@link credentialedCommandEntries}: command-scope config, which Git
 *    reads last, for every remaining key that can run a program or move
 *    the connection.
 *
 * **2. Before it — an allowlist over the repository's own config.**
 * {@link foreignRepositoryConfig} reads every key of the `local` and
 * `worktree` scopes (includes followed) and names any that is not one this
 * provider writes, one Git writes on its own, or one known to be inert for
 * a fetch or a push. A fetch then WITHHOLDS its credential and runs as it
 * always did; a push REFUSES. This layer is the one that says "this pool
 * has been tampered with"; layer 1 is the one that does not depend on
 * having noticed.
 *
 * ## The key table
 *
 * Every Git config key that can execute a program or redirect a request,
 * from git-config(1), and what happens to it for a credentialed child.
 * "Measured" = reproduced with real git 2.52 while writing this module and
 * pinned by `credentialed-command.attacks.spec.ts`.
 *
 * | Key | Risk to the token | Exec time (layer 1) | Allowlist (layer 2) |
 * | --- | --- | --- | --- |
 * | `remote.<url>.uploadpack` / `.receivepack` | program run by the file / ssh transport — measured, both | dead: private remote name; transport not allowed | blocks |
 * | `remote.<url>.url` / `.pushurl` | moves the request to a local path, ssh or another host — measured | dead: private remote name | blocks |
 * | `remote.<url>.vcs` | runs `git-remote-<vcs>` | dead: private remote name; helper transport not allowed | blocks |
 * | `remote.<url>.proxy` / `.proxyAuthMethod` | routes through a proxy — measured | dead: private remote name | blocks |
 * | `remote.<name>.mirror` / `.prune*` / `.fetch` / `.push` / `.tagOpt` | changes which refs move | dead for the URL: private remote name | plain-named remotes allowed |
 * | `remote.<private name>.proxy` / `.proxyAuthMethod` | the one remote key that OUTRANKS `http.<url>.proxy` — measured against a recording proxy; writable only by someone who read the name off the running command's argv | pinned on the private remote itself, to the value the `http.<url>.proxy` pin carries — measured: planted as the fetch starts, the proxy sees nothing | blocks: the `ew-credentialed-` prefix is reserved (case-sensitive, as Git compares subsections), no file may hold a section for it |
 * | `url.<base>.insteadOf` / `.pushInsteadOf` | rewrites the URL Git connects to | other transports refused; the header is keyed to the ORIGINAL URL, so another https host is sent nothing — measured | blocks; in the OPERATOR's scopes it withholds / refuses with its own reason — see below |
 * | `protocol.*.allow` | re-allows a transport — measured to beat command-scope config | ignored: `GIT_ALLOW_PROTOCOL` | blocks |
 * | `core.sshCommand`, `ssh.variant` | program run by the ssh transport — measured | transport not allowed | blocks |
 * | `core.gitProxy` | program run by the `git://` transport | transport not allowed | blocks |
 * | `core.hooksPath` (+ the hooks themselves) | `reference-transaction` on fetch — measured; `pre-push` | overridden: an empty directory for a fetch; for a push the empty value it always had (measured: hooks then resolve under the filesystem root, not the repository) plus `--no-verify` | allowed (husky writes it) |
 * | `core.fsmonitor` | hook program on index reads | overridden `false` | allowed |
 * | `core.alternateRefsCommand` | program run during fetch negotiation when the pool has alternates — measured | overridden to empty | blocks |
 * | `core.unsetEnvVars` (Git for Windows) | strips named environment variables from Git's children — measured to remove `GIT_ALLOW_PROTOCOL` | pinned to the operator's value, else the default | blocks |
 * | `core.askPass`, `GIT_ASKPASS`, `SSH_ASKPASS` | program asked for a password after a rejected header | overridden to empty; variables removed | blocks |
 * | `credential.helper`, `credential.<url>.*` | program asked for a password | helper list reset | blocks |
 * | `gc.recentObjectsHook` | program run by the gc a fetch triggers (documented; not reproduced here) | no gc in the child: `maintenance.auto=false`, `gc.auto=0` | blocks |
 * | `gpg.program`, `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand`, `push.gpgSign` | signing program on a signed push | `push.gpgSign=false`, so nothing is signed — measured, one case per key | allowed |
 * | `push.negotiate` | the push starts `git fetch --negotiate-only <URL>` — BY URL, so `[remote "<url>"]` applies to that grandchild — measured: a planted `uploadpack` ran there with the header | overridden `false` | allowed |
 * | `fetch.recurseSubmodules`, `submodule.<n>.fetchRecurseSubmodules`, `push.recurseSubmodules` | a second fetch / push inside a repository under the pool | `--no-recurse-submodules` (fetch), `push.recurseSubmodules=no` | `submodule.*` allowed |
 * | `http.sslVerify` | accepts any certificate | pinned at the exact URL to the operator's value, else `true` — measured | blocks |
 * | `http.proxy`, `http.curloptResolve` | routes or resolves the connection elsewhere — measured | pinned at the exact URL to the operator's value, else the environment's proxy / none; resolutions reset — measured | blocks |
 * | `http.followRedirects`, `http.schannelUseSSLCAInfo` | follow every redirect; honour a planted CA bundle under schannel | pinned to the operator's value, else the default | blocks |
 * | `http.sslCAInfo`, `http.sslCAPath`, `http.sslBackend` | trusts a planted CA | re-asserted at the exact URL when the operator set one; **otherwise not overridable** — Git has no value meaning "the built-in default" | blocks |
 * | `http.extraHeader` | a second header on the request (cannot read ours) | not overridden | blocks |
 * | other `http.*` (`cookieFile`, `sslCert`, `pinnedPubkey`, …) | none for the token | not overridden | blocks, except transfer tuning |
 * | `include.path`, `includeIf.*` | pulls any of the above in from another file | whatever it pulls in is read BEFORE command scope | followed, then blocks |
 * | `extensions.worktreeConfig`, `extensions.relativeWorktrees` | adds the per-worktree file; records how worktrees are linked | same overrides | allowed; that file is read too |
 * | `extensions.partialClone`, `remote.<name>.promisor`, `.partialCloneFilter` | a missing object makes the command start `git fetch <promisor remote>` — a grandchild that names a remote the config DOES describe — measured: a planted promisor remote ran `core.sshCommand` with the header | the grandchild inherits this environment: one transport, the header keyed to the original URL, every override — measured | allowed (Git writes them itself after `fetch --filter`) |
 * | `fetch.bundleURI`, `promisor.*` | downloads from another URI — never with our header | none needed | blocks |
 * | `core.editor`, `core.pager`, `pager.*`, `sequence.editor` | none: Git starts a pager only on a terminal and an editor only to edit — measured, one case per key | n/a | allowed |
 * | `diff.<x>.textconv` / `.command`, `diff.external`, `merge.<x>.driver`, `filter.<x>.clean` / `.smudge` / `.process`, `mergetool.*`, `difftool.*` | none: a fetch or a push converts, merges and diffs no content — measured, one case per key, with `info/attributes` selecting the driver | n/a | allowed |
 * | `submodule.<x>.update` (`!command`), `lfs.customtransfer.<x>.path` | none: run by `git submodule update` and by git-lfs, and a credentialed fetch or push starts neither (no recursion, no hooks) — measured | n/a | allowed (`submodule.*`, `lfs.*`) |
 * | `alias.*` | none: Git never lets an alias stand in for a command that exists — measured for every command a fetch or a push starts | n/a | allowed |
 * | `color.*`, `i18n.*` | none: they name no program | n/a | allowed |
 * | `GIT_TRACE*`, `GIT_CURL_VERBOSE` (environment) | Git writes the request, header included, to the file they name — measured: `GIT_TRACE2_EVENT`, and `GIT_TRACE_CURL` with `GIT_TRACE_REDACT=0` | removed from the child's environment | n/a: not config |
 * | `trace2.eventTarget` / `.normalTarget` / `.perfTarget` (system / global config) | with `trace2.configParams` matching `http.*` the event stream records the command-scope config, header included — measured | `GIT_TRACE2`, `GIT_TRACE2_EVENT`, `GIT_TRACE2_PERF` = `0` in the child: Git reads these keys from system and global only, so command scope cannot turn them off; the variable can | n/a: the operator's scopes |
 * | `uploadpack.*`, `receive.*`, `uploadarchive.*` | server side of a local transport | transport not allowed (https) | blocks |
 * | `safe.*`, `uploadpack.packObjectsHook` | none: Git reads them from system / global config only | n/a | `safe.*` allowed |
 *
 * ## A rewrite in the operator's own config
 *
 * `url.<base>.insteadOf` in the machine's global or system config is an
 * ordinary developer setup (`https://github.com/` → ssh). The repository's
 * own rewrites never get this far — the allowlist blocks them. The
 * operator's are trusted, and trusting them used to arm the credential and
 * then kill the command: the rewritten URL leaves the one transport the
 * child may speak (`fatal: transport 'ssh' not allowed`), so a job that
 * cloned over the machine's SSH key stopped cloning. So
 * {@link effectiveRemoteUrls} works out, from the same listing, the URL Git
 * will really use, and a credential is armed only when that is still the
 * URL it was issued for. Otherwise a fetch WITHHOLDS and runs as it always
 * did, over whatever the rewrite points at; a push REFUSES, in one
 * sentence that names the rewrite's scope and not its value — also when a
 * plain `insteadOf` already made `git remote get-url origin` disagree with
 * the credential, which the push checks first.
 *
 * ## When the allowlist says no
 *
 * What is refused is named (`section.variable`, never a subsection or a
 * value) together with the commands that remove it ({@link recoveryHint}),
 * because the refusal lasts as long as the key does: the pool is shared by
 * every Task of that repository on that machine, and nothing else cleans
 * its config. Where a key's subsection cannot be printed, the command
 * lists the full names, and it lists exactly what the allowlist refuses —
 * following it never removes `remote.origin.url`.
 *
 * This module does NOT remove the key itself, on purpose:
 *
 *  - what is left to refuse, now that everything a fetch or a push never
 *    reads is allowed, is a key that can run a program or move a request,
 *    or one nobody has classified. The first is evidence that something on
 *    this machine tried to take Git over: deleting it on the way past
 *    repairs the symptom and destroys the evidence, silently, from inside
 *    the one code path that holds a credential. The second is not this
 *    code's to judge.
 *  - a gate that rewrites the file it is judging becomes a writer racing
 *    every other job's `git config` on the same pool (Git's config lock
 *    makes the loser fail), in the middle of a provision or a publish.
 *  - nothing is lost by not doing it: layer 1 holds either way, a fetch
 *    still runs (without the credential), and a push says exactly what to
 *    remove.
 *
 * Some of what is still refused, layer 1 already makes harmless to the
 * credentialed child: `core.sshCommand`, `ssh.variant`, `core.gitProxy`
 * (no transport but the credential's own), `protocol.*.allow`
 * (`GIT_ALLOW_PROTOCOL`), `credential.*` and `core.askPass` (reset),
 * `core.alternateRefsCommand` (emptied), `remote.<url>.*` (private name).
 * They stay refused on purpose: nothing a fleet node or common tooling
 * does writes them into a pool, so finding one is the tamper signal this
 * layer exists to give; and refusing them is the second wall should a
 * layer-1 pin ever be lost. Mutation runs of
 * `credentialed-command.attacks.spec.ts` show what that wall is worth:
 * without the private name, `GIT_ALLOW_PROTOCOL` or the
 * `core.alternateRefsCommand` override, the "planted between" cases go
 * red while the "planted before" cases — this layer — still hold.
 *
 * Clearing a tampered pool is an operator's decision, taken with the key
 * still there to look at. The commands are in the message.
 *
 * NOT closed at exec time, stated rather than hidden: a planted
 * `http.sslCAInfo` / `sslCAPath` on a machine whose operator configured no
 * CA bundle (the built-in default cannot be re-asserted), or any `http.*`
 * key on a machine whose operator uses URL-specific `http.<url>.*`
 * settings (this module does not re-implement Git's URL matching, so it
 * leaves those alone). For those the allowlist is the control, and a
 * config written between the allowlist read and the command is not seen.
 * With the proxy and the resolutions pinned, a planted CA additionally
 * needs an interception position on the network path.
 *
 * And one assumption, also stated: the `system` and `global` scopes are
 * taken to be the operator's. "Pin the operator's posture" re-asserts what
 * they say, so a process able to write the node account's own
 * `~/.gitconfig` is outside what this module defends against — as is one
 * able to read another process's environment, which is where the
 * credential lives while its command runs.
 */

/** The transports a credentialed child may speak. */
export type CredentialedProtocol = 'https' | 'file';

/**
 * The ONE transport a child carrying this credential may use: the one of
 * the URL the credential was issued for.
 *
 * `https` is every credential the fleet issues — the platform and the node
 * both refuse anything that is not `https://github.com/…` before a provider
 * sees it. `file` is here for the hermetic real-git suites (a bare
 * repository on disk standing in for the remote) and for a local mirror:
 * there is no header on that wire at all, and with the remote addressed by
 * a private name no `uploadpack` / `receivepack` a config names is used.
 *
 * Anything else is null, and the credential is not used: `http` would put
 * the header on the wire in clear, and for `ssh`, `git` or a helper an HTTP
 * header authenticates nothing.
 */
export function credentialedProtocol(remoteUrl: string): CredentialedProtocol | null {
	let url: URL;
	try {
		url = new URL(remoteUrl);
	} catch {
		return null;
	}
	if (url.protocol === 'https:') return 'https';
	if (url.protocol === 'file:') return 'file';
	return null;
}

/**
 * A remote name minted for ONE command. It is the argument the credentialed
 * `git fetch` / `git push` names, and `remote.<name>.url` is defined in that
 * child's environment only — so no `[remote "…"]` section in any file can
 * be about it.
 */
export function privateRemoteName(): string {
	return `${RESERVED_REMOTE_PREFIX}${randomUUID()}`;
}

/**
 * Every private remote starts with this, and the prefix is RESERVED: the
 * allowlist refuses any `[remote "ew-credentialed-…"]` section in a config
 * file, whatever it holds. A name is in its command's argv while that
 * command runs, so "nobody can know it" is true before the command and
 * not during it. Compared case-sensitively, as Git compares subsection
 * names (measured: `remote.EW-X.proxy` is not `remote.ew-x.proxy`), and a
 * minted name is always lower case.
 */
export const RESERVED_REMOTE_PREFIX = 'ew-credentialed-';

/** One key of `git config --show-scope --list -z`. */
export interface ScopedConfigEntry {
	readonly scope: string;
	readonly key: string;
	readonly value: string;
}

/**
 * Every config key Git would read in a directory, with the scope it comes
 * from. `--list` without a file option follows `include.path` /
 * `includeIf`, and reports `worktree` scope when
 * `extensions.worktreeConfig` is on. `-z` because a value may hold a
 * newline; the values never leave the process.
 */
export const SCOPED_CONFIG_LIST_ARGS: readonly string[] = ['config', '--show-scope', '--list', '-z'];

/**
 * Parse {@link SCOPED_CONFIG_LIST_ARGS}' output: `<scope> NUL <key> LF
 * <value> NUL`, repeated. Null when it is not that shape — an unreadable
 * config is never read as an empty one.
 */
export function parseScopedConfigList(stdout: string): ScopedConfigEntry[] | null {
	const tokens = stdout.split('\0');
	// A well-formed listing ends with a NUL, so the last token is empty.
	if (tokens.pop() !== '' || tokens.length % 2 !== 0) return null;
	const entries: ScopedConfigEntry[] = [];
	for (let index = 0; index < tokens.length; index += 2) {
		const scope = tokens[index];
		const pair = tokens[index + 1];
		if (!scope || !pair) return null;
		const newline = pair.indexOf('\n');
		const key = newline === -1 ? pair : pair.slice(0, newline);
		if (!key.includes('.')) return null;
		entries.push({ scope, key, value: newline === -1 ? '' : pair.slice(newline + 1) });
	}
	return entries;
}

/**
 * Scopes only the machine's operator writes. Everything else — `local`,
 * `worktree`, and any scope name this code does not know — is the
 * repository's own, which a run can write.
 */
const OPERATOR_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);

interface ConfigKeyParts {
	readonly section: string;
	readonly subsection: string | null;
	readonly variable: string;
}

/** Git prints the section and the variable lower-cased and the subsection verbatim. */
function keyParts(key: string): ConfigKeyParts {
	const first = key.indexOf('.');
	const last = key.lastIndexOf('.');
	// Every real key has a section and a variable; one that does not is
	// nobody's, and an empty section is on no list.
	if (first <= 0 || last === key.length - 1) return { section: '', subsection: null, variable: '' };
	return {
		section: key.slice(0, first).toLowerCase(),
		subsection: first === last ? null : key.slice(first + 1, last),
		variable: key.slice(last + 1).toLowerCase()
	};
}

/**
 * A variable NAME that names something Git runs. A section allowed
 * wholesale below is allowed for its settings, not for the programs it can
 * name, so a variable that looks like one is refused there — the guard
 * against the next `gc.recentObjectsHook`. The exceptions are spelled out
 * in {@link UNREACHABLE_PROGRAM_VARIABLES}.
 */
const PROGRAM_NAMING_VARIABLE =
	/(hook|command|cmd|program|driver|textconv|external|editor|pager|helper|askpass|proxy)$/;

/**
 * Variables in the inert sections that DO name a program (or look as if
 * they did), and are allowed anyway because neither a fetch nor a push can
 * reach the code that would run it. Each one is pinned by a real-git case
 * in `credentialed-command.attacks.spec.ts` ("keys that name a program a
 * fetch or a push never starts"): planted with a harvester, the
 * credentialed fetch and push are run, and the harvester has not run.
 *
 *  - `diff.<driver>.textconv`, `diff.<driver>.command`, `diff.external` —
 *    run by the diff machinery when it shows file CONTENT. A fetch and a
 *    push show none (gitdiffcore(7); `fetch.recurseSubmodules`, the one
 *    place a fetch walks a diff, compares gitlinks only and is off here).
 *  - `merge.<driver>.driver` — run by a three-way file merge
 *    (gitattributes(5), "Defining a custom merge driver"). Neither command
 *    merges.
 *  - `color.pager` — a boolean, not a program, whatever its name says.
 */
const UNREACHABLE_PROGRAM_VARIABLES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['diff', new Set(['textconv', 'command', 'external'])],
	['merge', new Set(['driver'])],
	['color', new Set(['pager'])]
]);

/**
 * Sections allowed with EVERY variable, the ones that name programs
 * included, because a fetch or a push reads none of it (same real-git
 * cases as above):
 *
 *  - `alias` — "aliases that hide existing Git commands are ignored"
 *    (git-config(1)), and `fetch` / `push` and everything they start are
 *    existing commands.
 *  - `pager` — `pager.<cmd>` may be a command, and Git starts a pager only
 *    when its output is a terminal (git-config(1): "when writing to a
 *    tty"). A child of this provider writes to a pipe.
 *  - `sequence` — `sequence.editor` is the editor of `rebase -i`.
 *  - `i18n` — encodings.
 *  - `gpg` — the signing program, its format, the ssh key command. A fetch
 *    signs and verifies nothing; a push signs only with `--signed` /
 *    `push.gpgSign`, which the child pins to `false`.
 *  - `mergetool`, `difftool` — the tools of `git mergetool` / `git
 *    difftool`, which are interactive commands of their own.
 *  - `filter` — `clean` / `smudge` / `process` run when content moves
 *    between the index and the working tree; neither command moves any.
 */
const UNREACHABLE_SECTIONS: ReadonlySet<string> = new Set([
	'alias',
	'pager',
	'sequence',
	'i18n',
	'gpg',
	'mergetool',
	'difftool',
	'filter'
]);

/**
 * Sections whose every variable is inert for `git fetch` / `git push`:
 * identity, porcelain defaults, object-storage tuning, and what common
 * tooling writes into a checkout (`submodule.*` by `git submodule init`,
 * `lfs.*` by git-lfs). Named one by one; a section that is neither here nor
 * in {@link UNREACHABLE_SECTIONS} is refused.
 */
const INERT_SECTIONS: ReadonlySet<string> = new Set([
	'user',
	'author',
	'committer',
	'commit',
	'tag',
	'branch',
	'color',
	'advice',
	'init',
	'pull',
	'rebase',
	'merge',
	'diff',
	'status',
	'log',
	'format',
	'pretty',
	'blame',
	'grep',
	'column',
	'add',
	'apply',
	'am',
	'clean',
	'checkout',
	'stash',
	'rerere',
	'notes',
	'mailmap',
	'pack',
	'repack',
	'index',
	'feature',
	'commitgraph',
	'maintenance',
	'gc',
	'fsck',
	'sparse',
	'worktree',
	'versionsort',
	'safe',
	'lfs',
	'submodule'
]);

/** `core.*`: what `git init` / `git worktree add` write, what layer 1 overrides, and plain file-handling switches. */
const CORE_VARIABLES: ReadonlySet<string> = new Set([
	// Written by Git itself.
	'repositoryformatversion',
	'filemode',
	'bare',
	'logallrefupdates',
	'ignorecase',
	'symlinks',
	'precomposeunicode',
	'hidedotfiles',
	// Overridden for the credentialed child, and written by real tooling
	// (`husky` sets `core.hooksPath` on every `pnpm install`).
	'hookspath',
	'fsmonitor',
	'fsmonitorhookversion',
	// Programs Git starts for a terminal user only: an editor when there is
	// something to edit, a pager when its output is a terminal. A fetch or a
	// push through this provider has neither (pinned by the real-git cases
	// named at `UNREACHABLE_PROGRAM_VARIABLES`).
	'editor',
	'pager',
	// File handling in a working tree; a fetch or a push reads none of it.
	'autocrlf',
	'eol',
	'safecrlf',
	'longpaths',
	'quotepath',
	'whitespace',
	'abbrev',
	'commentchar',
	'commentstring',
	'excludesfile',
	'attributesfile',
	'untrackedcache',
	'fscache',
	'preloadindex',
	'trustctime',
	'checkstat',
	'protecthfs',
	'protectntfs',
	'compression',
	'loosecompression',
	'bigfilethreshold',
	'deltabasecachelimit',
	'packedgitlimit',
	'packedgitwindowsize',
	'splitindex',
	'sparsecheckout',
	'sparsecheckoutcone',
	'multipackindex',
	'commitgraph',
	'notesref',
	'sharedrepository',
	'warnambiguousrefs',
	'ignorestat',
	'fsync',
	'fsyncmethod',
	'fsyncobjectfiles'
]);

/** A remote name that cannot be a URL (no `:` and no `/`), so its section is not about the command's remote. */
const PLAIN_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REMOTE_VARIABLES: ReadonlySet<string> = new Set([
	'url',
	'fetch',
	'pushurl',
	'push',
	'tagopt',
	'prune',
	'prunetags',
	'skipdefaultupdate',
	'skipfetchall',
	// The GitHub CLI records which remote is the base repository here.
	'gh-resolved',
	// Written by Git itself after `git fetch --filter=…` (measured, git
	// 2.52). They make a missing object start `git fetch <that remote>`, a
	// grandchild of the credentialed command that inherits everything layer
	// 1 put in its environment — see the key table.
	'promisor',
	'partialclonefilter'
]);
/** `http.*` with no host in the key and no say over where the request goes or whom it trusts. */
const HTTP_TUNING_VARIABLES: ReadonlySet<string> = new Set([
	'postbuffer',
	'lowspeedlimit',
	'lowspeedtime',
	'maxrequests',
	'minsessions',
	'version',
	'noepsv',
	'keepaliveidle',
	'keepaliveinterval',
	'keepalivecount'
]);
const FETCH_VARIABLES: ReadonlySet<string> = new Set([
	'prune',
	'prunetags',
	'fsckobjects',
	'parallel',
	'output',
	'negotiationalgorithm',
	'writecommitgraph',
	'showforcedupdates',
	'unpacklimit',
	'recursesubmodules'
]);
const PUSH_VARIABLES: ReadonlySet<string> = new Set([
	'default',
	'autosetupremote',
	'followtags',
	'useforceifincludes',
	'usebitmaps',
	'recursesubmodules',
	// Both are overridden for the credentialed push (`false`), so what the
	// repository says about them is never read.
	'negotiate',
	'gpgsign'
]);
const EXTENSION_VARIABLES: ReadonlySet<string> = new Set([
	'objectformat',
	'refstorage',
	'worktreeconfig',
	// Written by Git itself: by `clone --filter`, and (2.48+) by `worktree
	// add --relative-paths` / `worktree.useRelativePaths`.
	'partialclone',
	'relativeworktrees'
]);

/**
 * May the repository's own config carry this key while a credentialed
 * command runs? The key table at the top of this module is the reasoning;
 * this is the list.
 */
export function isAllowedRepositoryConfigKey(key: string): boolean {
	const { section, subsection, variable } = keyParts(key);
	if (!section || !variable) return false;
	switch (section) {
		case 'core':
			return subsection === null && CORE_VARIABLES.has(variable);
		case 'extensions':
			return subsection === null && EXTENSION_VARIABLES.has(variable);
		case 'remote':
			// `remote.pushDefault` only picks a remote for a push that names
			// none; a credentialed command always names its own.
			if (subsection === null) return variable === 'pushdefault';
			// Reserved: a file that describes a private remote is describing a
			// credentialed command, and nothing legitimate does.
			if (subsection.startsWith(RESERVED_REMOTE_PREFIX)) return false;
			return PLAIN_REMOTE_NAME.test(subsection) && REMOTE_VARIABLES.has(variable);
		case 'http':
			return subsection === null && HTTP_TUNING_VARIABLES.has(variable);
		case 'fetch':
			return subsection === null && FETCH_VARIABLES.has(variable);
		case 'push':
			return subsection === null && PUSH_VARIABLES.has(variable);
		case 'transfer':
			return subsection === null && variable === 'fsckobjects';
		default:
			if (UNREACHABLE_SECTIONS.has(section)) return true;
			if (!INERT_SECTIONS.has(section)) return false;
			return (
				!PROGRAM_NAMING_VARIABLE.test(variable) ||
				UNREACHABLE_PROGRAM_VARIABLES.get(section)?.has(variable) === true
			);
	}
}

/**
 * The repository-scope keys that are NOT on the allowlist, named for an
 * operator — `section.variable`, with a subsection shown only as `<…>`.
 *
 * Never the subsection and never the value: a subsection is free text
 * (`url.https://user:token@host/.insteadOf` is a real way people persist a
 * credential) and this text ends up in a job result.
 */
export function foreignRepositoryConfig(entries: readonly ScopedConfigEntry[]): string[] {
	const foreign = new Set<string>();
	for (const entry of entries) {
		if (OPERATOR_SCOPES.has(entry.scope)) continue;
		if (isAllowedRepositoryConfigKey(entry.key)) continue;
		foreign.add(displayConfigKey(entry.key));
	}
	return [...foreign];
}

/** A section or variable name that is safe to print and to put in a command line. */
const PRINTABLE_NAME = /^[a-z0-9-]+$/;

/**
 * A config key as it may be SHOWN: `section.variable`, or
 * `section.<…>.variable` when it has a subsection. The subsection itself is
 * never printed — it is free text, and a URL with userinfo is a perfectly
 * valid one.
 */
export function displayConfigKey(key: string): string {
	const { section, subsection, variable } = keyParts(key);
	const safe = (text: string): string => (PRINTABLE_NAME.test(text) ? text : '<…>');
	return subsection === null ? `${safe(section)}.${safe(variable)}` : `${safe(section)}.<…>.${safe(variable)}`;
}

/**
 * How an operator removes what {@link foreignRepositoryConfig} named, as
 * text for the refusal — because the refusal lasts exactly as long as the
 * key does, and nothing else will remove it.
 *
 * `names` are that function's output, so there is nothing here to leak: a
 * key without a subsection is unset by name; a key WITH one cannot be
 * named (the subsection is never printed), so the command that lists its
 * full names on the machine is given instead, and the unset takes each of
 * those. `--show-origin` because a key that came in through `include.path`
 * lives in another file — there the include is what is removed, and it is
 * on the list itself.
 *
 * The listing matches exactly the keys the allowlist refuses, never one it
 * allows: for the `remote` variables a plain-named remote may carry (`url`,
 * `fetch`, …) only the subsections that are not a plain remote name, or
 * that use the reserved prefix — so unsetting everything it lists for
 * `remote.<…>.url` cannot take `remote.origin.url` with it.
 *
 * `directory` is the shared repository the key was found in. It is a path
 * on the node, and the job result it lands in is the node operator's.
 */
export function recoveryHint(names: readonly string[], directory: string): string {
	const git = `git -C "${directory.replace(/\\/g, '/')}" config`;
	const plain: string[] = [];
	const patterns: string[] = [];
	let unprintable = false;
	for (const name of names) {
		const parts = name.split('.');
		if (parts.some((part) => part !== '<…>' && !PRINTABLE_NAME.test(part)) || name.startsWith('<…>')) {
			unprintable = true;
		} else if (parts.length === 2 && !name.endsWith('<…>')) {
			plain.push(name);
		} else if (parts.length === 3 && parts[1] === '<…>' && parts[2] !== '<…>') {
			patterns.push(listingPattern(parts[0], parts[2]));
		} else {
			unprintable = true;
		}
	}
	const steps: string[] = [];
	for (const name of plain) steps.push(`${git} --unset-all ${name}`);
	if (patterns.length > 0 || unprintable) {
		const listing = unprintable
			? `${git} --show-origin --show-scope --list --name-only`
			: `${git} --show-origin --name-only --get-regexp "${patterns.join('|')}"`;
		steps.push(`${listing} (lists the full names; then ${git} --unset-all <name> for each)`);
	}
	return `To clear it on this machine: ${steps.join('; ')}`;
}

/**
 * The `git config --get-regexp` pattern (POSIX extended, against the key as
 * Git prints it) for every `section.<subsection>.variable` the allowlist
 * refuses. Outside `remote` that is every subsection, because none of those
 * decisions depends on it; inside `remote`, for the variables a plain-named
 * remote may carry, it is the subsections that are empty, start with
 * something other than a letter or digit, hold a character a plain name
 * cannot, or use the reserved prefix — the negation of
 * {@link PLAIN_REMOTE_NAME} plus {@link RESERVED_REMOTE_PREFIX}.
 */
function listingPattern(section: string, variable: string): string {
	if (section === 'remote' && REMOTE_VARIABLES.has(variable)) {
		return `^remote\\.(([^A-Za-z0-9].*)?|.*[^A-Za-z0-9._-].*|${RESERVED_REMOTE_PREFIX}.*)\\.${variable}$`;
	}
	return `^${section}\\..*\\.${variable}$`;
}

/**
 * The URLs Git will really use for a remote whose `url` is `remoteUrl`,
 * once `url.<base>.insteadOf` / `url.<base>.pushInsteadOf` from EVERY scope
 * have been applied — Git's own rule (`remote.c`, `alias_url`): the longest
 * `insteadOf` value that is a prefix of the URL wins and is replaced by its
 * `<base>`; a push uses `pushInsteadOf` the same way when one matches (the
 * remote has no `pushurl` of its own) and the fetch URL otherwise.
 *
 * Worked out from the listing the allowlist already read, so it costs no
 * process, and pinned against Git itself: `credentialed-command.attacks.spec.ts`
 * runs real `git remote -v` under the same scratch configs and requires the
 * same answer.
 *
 * `fetchRule` / `pushRule` say which key and scope did the rewriting — for
 * the message, which names those and never the value.
 */
export function effectiveRemoteUrls(
	entries: readonly ScopedConfigEntry[],
	remoteUrl: string
): {
	readonly fetch: string;
	readonly push: string;
	readonly fetchRule: RewriteRule | null;
	readonly pushRule: RewriteRule | null;
} {
	const rewrite = (variable: 'insteadof' | 'pushinsteadof'): { url: string; rule: RewriteRule } | null => {
		// Git keeps one list of prefixes PER BASE, bases in the order they
		// first appear, and walks base by base — which is what decides a tie
		// between two bases that claim the same prefix.
		const byBase = new Map<string, Array<{ prefix: string; scope: string }>>();
		for (const entry of entries) {
			const parts = keyParts(entry.key);
			if (parts.section !== 'url' || parts.variable !== variable || parts.subsection === null) continue;
			const prefixes = byBase.get(parts.subsection) ?? [];
			prefixes.push({ prefix: entry.value, scope: entry.scope });
			byBase.set(parts.subsection, prefixes);
		}
		let best: { base: string; prefix: string; scope: string } | null = null;
		for (const [base, prefixes] of byBase) {
			for (const { prefix, scope } of prefixes) {
				if (!remoteUrl.startsWith(prefix)) continue;
				// Strictly longer only: among equals Git keeps the first.
				if (best && best.prefix.length >= prefix.length) continue;
				best = { base, prefix, scope };
			}
		}
		if (!best) return null;
		return {
			url: `${best.base}${remoteUrl.slice(best.prefix.length)}`,
			rule: { key: `url.<…>.${variable}`, scope: best.scope }
		};
	};
	const fetched = rewrite('insteadof');
	const pushed = rewrite('pushinsteadof');
	const fetch = fetched?.url ?? remoteUrl;
	return {
		fetch,
		push: pushed?.url ?? fetch,
		fetchRule: fetched?.rule ?? null,
		pushRule: pushed?.rule ?? fetched?.rule ?? null
	};
}

/** The key and scope of a URL rewrite — never its value. */
export interface RewriteRule {
	readonly key: string;
	readonly scope: string;
}

type OperatorPosture =
	| { readonly kind: 'unset' }
	| { readonly kind: 'value'; readonly value: string }
	| { readonly kind: 'scoped' };

/**
 * What the OPERATOR's scopes say about one single-valued key.
 *
 * `scoped` = at least one URL-specific form (`http.<url>.<variable>`).
 * Working out which of those applies to a given URL is Git's urlmatch, and
 * a second implementation of it that disagreed with Git's would pin the
 * wrong value on somebody's proxy; so such a key is left exactly as it is.
 */
function operatorPosture(entries: readonly ScopedConfigEntry[], section: string, variable: string): OperatorPosture {
	let value: string | null = null;
	for (const entry of entries) {
		if (!OPERATOR_SCOPES.has(entry.scope)) continue;
		const parts = keyParts(entry.key);
		if (parts.section !== section || parts.variable !== variable) continue;
		if (parts.subsection !== null) return { kind: 'scoped' };
		value = entry.value;
	}
	return value === null ? { kind: 'unset' } : { kind: 'value', value };
}

/**
 * The proxy Git itself would take from the environment for an https URL
 * when no `http.proxy` is configured, in Git's own order (`http.c`): the
 * lower-case name wins over the upper-case one, `all_proxy` is consulted
 * only when neither https variable is set, and a variable that is set but
 * empty means "no proxy". Empty when there is none.
 */
function environmentProxy(env: NodeJS.ProcessEnv): string {
	let proxy: string | undefined;
	for (const name of ['HTTPS_PROXY', 'https_proxy']) {
		if (env[name] !== undefined) proxy = env[name];
	}
	if (proxy === undefined) {
		for (const name of ['ALL_PROXY', 'all_proxy']) {
			if (env[name] !== undefined) proxy = env[name];
		}
	}
	return proxy ?? '';
}

/**
 * The command-scope config a credentialed child is given on top of the
 * four credential entries — layer 1 of this module.
 *
 * Command scope is read LAST, so each entry here is the final word on its
 * key over the system, global, local and worktree files, and over anything
 * those include. The connection settings are keyed to the exact URL, which
 * is the most specific form Git's `http.<url>.*` matching has (measured: a
 * pool that plants `http.<the same URL>.proxy` still loses to the later,
 * equally specific entry).
 *
 * The rule for the connection settings is "pin the operator's posture,
 * never invent one": where the operator's own scopes set a value it is
 * re-asserted, where they set none the default is, and a URL-specific
 * operator setting is left alone. So a machine behind a corporate proxy,
 * or one whose operator switched verification off, behaves exactly as it
 * did — only the repository's own config stops having a say.
 */
export function credentialedCommandEntries(input: {
	readonly remoteName: string;
	readonly remoteUrl: string;
	readonly protocol: CredentialedProtocol;
	readonly config: readonly ScopedConfigEntry[];
	readonly env: NodeJS.ProcessEnv;
}): Array<[string, string]> {
	const { remoteName, remoteUrl, config } = input;
	const entries: Array<[string, string]> = [
		// The remote this command names. Its only definition.
		[`remote.${remoteName}.url`, remoteUrl],
		// Programs a fetch or a push could otherwise be made to start.
		['core.fsmonitor', 'false'],
		['core.alternateRefsCommand', ''],
		['maintenance.auto', 'false'],
		['gc.auto', '0'],
		['push.gpgSign', 'false'],
		// A second fetch / push inside a repository under this one.
		['fetch.recurseSubmodules', 'false'],
		['push.recurseSubmodules', 'no'],
		// With it on, a push first runs `git fetch --negotiate-only … <URL>`:
		// a grandchild addressed BY URL, to which every `[remote "<url>"]`
		// section this module steers the command itself around applies again.
		// Measured: a planted `uploadpack` ran there, header in its environment.
		['push.negotiate', 'false']
	];

	// Git for Windows unsets the variables this key names before it starts
	// any child. Measured: planted in a pool, it removed `GIT_ALLOW_PROTOCOL`
	// from the transport's children. `PERL5LIB` is Git's own default.
	const unset = operatorPosture(config, 'core', 'unsetenvvars');
	entries.push(['core.unsetenvvars', unset.kind === 'value' ? unset.value : 'PERL5LIB']);

	if (input.protocol !== 'https') return entries;

	const pin = (variable: string, name: string, fallback: string): void => {
		const posture = operatorPosture(config, 'http', variable);
		if (posture.kind === 'scoped') return;
		entries.push([`http.${remoteUrl}.${name}`, posture.kind === 'value' ? posture.value : fallback]);
	};
	const reassert = (variable: string, name: string): void => {
		const posture = operatorPosture(config, 'http', variable);
		if (posture.kind === 'value') entries.push([`http.${remoteUrl}.${name}`, posture.value]);
	};

	pin('sslverify', 'sslVerify', 'true');
	// With no `http.proxy` of the operator's, Git takes the proxy from these
	// variables (and still honours `no_proxy` for a proxy given this way);
	// with none of them either, an empty value is Git's "no proxy".
	pin('proxy', 'proxy', environmentProxy(input.env));
	// `remote.<name>.proxy` OUTRANKS `http.<url>.proxy` (`http.c` takes the
	// remote's when it has one), and the remote's name is in this command's
	// argv for as long as it runs. So the same value is pinned on the
	// private remote itself — and the method beside it, which the remote
	// outranks in the same way. Not when the operator's own proxy settings
	// are URL-specific: which of those applies is Git's to work out, and a
	// value written here would replace it.
	const proxy = operatorPosture(config, 'http', 'proxy');
	if (proxy.kind !== 'scoped') {
		entries.push([
			`remote.${remoteName}.proxy`,
			proxy.kind === 'value' ? proxy.value : environmentProxy(input.env)
		]);
	}
	const proxyAuthMethod = operatorPosture(config, 'http', 'proxyauthmethod');
	if (proxyAuthMethod.kind !== 'scoped') {
		entries.push([
			`remote.${remoteName}.proxyAuthMethod`,
			// `anyauth` is what Git uses when nothing is configured.
			proxyAuthMethod.kind === 'value' ? proxyAuthMethod.value : 'anyauth'
		]);
	}
	pin('followredirects', 'followRedirects', 'initial');
	pin('schannelusesslcainfo', 'schannelUseSSLCAInfo', 'false');
	// No value means "the built-in default" for these three, so they can
	// only be re-asserted where the operator chose one. See the module header.
	reassert('sslcainfo', 'sslCAInfo');
	reassert('sslcapath', 'sslCAPath');
	reassert('sslbackend', 'sslBackend');
	// Multi-valued, and an empty value clears the list. Left alone when the
	// operator pinned a resolution of their own.
	if (operatorPosture(config, 'http', 'curloptresolve').kind === 'unset') {
		entries.push([`http.${remoteUrl}.curloptResolve`, '']);
	}
	return entries;
}
