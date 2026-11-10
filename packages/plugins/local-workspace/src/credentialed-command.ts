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
 * | `url.<base>.insteadOf` / `.pushInsteadOf` | rewrites the URL Git connects to | other transports refused; the header is keyed to the ORIGINAL URL, so another https host is sent nothing — measured | blocks |
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
 * | `gpg.program`, `gpg.<format>.program`, `push.gpgSign` | signing program on a signed push | `push.gpgSign=false` | blocks |
 * | `fetch.recurseSubmodules`, `submodule.<n>.fetchRecurseSubmodules`, `push.recurseSubmodules` | a second fetch / push inside a repository under the pool | `--no-recurse-submodules` (fetch), `push.recurseSubmodules=no` | `submodule.*` allowed |
 * | `http.sslVerify` | accepts any certificate | pinned at the exact URL to the operator's value, else `true` — measured | blocks |
 * | `http.proxy`, `http.curloptResolve` | routes or resolves the connection elsewhere — measured | pinned at the exact URL to the operator's value, else the environment's proxy / none; resolutions reset — measured | blocks |
 * | `http.followRedirects`, `http.schannelUseSSLCAInfo` | follow every redirect; honour a planted CA bundle under schannel | pinned to the operator's value, else the default | blocks |
 * | `http.sslCAInfo`, `http.sslCAPath`, `http.sslBackend` | trusts a planted CA | re-asserted at the exact URL when the operator set one; **otherwise not overridable** — Git has no value meaning "the built-in default" | blocks |
 * | `http.extraHeader` | a second header on the request (cannot read ours) | not overridden | blocks |
 * | other `http.*` (`cookieFile`, `sslCert`, `pinnedPubkey`, …) | none for the token | not overridden | blocks, except transfer tuning |
 * | `include.path`, `includeIf.*` | pulls any of the above in from another file | whatever it pulls in is read BEFORE command scope | followed, then blocks |
 * | `extensions.worktreeConfig` | adds the per-worktree file | same overrides | allowed; that file is read too |
 * | `fetch.bundleURI`, `promisor.*`, `extensions.partialClone` | downloads from another URI — never with our header | none needed | blocks |
 * | `core.editor`, `core.pager`, `pager.*`, `sequence.editor` | none: no terminal, nothing to edit | n/a | blocks (nothing writes them here) |
 * | `diff.*`, `merge.*`, `filter.*` drivers | none: a fetch or a push converts no content | n/a | sections allowed; program-naming variables in them still block |
 * | `alias.*` | none: Git never lets an alias shadow `fetch` / `push` | n/a | blocks |
 * | `uploadpack.*`, `receive.*`, `uploadarchive.*` | server side of a local transport | transport not allowed (https) | blocks |
 * | `trace2.*`, `safe.*`, `uploadpack.packObjectsHook` | none: Git reads them from system / global config only | n/a | `safe.*` allowed |
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
	return `ew-credentialed-${randomUUID()}`;
}

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
 * A variable NAME that names something Git runs. None of the sections
 * allowed wholesale below needs one for a fetch or a push, so one that
 * appears there is refused whatever section it is in — the guard against
 * the next `gc.recentObjectsHook`.
 */
const PROGRAM_NAMING_VARIABLE =
	/(hook|command|cmd|program|driver|textconv|external|editor|pager|helper|askpass|proxy)$/;

/**
 * Sections whose every variable is inert for `git fetch` / `git push`:
 * identity, porcelain defaults, object-storage tuning, and what common
 * tooling writes into a checkout (`submodule.*` by `git submodule init`,
 * `lfs.*` / `filter.lfs.*` by git-lfs). Named one by one; a section that is
 * not here is refused.
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
	'filter',
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
	'gh-resolved'
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
	'recursesubmodules'
]);
const EXTENSION_VARIABLES: ReadonlySet<string> = new Set(['objectformat', 'refstorage', 'worktreeconfig']);

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
			return INERT_SECTIONS.has(section) && !PROGRAM_NAMING_VARIABLE.test(variable);
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
		const { section, subsection, variable } = keyParts(entry.key);
		const safe = (text: string): string => (/^[a-z0-9-]+$/.test(text) ? text : '<…>');
		foreign.add(
			subsection === null ? `${safe(section)}.${safe(variable)}` : `${safe(section)}.<…>.${safe(variable)}`
		);
	}
	return [...foreign];
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
		['push.recurseSubmodules', 'no']
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
