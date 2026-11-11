import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalWorkspacePlugin } from '../local-workspace.plugin.js';

/**
 * The reused-worktree catch-up (review feedback reaches the next run) runs
 * NOTHING a repository-writable config names, on either runtime.
 *
 * A run with a shell can write the shared pool config (`git config --local`
 * from a linked worktree lands there) and its own worktree config. The
 * catch-up moves a checkout the run controls to a commit someone else pushed,
 * so every config key that makes Git start a program is planted here, against
 * real Git, and must not fire:
 *
 *  - `merge.verifySignatures` + `gpg.program` / `gpg.ssh.program` /
 *    `gpg.x509.program`, with a pushed tip that carries a signature header
 *    (an independent review reproduced a `merge --ff-only` running it);
 *  - `core.fsmonitor` and repository hooks (`post-merge`,
 *    `reference-transaction`) on the UNHARDENED (cloud) provision too: the
 *    catch-up is new there, so it gets the overlay on both runtimes;
 *  - a `clean` filter defined only in the worktree's own `config.worktree`,
 *    which the pool-level probe cannot see (the review reproduced it running
 *    during the catch-up's `status`).
 *
 * Each case first proves its plant is LIVE on this Git with a control command
 * run by hand, so a green assertion cannot be a plant that never fires.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** Run git and swallow a non-zero exit — a control whose verdict is the marker, not the exit code. */
const gitTry = (cwd: string, ...args: string[]): void => {
	try {
		execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	} catch {
		// the planted program may fail the command; whether it RAN is the verdict
	}
};

/** Forward slashes: Git hands hook / filter / gpg commands to `sh`, on Windows too. */
const shPath = (path: string): string => path.replace(/\\/g, '/');

const asReviewer = ['-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@test.local'];

let root: string;
let originUrl: string;
let markers: string;
let plugin: LocalWorkspacePlugin;
let caseCounter = 0;

const marker = (name: string): string => join(markers, name);
const fired = (name: string): boolean => existsSync(marker(name));
const clearMarker = (name: string): void => rmSync(marker(name), { force: true });

/** A planted PROGRAM file (for keys Git executes directly) that records `name`. */
const program = (name: string): string => {
	const file = join(root, `planted-${name}.sh`);
	writeFileSync(file, `#!/bin/sh\necho ran >> '${shPath(marker(name))}'\nexit 1\n`, { mode: 0o755 });
	return shPath(file);
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-lw-ff-harden-'));
	const originDir = join(root, 'origin.git');
	const seedDir = join(root, 'seed');
	markers = join(root, 'markers');
	mkdirSync(originDir, { recursive: true });
	mkdirSync(seedDir, { recursive: true });
	mkdirSync(markers, { recursive: true });
	git(originDir, 'init', '--bare', '--initial-branch', 'main');
	originUrl = pathToFileURL(originDir).toString();
	git(seedDir, 'init', '--initial-branch', 'main');
	// A tracked file a filter driver named `evil` applies to — defined by no
	// config until a case plants it.
	writeFileSync(join(seedDir, '.gitattributes'), 'payload.txt filter=evil\n');
	writeFileSync(join(seedDir, 'payload.txt'), 'raw blob content\n');
	git(seedDir, 'add', '-A');
	git(seedDir, ...asReviewer, 'commit', '-m', 'seed');
	git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
	plugin = new LocalWorkspacePlugin();
}, 120_000);

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * One isolated case: its own workspace root (so its own pool), a reused
 * worktree whose branch was pushed, and a way to push onto that branch from
 * another clone, as a person on the pull request would.
 */
async function reusedCase(hardened: boolean) {
	caseCounter += 1;
	const baseDir = join(root, `case-${caseCounter}`);
	const branch = `task/ff-harden-${caseCounter}-abcd1234`;
	const bindingKey = `ff-harden-${caseCounter}`;
	const spec = () => ({
		repoUrl: originUrl,
		baseRef: 'main',
		branch,
		bindingKey,
		settings: { baseDir, fetchDepth: 1 },
		...(hardened ? { hardenRepoHooks: true } : {})
	});
	const first = await plugin.provision(spec());
	writeFileSync(join(first.path, `work-${caseCounter}.txt`), 'the run work\n');
	const pushed = await plugin.finalize(first, {
		commitMessage: 'agent: work',
		push: true,
		...(hardened ? { hardenRepoHooks: true } : {})
	});
	expect(pushed.pushed).toBe(true);
	const repos = join(baseDir, 'repos');
	const pool = join(repos, readdirSync(repos)[0]!);
	const clone = join(root, `clone-${caseCounter}`);
	git(root, 'clone', '--quiet', '--branch', branch, originUrl, clone);
	const pushCommit = (sha: string): string => {
		git(clone, 'push', '--quiet', originUrl, `${sha}:refs/heads/${branch}`);
		return sha;
	};
	return {
		spec,
		worktree: first.path,
		pool,
		clone,
		/** A plain commit on the branch, pushed. */
		pushAhead: (): string => {
			writeFileSync(join(clone, `reviewer-${caseCounter}.txt`), 'reviewer fix\n');
			git(clone, 'add', '-A');
			git(clone, ...asReviewer, 'commit', '-m', 'reviewer: fix');
			return pushCommit(git(clone, 'rev-parse', 'HEAD'));
		},
		/**
		 * A commit that carries a `gpgsig` header (a hosting provider's web-UI
		 * commit is signed), pushed. The signature is not valid — it only has
		 * to make Git ask the signing program.
		 */
		pushSigned: (): string => {
			writeFileSync(join(clone, `signed-${caseCounter}.txt`), 'signed by the provider\n');
			git(clone, 'add', '-A');
			git(clone, ...asReviewer, 'commit', '-m', 'reviewer: signed fix');
			const raw = git(clone, 'cat-file', 'commit', 'HEAD');
			const [headers, ...message] = raw.split('\n\n');
			const signature = [
				'gpgsig -----BEGIN PGP SIGNATURE-----',
				' ',
				' iQEzBAABCAAdFiEEAAAAAAAAAAAAAAAAAAAAAAAAAAAFAmAAAAAACgkQAAAAAAAA',
				' AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
				' =AAAA',
				' -----END PGP SIGNATURE-----'
			].join('\n');
			const forged = `${headers}\n${signature}\n\n${message.join('\n\n')}\n`;
			const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], {
				cwd: clone,
				input: forged,
				encoding: 'utf8',
				windowsHide: true
			}).trim();
			git(clone, 'update-ref', `refs/heads/${branch}`, sha);
			return pushCommit(sha);
		}
	};
}

