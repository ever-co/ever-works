/**
 * Platform demo mode — one sandbox's repository-making steps, one at a time.
 *
 * The Works cap is check-then-act: count the sandbox's repository-backed Works,
 * create the GitHub repository, store the Work. Two requests of one sandbox in
 * parallel (two creates, or a create and a Generate on the seeded draft) would
 * both see room. The demo API runs as ONE replica (SQLite), so an in-process
 * mutex keyed by the Work owner's user id is enough to make the three steps one.
 * Different sandboxes never wait on each other.
 */

/** Per key, the promise the next caller waits on: settles once every earlier holder is done. */
const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` once every earlier `withDemoSandboxLock(key, …)` call has finished,
 * and holds later ones until `fn` settles (fulfilled or rejected).
 */
export async function withDemoSandboxLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.then(() => held);
    tails.set(key, tail);

    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (tails.get(key) === tail) {
            tails.delete(key);
        }
    }
}
