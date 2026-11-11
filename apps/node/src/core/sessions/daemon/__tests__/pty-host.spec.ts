import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_SESSION_DAEMON_REASON_MAX_LENGTH } from '@ever-works/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	PTY_ADDON,
	PTY_ADDON_RANGE,
	PTY_INSTALL_COMMAND,
	PTY_MUSL_REASON,
	createNodePtyFactory,
	describePtyLoadFailure,
	describeTerminalAddon,
	loadNodePty,
	readPtyAddonVersion,
	type PtyProcess
} from '../pty-host';
import { eventually } from './pty-test-kit';

/**
 * The terminal addon (`@homebridge/node-pty-prebuilt-multiarch`) on the Node
 * the node runs on.
 *
 * ever-works-node 0.2.10 shipped it at `^0.13.1`, whose `engines` stop below
 * Node 25. npm skips an optional dependency like that without a word, so on
 * Node 26 every fleet node lost its terminal and the app only said "terminal
 * support is missing". These specs pin the three things that went wrong: the
 * range the release installs, the reason a person reads when the addon is
 * still missing, and a REAL pty on the Node running the suite.
 */

const appRoot = join(__dirname, '../../../../..');
const repositoryRoot = join(appRoot, '../..');
const readJson = (path: string): Record<string, Record<string, string> | undefined> =>
	JSON.parse(readFileSync(path, 'utf8'));

const RUNTIME = { node: 'v26.10.0', platform: 'linux', arch: 'x64' };

const notFound = (): Error =>
	Object.assign(
		new Error(`Cannot find module '${PTY_ADDON}'\nRequire stack:\n- /usr/lib/node_modules/ever-works-node/cli.js`),
		{ code: 'MODULE_NOT_FOUND' }
	);

describe('the terminal addon range', () => {
	it('is the one the pty-local plugin declares (build.js publishes that one) and the node app installs', () => {
		const plugin = readJson(join(repositoryRoot, 'packages/plugins/pty-local/package.json'));
		const node = readJson(join(appRoot, 'package.json'));
		expect(plugin.optionalDependencies?.[PTY_ADDON]).toBe(PTY_ADDON_RANGE);
		expect(node.optionalDependencies?.[PTY_ADDON]).toBe(PTY_ADDON_RANGE);
	});

	it('is a line whose engines admit Node 26 (0.13.x stops below 25)', () => {
		expect(PTY_ADDON_RANGE).toMatch(/^\^0\.(1[5-9]|[2-9]\d)\.\d+$/);
	});
});

describe('describePtyLoadFailure', () => {
	it('names the package, the range, the Node and the install command when npm skipped the addon', () => {
		const reason = describePtyLoadFailure(notFound(), RUNTIME);
		expect(reason).toBe(
			`terminal support is missing: npm did not install the optional addon ${PTY_ADDON}@${PTY_ADDON_RANGE} ` +
				`for Node v26.10.0 (linux-x64). Fix: ${PTY_INSTALL_COMMAND} as the user who installed ever-works-node ` +
				'(no restart needed).'
		);
		expect(PTY_INSTALL_COMMAND).toBe(`npm install -g "${PTY_ADDON}@${PTY_ADDON_RANGE}"`);
	});

	it('fits the reason the platform keeps from a heartbeat, so the app shows the whole fix', () => {
		const reason = describePtyLoadFailure(notFound(), { node: 'v26.110.10', platform: 'linux', arch: 'arm64' });
		expect(reason.length).toBeLessThanOrEqual(FLEET_SESSION_DAEMON_REASON_MAX_LENGTH);
	});

	it('says an installed addon does not load, with its version and the loader message last', () => {
		const reason = describePtyLoadFailure(
			new Error('Failed to load native module pty.node because no candidate file was found.\nChecked: ...'),
			RUNTIME,
			'0.15.0'
		);
		expect(reason).toContain(`the terminal addon ${PTY_ADDON} 0.15.0 does not load on Node v26.10.0 (linux-x64)`);
		expect(reason).toContain(`Fix: ${PTY_INSTALL_COMMAND}`);
		expect(
			reason.endsWith('Loader: Failed to load native module pty.node because no candidate file was found.')
		).toBe(true);
		// The fix comes before the loader's words, so the part the platform keeps carries it.
		expect(reason.slice(0, FLEET_SESSION_DAEMON_REASON_MAX_LENGTH)).toContain(PTY_INSTALL_COMMAND);
	});

	it('treats a MODULE_NOT_FOUND for some OTHER module as a broken install, not a skipped one', () => {
		const nested = Object.assign(new Error("Cannot find module 'node-addon-api'"), { code: 'MODULE_NOT_FOUND' });
		expect(describePtyLoadFailure(nested, RUNTIME)).toContain('does not load on');
	});
});

