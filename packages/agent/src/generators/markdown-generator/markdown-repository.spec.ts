import { CATEGORY_PAGE_MARKER, MarkdownRepository } from './markdown-repository';
import * as path from 'node:path';

jest.mock('node:fs/promises', () => ({
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    lstat: jest.fn(),
    readFile: jest.fn(),
    rmdir: jest.fn().mockResolvedValue(undefined),
}));

const fsMock = jest.requireMock('node:fs/promises') as {
    rm: jest.Mock;
    readdir: jest.Mock;
    mkdir: jest.Mock;
    writeFile: jest.Mock;
    lstat: jest.Mock;
    readFile: jest.Mock;
    rmdir: jest.Mock;
};

const statOf = (kind: 'dir' | 'file' | 'link') => ({
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'link',
});
const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
const dirent = (name: string, kind: 'dir' | 'file' | 'link' = 'file') => ({
    name,
    ...statOf(kind),
});

describe('MarkdownRepository', () => {
    const dir = path.join('/tmp', 'work');
    const detailsDir = path.join(dir, 'details');

    beforeEach(() => {
        jest.clearAllMocks();
        fsMock.rm.mockResolvedValue(undefined);
        fsMock.readdir.mockResolvedValue([]);
        fsMock.mkdir.mockResolvedValue(undefined);
        fsMock.writeFile.mockResolvedValue(undefined);
        fsMock.lstat.mockRejectedValue(enoent());
        fsMock.readFile.mockResolvedValue('');
        fsMock.rmdir.mockResolvedValue(undefined);
    });

    describe('cleanup', () => {
        it('rms the entire dir recursive+force', async () => {
            await new MarkdownRepository(dir).cleanup();
            expect(fsMock.rm).toHaveBeenCalledTimes(1);
            expect(fsMock.rm).toHaveBeenCalledWith(dir, { recursive: true, force: true });
        });
    });

    describe('resetFiles', () => {
        it('removes every non-allowlisted entry then ensures details/ exists', async () => {
            fsMock.readdir.mockResolvedValueOnce([
                'README.md',
                'old-cache',
                'details',
                'random.txt',
            ] as any);

            await new MarkdownRepository(dir).resetFiles();

            const removed = fsMock.rm.mock.calls.map((c) => c[0]);
            expect(removed).toEqual([
                path.join(dir, 'README.md'),
                path.join(dir, 'old-cache'),
                path.join(dir, 'details'),
                path.join(dir, 'random.txt'),
            ]);
            for (const call of fsMock.rm.mock.calls) {
                expect(call[1]).toEqual({ recursive: true, force: true });
            }
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });

        it('preserves the standard allowlist + every dotfile starting with ".git"', async () => {
            fsMock.readdir.mockResolvedValueOnce([
                '.git',
                '.gitignore',
                '.github',
                '.vscode',
                '.env',
                '.nvmrc',
                '.gitattributes', // covered by `.git*` startsWith branch
                '.gitkeep', // covered by `.git*` startsWith branch
                'something.md',
            ] as any);

            await new MarkdownRepository(dir).resetFiles();

            // Only `something.md` should be removed.
            expect(fsMock.rm).toHaveBeenCalledTimes(1);
            expect(fsMock.rm).toHaveBeenCalledWith(path.join(dir, 'something.md'), {
                recursive: true,
                force: true,
            });
            // Still calls mkdir at the end via ensureWorksExist().
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });

        it('still ensures details/ exists when readdir returns an empty list', async () => {
            fsMock.readdir.mockResolvedValueOnce([] as any);

            await new MarkdownRepository(dir).resetFiles();

            expect(fsMock.rm).not.toHaveBeenCalled();
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });

        it('propagates readdir failure (no mkdir, no rm)', async () => {
            fsMock.readdir.mockRejectedValueOnce(new Error('ENOENT'));

            await expect(new MarkdownRepository(dir).resetFiles()).rejects.toThrow('ENOENT');
            expect(fsMock.rm).not.toHaveBeenCalled();
            expect(fsMock.mkdir).not.toHaveBeenCalled();
        });

        it('removes entries sequentially in directory-listing order (await per iteration)', async () => {
            fsMock.readdir.mockResolvedValueOnce(['a', 'b', 'c'] as any);
            const order: string[] = [];
            fsMock.rm.mockImplementation(async (target: string) => {
                order.push(target);
            });

            await new MarkdownRepository(dir).resetFiles();

            expect(order).toEqual([path.join(dir, 'a'), path.join(dir, 'b'), path.join(dir, 'c')]);
        });
    });

    describe('ensureWorksExist', () => {
        it('mkdirs the details/ subdir recursively', async () => {
            await new MarkdownRepository(dir).ensureWorksExist();
            expect(fsMock.mkdir).toHaveBeenCalledWith(detailsDir, { recursive: true });
        });
    });

    describe('writeReadme', () => {
        it('writes README.md at the root with utf-8', async () => {
            await new MarkdownRepository(dir).writeReadme('# Hello');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(dir, 'README.md'),
                '# Hello',
                'utf-8',
            );
        });
    });

    describe('writeDetails / removeDetails', () => {
        it('writes details/<slug>.md with utf-8', async () => {
            await new MarkdownRepository(dir).writeDetails('cool-thing', '# Cool');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(detailsDir, 'cool-thing.md'),
                '# Cool',
                'utf-8',
            );
        });

        it('rms the per-slug detail file with force only (NOT recursive)', async () => {
            await new MarkdownRepository(dir).removeDetails('gone');
            expect(fsMock.rm).toHaveBeenCalledWith(path.join(detailsDir, 'gone.md'), {
                force: true,
            });
            // Note: explicitly NOT recursive — files only.
        });

        // EW-717 #1 — path-traversal guard. A caller-supplied slug must be a
        // single safe `[A-Za-z0-9_-]+` segment; anything that could escape the
        // `details/` dir must throw BEFORE any fs write/delete.
        describe('slug confinement (path traversal)', () => {
            it.each([
                '../../evil',
                '../escape',
                'a/b',
                '..',
                '.',
                '',
                'foo/../../bar',
                'sub/child',
            ])('writeDetails rejects hostile slug %p without writing', async (slug) => {
                await expect(new MarkdownRepository(dir).writeDetails(slug, 'x')).rejects.toThrow(
                    /Invalid slug/,
                );
                expect(fsMock.writeFile).not.toHaveBeenCalled();
            });

            it.each([
                '../../evil',
                '../escape',
                'a/b',
                '..',
                '.',
                '',
                'foo/../../bar',
                'sub/child',
            ])('removeDetails rejects hostile slug %p without removing', async (slug) => {
                await expect(new MarkdownRepository(dir).removeDetails(slug)).rejects.toThrow(
                    /Invalid slug/,
                );
                expect(fsMock.rm).not.toHaveBeenCalled();
            });

            it('does not bump the write counter when a hostile slug is rejected', async () => {
                const repo = new MarkdownRepository(dir);
                await expect(repo.writeDetails('../../evil', 'x')).rejects.toThrow(/Invalid slug/);
                await expect(repo.removeDetails('../../evil')).rejects.toThrow(/Invalid slug/);
                expect(repo.getWriteCount()).toBe(0);
            });

            it('still writes a legitimate slug unchanged under details/', async () => {
                await new MarkdownRepository(dir).writeDetails('my-item', '# ok');
                expect(fsMock.writeFile).toHaveBeenCalledWith(
                    path.join(detailsDir, 'my-item.md'),
                    '# ok',
                    'utf-8',
                );
            });

            it('still removes a legitimate slug unchanged under details/', async () => {
                await new MarkdownRepository(dir).removeDetails('my-item');
                expect(fsMock.rm).toHaveBeenCalledWith(path.join(detailsDir, 'my-item.md'), {
                    force: true,
                });
            });
        });
    });

    describe('writeLicense', () => {
        it('writes LICENSE.md at the root with utf-8', async () => {
            await new MarkdownRepository(dir).writeLicense('MIT');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(dir, 'LICENSE.md'),
                'MIT',
                'utf-8',
            );
        });
    });

    describe('category pages (split README)', () => {
        const categoriesDir = path.join(dir, 'categories');

        /** `categories/` is a real folder; files listed in `files` exist with the given kind. */
        const mountCategoriesDir = (files: Record<string, 'dir' | 'file' | 'link'> = {}) => {
            fsMock.lstat.mockImplementation(async (target: string) => {
                if (target === categoriesDir) {
                    return statOf('dir');
                }
                const kind = files[path.basename(target)];
                if (kind) {
                    return statOf(kind);
                }
                throw enoent();
            });
        };

        describe('writeCategoryPage', () => {
            it('creates categories/ and writes the page with utf-8', async () => {
                mountCategoriesDir();
                const repo = new MarkdownRepository(dir);
                await repo.writeCategoryPage('cloud-devops.md', '# Cloud');

                expect(fsMock.mkdir).toHaveBeenCalledWith(categoriesDir, { recursive: true });
                expect(fsMock.writeFile).toHaveBeenCalledWith(
                    path.join(categoriesDir, 'cloud-devops.md'),
                    '# Cloud',
                    'utf-8',
                );
                expect(fsMock.rm).not.toHaveBeenCalled();
                expect(repo.getWriteCount()).toBe(1);
            });

            it('accepts later pages named <slug>--page-N.md', async () => {
                mountCategoriesDir();
                await new MarkdownRepository(dir).writeCategoryPage('big--page-2.md', 'x');
                expect(fsMock.writeFile).toHaveBeenCalledWith(
                    path.join(categoriesDir, 'big--page-2.md'),
                    'x',
                    'utf-8',
                );
            });

            it.each([
                '../README.md',
                '../../evil.md',
                'a/b.md',
                'Upper.md',
                'no-extension',
                '.md',
                '-leading.md',
                'name.txt',
                '',
            ])('rejects page name %p before touching the filesystem', async (name) => {
                const repo = new MarkdownRepository(dir);
                await expect(repo.writeCategoryPage(name, 'x')).rejects.toThrow(
                    /Invalid category page name/,
                );
                expect(fsMock.mkdir).not.toHaveBeenCalled();
                expect(fsMock.writeFile).not.toHaveBeenCalled();
                expect(repo.getWriteCount()).toBe(0);
            });

            it('refuses to write through a categories/ folder that is a link', async () => {
                fsMock.lstat.mockResolvedValue(statOf('link'));
                await expect(
                    new MarkdownRepository(dir).writeCategoryPage('a.md', 'x'),
                ).rejects.toThrow(/not a folder/);
                expect(fsMock.writeFile).not.toHaveBeenCalled();
            });

            it('refuses to write when categories/ is a regular file', async () => {
                fsMock.lstat.mockResolvedValue(statOf('file'));
                await expect(
                    new MarkdownRepository(dir).writeCategoryPage('a.md', 'x'),
                ).rejects.toThrow(/not a folder/);
                expect(fsMock.writeFile).not.toHaveBeenCalled();
            });

            it('replaces a page file that is a link instead of writing through it', async () => {
                mountCategoriesDir({ 'a.md': 'link' });
                await new MarkdownRepository(dir).writeCategoryPage('a.md', 'x');

                const file = path.join(categoriesDir, 'a.md');
                expect(fsMock.rm).toHaveBeenCalledWith(file, { force: true });
                expect(fsMock.rm.mock.invocationCallOrder[0]).toBeLessThan(
                    fsMock.writeFile.mock.invocationCallOrder[0],
                );
                expect(fsMock.writeFile).toHaveBeenCalledWith(file, 'x', 'utf-8');
            });

            it('overwrites an existing plain page in place', async () => {
                mountCategoriesDir({ 'a.md': 'file' });
                await new MarkdownRepository(dir).writeCategoryPage('a.md', 'x');
                expect(fsMock.rm).not.toHaveBeenCalled();
                expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
            });
        });

        describe('removeStaleCategoryPages', () => {
            const generated = `${CATEGORY_PAGE_MARKER}\n# Old\n`;

            it('returns 0 and touches nothing when categories/ does not exist', async () => {
                const repo = new MarkdownRepository(dir);
                await expect(repo.removeStaleCategoryPages(new Set())).resolves.toBe(0);
                expect(fsMock.readdir).not.toHaveBeenCalled();
                expect(fsMock.rm).not.toHaveBeenCalled();
                expect(fsMock.rmdir).not.toHaveBeenCalled();
            });

            it('returns 0 without listing when categories/ is a link', async () => {
                fsMock.lstat.mockResolvedValue(statOf('link'));
                await expect(
                    new MarkdownRepository(dir).removeStaleCategoryPages(new Set()),
                ).resolves.toBe(0);
                expect(fsMock.readdir).not.toHaveBeenCalled();
            });

            it('removes generated pages not in keep, and keeps the ones written this run', async () => {
                mountCategoriesDir();
                fsMock.readdir.mockResolvedValueOnce([
                    dirent('kept.md'),
                    dirent('gone.md'),
                    dirent('gone--page-2.md'),
                ]);
                fsMock.readFile.mockResolvedValue(generated);
                const repo = new MarkdownRepository(dir);

                await expect(repo.removeStaleCategoryPages(new Set(['kept.md']))).resolves.toBe(2);

                expect(fsMock.readdir).toHaveBeenCalledWith(categoriesDir, { withFileTypes: true });
                expect(fsMock.rm.mock.calls).toEqual([
                    [path.join(categoriesDir, 'gone.md'), { force: true }],
                    [path.join(categoriesDir, 'gone--page-2.md'), { force: true }],
                ]);
                expect(fsMock.rmdir).not.toHaveBeenCalled();
                expect(repo.getWriteCount()).toBe(2);
            });

            it('never removes a file without the generated marker, a non-file, or a non-page name', async () => {
                mountCategoriesDir();
                fsMock.readdir.mockResolvedValueOnce([
                    dirent('hand-written.md'),
                    dirent('nested', 'dir'),
                    dirent('linked.md', 'link'),
                    dirent('categories.yml'),
                    dirent('Notes.md'),
                ]);
                fsMock.readFile.mockResolvedValue('# My own notes\n');

                await expect(
                    new MarkdownRepository(dir).removeStaleCategoryPages(new Set()),
                ).resolves.toBe(0);

                expect(fsMock.readFile).toHaveBeenCalledTimes(1);
                expect(fsMock.readFile).toHaveBeenCalledWith(
                    path.join(categoriesDir, 'hand-written.md'),
                    'utf-8',
                );
                expect(fsMock.rm).not.toHaveBeenCalled();
                expect(fsMock.rmdir).not.toHaveBeenCalled();
            });

            it('removes every generated page and then the empty folder when keep is empty', async () => {
                mountCategoriesDir();
                fsMock.readdir.mockResolvedValueOnce([dirent('a.md'), dirent('b.md')]);
                fsMock.readFile.mockResolvedValue(generated);

                await expect(new MarkdownRepository(dir).removeStaleCategoryPages()).resolves.toBe(
                    2,
                );

                expect(fsMock.rm).toHaveBeenCalledTimes(2);
                expect(fsMock.rmdir).toHaveBeenCalledWith(categoriesDir);
            });

            it('ignores a failing rmdir of the emptied folder', async () => {
                mountCategoriesDir();
                fsMock.readdir.mockResolvedValueOnce([dirent('a.md')]);
                fsMock.readFile.mockResolvedValue(generated);
                fsMock.rmdir.mockRejectedValueOnce(new Error('ENOTEMPTY'));

                await expect(
                    new MarkdownRepository(dir).removeStaleCategoryPages(new Set()),
                ).resolves.toBe(1);
            });

            it('keeps a page it cannot read and carries on with the rest', async () => {
                mountCategoriesDir();
                fsMock.readdir.mockResolvedValueOnce([dirent('locked.md'), dirent('old.md')]);
                fsMock.readFile.mockImplementation(async (target: string) => {
                    if (path.basename(target) === 'locked.md') {
                        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
                    }
                    return generated;
                });

                await expect(
                    new MarkdownRepository(dir).removeStaleCategoryPages(new Set()),
                ).resolves.toBe(1);

                expect(fsMock.rm.mock.calls).toEqual([
                    [path.join(categoriesDir, 'old.md'), { force: true }],
                ]);
                // the unreadable page is still there, so the folder stays
                expect(fsMock.rmdir).not.toHaveBeenCalled();
            });

            it('propagates an lstat error other than ENOENT', async () => {
                fsMock.lstat.mockRejectedValue(
                    Object.assign(new Error('EACCES'), { code: 'EACCES' }),
                );
                await expect(
                    new MarkdownRepository(dir).removeStaleCategoryPages(new Set()),
                ).rejects.toThrow('EACCES');
            });
        });
    });

    describe('contracts', () => {
        it('exposes the input dir as a public readonly property', () => {
            const repo = new MarkdownRepository(dir);
            expect(repo.dir).toBe(dir);
        });

        it('builds the details/ path from the constructor dir argument', async () => {
            const customDir = path.join('/srv', 'data');
            await new MarkdownRepository(customDir).writeDetails('s', 'x');
            expect(fsMock.writeFile).toHaveBeenCalledWith(
                path.join(customDir, 'details', 's.md'),
                'x',
                'utf-8',
            );
        });
    });

    // EW-628 G5 — `syncFromDataRepo` reads `getWriteCount()` to populate the
    // `filesChanged` activity-row stat. The counter must accumulate across
    // every writing method and be observable without a real fs round-trip.
    describe('getWriteCount (EW-628 G5)', () => {
        it('starts at zero', () => {
            expect(new MarkdownRepository(dir).getWriteCount()).toBe(0);
        });

        it('increments once per writeReadme / writeDetails / writeLicense / removeDetails', async () => {
            const repo = new MarkdownRepository(dir);
            await repo.writeReadme('a');
            await repo.writeDetails('s1', 'b');
            await repo.writeDetails('s2', 'c');
            await repo.writeLicense('mit');
            await repo.removeDetails('s1');
            expect(repo.getWriteCount()).toBe(5);
        });

        it('increments once per non-allowlisted entry inside resetFiles()', async () => {
            fsMock.readdir.mockResolvedValueOnce([
                '.git', // allowlisted
                'README.md', // counts
                'old', // counts
            ] as unknown as string[]);
            const repo = new MarkdownRepository(dir);
            await repo.resetFiles();
            expect(repo.getWriteCount()).toBe(2);
        });

        it('persists the running total across mixed calls in a single sync run', async () => {
            fsMock.readdir.mockResolvedValueOnce(['old.md'] as unknown as string[]);
            const repo = new MarkdownRepository(dir);
            await repo.resetFiles(); // +1
            await repo.writeReadme('readme'); // +1
            await repo.writeDetails('s', 'details'); // +1
            expect(repo.getWriteCount()).toBe(3);
        });
    });
});
