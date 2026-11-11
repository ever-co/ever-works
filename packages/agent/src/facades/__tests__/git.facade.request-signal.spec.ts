import { GitFacadeService } from '../git.facade';

/**
 * A caller's `AbortSignal` (`GitFacadeOptions.signal`) reaches the provider
 * plugin on the reads that take one, so a caller that gives up (the Work
 * ownership check's timeout and deadline) cancels the HTTP request instead of
 * leaving it in the client's retry / rate-limit queue. Without a signal the
 * plugin is called exactly as before.
 */

const BASE = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;

function makeFacade(plugin: Record<string, unknown>) {
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
    );
    (
        facade as unknown as {
            resolvePluginAndToken: () => Promise<{ plugin: unknown; token: string }>;
        }
    ).resolvePluginAndToken = jest
        .fn()
        .mockResolvedValue({ plugin: { id: 'github', ...plugin }, token: 'tok' });
    return facade;
}

describe('GitFacadeService — the caller’s AbortSignal reaches the plugin', () => {
    const signal = new AbortController().signal;

    it('repositoryExists', async () => {
        const repositoryExists = jest.fn().mockResolvedValue(true);
        await makeFacade({ repositoryExists }).repositoryExists('acme', 'app', {
            ...BASE,
            signal,
        });
        expect(repositoryExists).toHaveBeenCalledWith('acme', 'app', 'tok', { signal });
    });

    it('repositoryExists through getRepository when the plugin has no repositoryExists', async () => {
        const getRepository = jest.fn().mockResolvedValue(null);
        await expect(
            makeFacade({ getRepository }).repositoryExists('acme', 'app', { ...BASE, signal }),
        ).resolves.toBe(false);
        expect(getRepository).toHaveBeenCalledWith('acme', 'app', 'tok', { signal });
    });

    it('getRepository and getUser', async () => {
        const getRepository = jest.fn().mockResolvedValue(null);
        const getUser = jest.fn().mockResolvedValue({ id: '1', login: 'member-login' });
        const facade = makeFacade({ getRepository, getUser });

        await facade.getRepository('acme', 'app', { ...BASE, signal });
        await facade.getUser({ ...BASE, signal });

        expect(getRepository).toHaveBeenCalledWith('acme', 'app', 'tok', { signal });
        expect(getUser).toHaveBeenCalledWith('tok', { signal });
    });

    it('passes nothing extra when the caller gave no signal', async () => {
        const repositoryExists = jest.fn().mockResolvedValue(true);
        const getUser = jest.fn().mockResolvedValue({ id: '1', login: 'x' });
        const facade = makeFacade({ repositoryExists, getUser });

        await facade.repositoryExists('acme', 'app', BASE);
        await facade.getUser(BASE);

        expect(repositoryExists.mock.calls[0]).toEqual(['acme', 'app', 'tok']);
        expect(getUser.mock.calls[0]).toEqual(['tok']);
    });
});
