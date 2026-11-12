import { resolve } from 'node:path';

/**
 * The locks every Git write into a repository pool runs under, shared by the
 * whole process.
 *
 * A pool is one bare clone on disk, and two Git commands that write it at
 * once fail each other: two fetches race on its `shallow` file and on the
 * remote-tracking refs, and `git worktree add` beside another write corrupts
 * refs. The provider serializes its own work with these locks. They used to
 * live on each `LocalWorkspacePlugin` instance, so a second instance in the
 * same process (the node's workspace reaper builds its own for teardown) and
 * the node's workspace scan (its own `git` children, no plugin at all) wrote
 * the same pool beside a provision. One map per process, keyed by the pool's
 * path, puts them all in one queue.
 *
 * The map is kept on `globalThis` under a registered symbol, so a second copy
 * of this module (the package ships both an ESM and a CommonJS build) still
 * finds the same one.
 *
 * Cross-process work (the `ever-works-node gc` command run by hand beside the
 * service, for example) is NOT serialized by this.
 */

type LockMap = Map<string, Promise<void>>;

const REGISTRY: unique symbol = Symbol.for('ever-works.local-workspace.pool-locks');
const holder = globalThis as typeof globalThis & { [REGISTRY]?: LockMap };

/**
 * The process-wide queue tails, by key. Exported for the provider and for
 * tests that need to see a waiter join a queue; nothing else should touch it.
 *
 * @internal
 */
export const workspaceLocks: LockMap = (holder[REGISTRY] ??= new Map());

/** The key of a repository pool's lock: the one provision, teardown and the pool fetches take. */
export function poolLockKey(poolPath: string): string {
	return `repo:${normalizedLockPath(poolPath)}`;
}

/** The key of one Task worktree's lock. */
export function worktreeLockKey(worktreePath: string): string {
	return `worktree:${normalizedLockPath(worktreePath)}`;
}

/**
 * Run `fn` once every earlier holder of the repository pool at `poolPath` is
 * done — the same queue `LocalWorkspacePlugin` provisions, tears down and
 * fetches that pool in. For Git work on a pool done outside the provider.
 *
 * `signal`, when given, lets the caller leave the queue while it waits: the
 * returned promise then rejects with an `AbortError` and `fn` never runs.
 * Once `fn` has started, stopping it is `fn`'s business.
 */
export function withPoolLock<T>(poolPath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	return withWorkspaceLock(poolLockKey(poolPath), fn, signal);
}

/**
 * Serialize work per key with a promise chain. The stored tail always
 * resolves (rejections are swallowed into it), so one failed holder never
 * poisons the queue behind it.
 *
 * A waiter that leaves early (its `signal` aborted) keeps its place in the
 * chain until the holder before it is done: the waiter behind it must never
 * start beside that holder.
 */
export function withWorkspaceLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const previous = workspaceLocks.get(key) ?? Promise.resolve();
	const run = (signal ? untilTurn(previous, signal) : previous).then(fn);
	const settled = run.then(noop, noop).then(() => previous);
	workspaceLocks.set(key, settled);
	void settled.then(() => {
		// A newer waiter may already have replaced this tail. Delete only the
		// exact settled tail so that waiter never loses serialization.
		if (workspaceLocks.get(key) === settled) workspaceLocks.delete(key);
	});
	return run;
}

/** Resolves when `turn` does; rejects as soon as `signal` aborts, if that is first. */
function untilTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(lockWaitAborted());
	return new Promise((resolveTurn, reject) => {
		const onAbort = (): void => reject(lockWaitAborted());
		signal.addEventListener('abort', onAbort, { once: true });
		void turn.then(() => {
			signal.removeEventListener('abort', onAbort);
			resolveTurn();
		});
	});
}

function lockWaitAborted(): Error {
	const error = new Error('Cancelled while waiting for another Git operation on this repository pool');
	error.name = 'AbortError';
	return error;
}

function noop(): void {}

function normalizedLockPath(value: string): string {
	const normalized = resolve(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
