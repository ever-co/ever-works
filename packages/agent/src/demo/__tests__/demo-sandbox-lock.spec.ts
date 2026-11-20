import { withDemoSandboxLock } from '..';

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

/** Lets every queued microtask (and the lock's promise chain) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('withDemoSandboxLock', () => {
    it('runs one sandbox’s calls one at a time, in order', async () => {
        const order: string[] = [];
        const first = gate();

        const a = withDemoSandboxLock('sandbox-1', async () => {
            order.push('a:start');
            await first.promise;
            order.push('a:end');
            return 'a';
        });
        const b = withDemoSandboxLock('sandbox-1', async () => {
            order.push('b:start');
            return 'b';
        });

        await settle();
        expect(order).toEqual(['a:start']);

        first.open();
        await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
        expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    });

    it('lets two sandboxes run side by side', async () => {
        const held = gate();
        const started: string[] = [];

        const a = withDemoSandboxLock('sandbox-1', async () => {
            started.push('sandbox-1');
            await held.promise;
        });
        const b = withDemoSandboxLock('sandbox-2', async () => {
            started.push('sandbox-2');
        });

        await b;
        expect(started).toEqual(['sandbox-1', 'sandbox-2']);
        held.open();
        await a;
    });

    it('releases the lock when the call fails, and passes the failure on', async () => {
        const refused = withDemoSandboxLock('sandbox-1', async () => {
            throw new Error('cap reached');
        });
        const next = withDemoSandboxLock('sandbox-1', async () => 'next');

        await expect(refused).rejects.toThrow('cap reached');
        await expect(next).resolves.toBe('next');
    });
});