describe('loadNodePty / describeTerminalAddon with an injected loader', () => {
	it('reports a skipped addon with the fix, never throwing', () => {
		const require_ = (): never => {
			throw notFound();
		};
		expect(loadNodePty(require_, RUNTIME)).toEqual({
			module: null,
			reason: describePtyLoadFailure(notFound(), RUNTIME)
		});
		expect(describeTerminalAddon(require_, RUNTIME)).toEqual({
			available: false,
			addon: PTY_ADDON,
			range: PTY_ADDON_RANGE,
			version: null,
			node: 'v26.10.0 (linux-x64)',
			reason: describePtyLoadFailure(notFound(), RUNTIME)
		});
	});

	it('reports a module without spawn() as unusable, with its installed version', () => {
		const require_ = (id: string): unknown => (id.endsWith('/package.json') ? { version: '0.15.0' } : {});
		const report = describeTerminalAddon(require_, RUNTIME);
		expect(report).toMatchObject({ available: false, version: '0.15.0' });
		expect(report.reason).toContain('It has no spawn().');
	});

	it('refuses the addon on musl Linux without loading it (0.15 loads its glibc build there and segfaults)', () => {
		let required = false;
		const require_ = (): unknown => {
			required = true;
			return { spawn: () => undefined };
		};
		expect(loadNodePty(require_, { ...RUNTIME, musl: true })).toEqual({ module: null, reason: PTY_MUSL_REASON });
		expect(required).toBe(false);
		expect(PTY_MUSL_REASON.length).toBeLessThanOrEqual(FLEET_SESSION_DAEMON_REASON_MAX_LENGTH);
	});

	it("keeps the addon loader's own console.error off stderr and puts its words in the reason", () => {
		const spy = vi.spyOn(console, 'error');
		const require_ = (id: string): unknown => {
			if (id.endsWith('/package.json')) return { version: '0.15.0' };
			console.error(new Error('/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28` not found'));
			throw new Error('Failed to load native module pty.node. Checked: ../build/Release/pty.node');
		};
		const { module, reason } = loadNodePty(require_, RUNTIME);
		const printedToStderr = spy.mock.calls.length;
		const restored = console.error === spy;
		spy.mockRestore();
		expect(restored).toBe(true);
		expect(module).toBeNull();
		expect(printedToStderr).toBe(0);
		expect(reason).toContain('Loader: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28` not found');
	});

	it('does not remember a failure: an addon installed later is picked up on the next load', () => {
		let installed = false;
		const require_ = (id: string): unknown => {
			if (!installed) throw notFound();
			return id.endsWith('/package.json') ? { version: '0.15.0' } : { spawn: () => undefined };
		};
		expect(loadNodePty(require_, RUNTIME).module).toBeNull();
		installed = true;
		expect(loadNodePty(require_, RUNTIME).module).not.toBeNull();
	});

	it('reports a loadable addon with its version', () => {
		const require_ = (id: string): unknown =>
			id.endsWith('/package.json') ? { version: '0.15.0' } : { spawn: () => undefined };
		expect(describeTerminalAddon(require_, RUNTIME)).toEqual({
			available: true,
			addon: PTY_ADDON,
			range: PTY_ADDON_RANGE,
			version: '0.15.0',
			node: 'v26.10.0 (linux-x64)'
		});
	});
});

/**
 * The real addon, on the Node running this suite (CI and the fleet run Node
 * 26). No skip when it is missing: a missing addon on the supported Node is
 * exactly the regression this file exists to catch.
 */
describe('the real terminal addon on this Node', () => {
	// The child runs from a file: a long `-e` one-liner through ConPTY's
	// command line is a quoting test, not a terminal test.
	const CHILD = [
		"process.stdout.write('argv=' + JSON.stringify(process.argv.slice(2)) + '\\n');",
		"process.stdout.write('tty=' + process.stdout.isTTY + ' cols=' + process.stdout.columns + ' rows=' + process.stdout.rows + '\\n');",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (d) => { if (d.includes('bye')) { process.stdout.write('got-bye\\n'); setTimeout(() => process.exit(7), 50); } });",
		"if (process.argv[2] === 'idle') setInterval(() => {}, 1000);"
	].join('\n');
	let dir: string;
	let childScript: string;
	const env = (): Record<string, string> =>
		Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
		);

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'ewn-pty-'));
		childScript = join(dir, 'child.cjs');
		writeFileSync(childScript, CHILD);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('is installed at a version inside the range and loads', () => {
		const version = readPtyAddonVersion();
		expect(version, `${PTY_ADDON} is not installed`).not.toBeNull();
		expect(version).toMatch(/^0\.(1[5-9]|[2-9]\d)\./);
		const { factory, availability } = createNodePtyFactory();
		expect(availability).toEqual({ available: true });
		expect(factory).not.toBeNull();
	});

	it('runs a process under a real terminal: args, tty, size, input, resize and exit code', async () => {
		const { factory } = createNodePtyFactory();
		if (!factory) throw new Error('terminal addon unavailable');
		const args = ['plain', 'with space', 'quote"inside', 'back\\slash'];
		const child: PtyProcess = factory({
			command: process.execPath,
			args: [childScript, ...args],
			cwd: process.cwd(),
			env: env(),
			cols: 100,
			rows: 30
		});
		let output = '';
		let exit: { exitCode: number | null } | null = null;
		child.onData((data) => {
			output += data;
		});
		child.onExit((event) => {
			exit = event;
		});
		await eventually(() => output.includes('cols=100'), 15_000);
		// Live, not a spawn-time snapshot: ConPTY reports the pid only once connected.
		expect(child.pid).toBeGreaterThan(0);
		expect(output).toContain(`argv=${JSON.stringify(args)}`);
		expect(output).toContain('tty=true');
		expect(output).toContain('rows=30');
		child.resize(120, 40);
		child.write('bye\r');
		await eventually(() => exit !== null, 15_000);
		expect(output).toContain('got-bye');
		expect(exit).toEqual(expect.objectContaining({ exitCode: 7 }));
	});

	it('stops a running process on kill', async () => {
		const { factory } = createNodePtyFactory();
		if (!factory) throw new Error('terminal addon unavailable');
		const child = factory({
			command: process.execPath,
			args: [childScript, 'idle'],
			cwd: process.cwd(),
			env: env(),
			cols: 80,
			rows: 24
		});
		let exited = false;
		child.onExit(() => {
			exited = true;
		});
		await eventually(() => child.pid !== null, 5_000);
		child.kill(true);
		await eventually(() => exited, 15_000);
		expect(exited).toBe(true);
	});
});