describe('the reused-worktree catch-up runs nothing a repository config names', () => {
	it('never runs a signing program, whatever signature the pushed tip carries (hardened)', async () => {
		const at = await reusedCase(true);
		const gpg = program('gpg');
		git(at.pool, 'config', 'merge.verifySignatures', 'true');
		git(at.pool, 'config', 'gpg.program', gpg);
		git(at.pool, 'config', 'gpg.ssh.program', gpg);
		git(at.pool, 'config', 'gpg.x509.program', gpg);
		const tip = at.pushSigned();

		// CONTROL: on this Git, that tip makes Git start the signing program.
		gitTry(at.clone, '-c', `gpg.program=${program('gpg-control')}`, 'verify-commit', tip);
		expect(fired('gpg-control')).toBe(true);

		const handle = await plugin.provision(at.spec());

		expect(fired('gpg')).toBe(false);
		expect(handle.reused).toBe(true);
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(tip);
	}, 180_000);

	it('runs no fsmonitor and no repository hook on the UNHARDENED (cloud) provision either', async () => {
		const at = await reusedCase(false);
		const hooks = join(root, `hooks-${caseCounter}`);
		mkdirSync(hooks, { recursive: true });
		writeFileSync(join(hooks, 'post-merge'), `#!/bin/sh\necho ran >> '${shPath(marker('post-merge'))}'\n`, {
			mode: 0o755
		});
		// Only a LOCAL branch update counts: the provision's own fetches move
		// remote-tracking refs, and they ran this hook before the catch-up existed.
		writeFileSync(
			join(hooks, 'reference-transaction'),
			`#!/bin/sh\nif grep -q ' refs/heads/'; then echo ran >> '${shPath(marker('ref-hook'))}'; fi\nexit 0\n`,
			{ mode: 0o755 }
		);
		git(at.pool, 'config', 'core.hooksPath', shPath(hooks));
		git(at.pool, 'config', 'core.fsmonitor', program('fsmonitor'));
		const tip = at.pushAhead();

		// CONTROL: the plants are live in this worktree.
		gitTry(at.worktree, 'status', '--porcelain');
		expect(fired('fsmonitor')).toBe(true);
		gitTry(at.worktree, 'update-ref', 'refs/heads/ew-control', 'HEAD');
		expect(fired('ref-hook')).toBe(true);
		gitTry(at.worktree, 'update-ref', '-d', 'refs/heads/ew-control');
		for (const name of ['fsmonitor', 'ref-hook', 'post-merge']) clearMarker(name);

		const handle = await plugin.provision(at.spec());

		expect(fired('fsmonitor')).toBe(false);
		expect(fired('ref-hook')).toBe(false);
		expect(fired('post-merge')).toBe(false);
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(tip);
	}, 180_000);

	it('runs no clean filter defined only in the worktree config, before or during its status', async () => {
		const at = await reusedCase(true);
		git(at.pool, 'config', 'extensions.worktreeConfig', 'true');
		// The pool is bare: with per-worktree config on, a linked worktree
		// would inherit `core.bare=true` — so the plant states it is not.
		git(at.worktree, 'config', '--worktree', 'core.bare', 'false');
		git(at.worktree, 'config', '--worktree', 'filter.evil.clean', `echo ran >> '${shPath(marker('clean'))}'; cat`);
		const tip = at.pushAhead();
		const payload = join(at.worktree, 'payload.txt');

		// CONTROL: with the file stat-dirty, `status` runs that clean filter.
		const later = new Date(Date.now() + 60_000);
		utimesSync(payload, later, later);
		gitTry(at.worktree, 'status', '--porcelain');
		expect(fired('clean')).toBe(true);
		clearMarker('clean');
		// `status` refreshed the index stat data: make the file stat-dirty again.
		const evenLater = new Date(Date.now() + 120_000);
		utimesSync(payload, evenLater, evenLater);

		const handle = await plugin.provision(at.spec());

		expect(fired('clean')).toBe(false);
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(tip);
	}, 180_000);
});
