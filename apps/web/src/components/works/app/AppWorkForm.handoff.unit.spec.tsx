import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import type { AppSourceInspectResponse } from '@ever-works/contracts';
import messages from '../../../../messages/en.json';

/**
 * The App Work create form opened from a Blueprint hand-off: a person installed
 * a Blueprint listing on Ever Platform's marketplace and was sent here
 * (`/new?type=app&blueprint=…&install=…`). Rendered with the real English
 * catalogue; the server actions are mocked at their module boundary.
 */
const { inspectMock, createMock, pushMock, catalogMock, curatedMock } = vi.hoisted(() => ({
    inspectMock: vi.fn(),
    createMock: vi.fn(),
    pushMock: vi.fn(),
    catalogMock: vi.fn(),
    curatedMock: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/apps-catalog', () => ({
    listAppsCatalogBlueprintsAction: catalogMock,
    listAppsCatalogAction: curatedMock,
}));

vi.mock('@/app/actions/dashboard/works', () => ({
    inspectAppSourceAction: inspectMock,
    createWork: createMock,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: pushMock, back: vi.fn(), refresh: vi.fn() }),
    Link: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { AppWorkForm } from './AppWorkForm';

const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const UPSTREAM = 'https://github.com/calcom/cal.diy';
const COPY = messages.dashboard.workCreation.app.handoff;

function preview(over: Partial<AppSourceInspectResponse> = {}): AppSourceInspectResponse {
    return {
        repository: {
            owner: 'calcom',
            repo: 'cal.diy',
            fullName: 'calcom/cal.diy',
            url: UPSTREAM,
            defaultBranch: 'main',
            stars: 100,
            sizeKb: 2048,
            visibility: 'public',
            archived: false,
            empty: false,
            isFork: false,
            allowForking: true,
            usesLfs: false,
        },
        access: { canPush: false, canAdmin: false },
        modes: {
            link: { available: false, reason: 'no_push_access' },
            fork: { available: true },
            'private-copy': { available: true },
        },
        defaultMode: 'fork',
        targetOwners: [{ login: 'me', type: 'user', available: true, existingForkChecked: true }],
        blueprint: { status: 'matched', id: 'cal-diy', name: 'Cal.diy', prompts: [] },
        license: { spdx: 'MIT', class: 'green', source: 'blueprint' },
        deployTargets: {
            none: { available: true },
            'your-cluster': { available: true, providerId: 'k8s' },
            'ever-works-apps': { available: false, reason: 'managed_hosting_unavailable' },
        },
        scanIncomplete: false,
        ...over,
    } as AppSourceInspectResponse;
}

function renderForm(props: Partial<Parameters<typeof AppWorkForm>[0]> = {}) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppWorkForm gitProvider="github" {...props} />
        </NextIntlClientProvider>,
    );
}

const EVER_ORG = '01JMQCK0RG000000000000000A';

/** As the page gives it in the Organization the install belongs to. */
const handoff = (over: Record<string, unknown> = {}) => ({
    blueprintId: 'cal-diy',
    repositoryUrl: UPSTREAM as string | null,
    installId: INSTALL as string | null,
    everOrg: EVER_ORG as string | null,
    ...over,
});

/** Submit the form once its preview is in. */
async function submit() {
    await screen.findByTestId('app-work-preview');
    await waitFor(() =>
        expect((screen.getByTestId('app-work-submit') as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
        fireEvent.click(screen.getByTestId('app-work-submit'));
    });
}

beforeEach(() => {
    cleanup();
    inspectMock.mockReset();
    createMock.mockReset();
    pushMock.mockReset();
    catalogMock.mockReset();
    curatedMock.mockReset();
    inspectMock.mockResolvedValue({ success: true, data: preview() });
    createMock.mockResolvedValue({ success: true, work: { id: 'work-1' } });
});

describe('AppWorkForm — a Blueprint hand-off', () => {
    it('opens on the Blueprint’s repository and checks it once, with the Blueprint, without a click', async () => {
        renderForm({ handoff: handoff() });

        expect(await screen.findByTestId('app-work-preview')).toBeTruthy();
        expect((screen.getByTestId('app-work-url') as HTMLInputElement).value).toBe(UPSTREAM);
        expect(inspectMock).toHaveBeenCalledTimes(1);
        expect(inspectMock).toHaveBeenCalledWith({
            repositoryUrl: UPSTREAM,
            gitProvider: 'github',
            blueprintId: 'cal-diy',
        });
        // The person is told what the App they are about to create is for.
        expect(screen.getByTestId('app-work-handoff-install').textContent).toBe(COPY.forInstall);
        expect(screen.queryByTestId('app-work-handoff-missing')).toBeNull();
    });

    it('creates the App with the Blueprint and the install it is for', async () => {
        renderForm({ handoff: handoff() });
        await submit();

        expect(createMock).toHaveBeenCalledTimes(1);
        expect(createMock.mock.calls[0][0]).toMatchObject({
            kind: 'app',
            repositoryUrl: UPSTREAM,
            repositoryMode: 'fork',
            targetOwner: 'me',
            blueprintId: 'cal-diy',
            // Together: the API checks the Organization against the Ever organization.
            installId: INSTALL,
            everOrg: EVER_ORG,
        });
        await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/works/work-1'));
    });

    it.each([
        ['without an install', { installId: null, everOrg: null }],
        // Opened outside the Organization the install belongs to, the page gives neither.
        ['with an install and no Ever organization', { everOrg: null }],
        ['with an Ever organization and no install', { installId: null }],
    ])('a hand-off %s sends neither, and says nothing about an install', async (_name, over) => {
        renderForm({ handoff: handoff(over) });
        await submit();

        expect(createMock.mock.calls[0][0]).toMatchObject({ blueprintId: 'cal-diy' });
        expect(createMock.mock.calls[0][0]).not.toHaveProperty('installId');
        expect(createMock.mock.calls[0][0]).not.toHaveProperty('everOrg');
        expect(screen.queryByTestId('app-work-handoff-install')).toBeNull();
    });

    it('typing another repository leaves the hand-off: neither its Blueprint nor its install is sent', async () => {
        renderForm({ handoff: handoff() });
        await screen.findByTestId('app-work-preview');

        inspectMock.mockResolvedValue({
            success: true,
            data: preview({
                repository: {
                    ...preview().repository,
                    owner: 'acme',
                    repo: 'other',
                    fullName: 'acme/other',
                    url: 'https://github.com/acme/other',
                },
                blueprint: { status: 'none' },
            } as Partial<AppSourceInspectResponse>),
        });
        fireEvent.change(screen.getByTestId('app-work-url'), {
            target: { value: 'https://github.com/acme/other' },
        });
        expect(screen.queryByTestId('app-work-handoff-install')).toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-work-check'));
        });
        // The second check is the person's own: no Blueprint is asked for.
        expect(inspectMock).toHaveBeenLastCalledWith({
            repositoryUrl: 'https://github.com/acme/other',
            gitProvider: 'github',
        });
        await submit();

        const sent = createMock.mock.calls[0][0];
        expect(sent).toMatchObject({ repositoryUrl: 'https://github.com/acme/other' });
        expect(sent).not.toHaveProperty('installId');
        expect(sent).not.toHaveProperty('everOrg');
        expect(sent).not.toHaveProperty('blueprintId');
    });

    it('a Blueprint the catalog here does not have opens the catalog, says so, and checks nothing', async () => {
        curatedMock.mockResolvedValue({
            success: true,
            data: { available: true, items: [], total: 0, page: 1, limit: 100 },
        });
        renderForm({ handoff: handoff({ repositoryUrl: null }) });

        expect(screen.getByTestId('app-work-handoff-missing').textContent).toBe(
            COPY.blueprintNotFound,
        );
        expect(await screen.findByTestId('apps-catalog-browser')).toBeTruthy();
        expect(screen.queryByTestId('app-work-url')).toBeNull();
        expect(screen.queryByTestId('app-work-handoff-install')).toBeNull();
        expect(inspectMock).not.toHaveBeenCalled();
    });

    it('a repository that is not one is not checked or sent as a hand-off', async () => {
        curatedMock.mockResolvedValue({
            success: true,
            data: { available: true, items: [], total: 0, page: 1, limit: 100 },
        });
        renderForm({ handoff: handoff({ repositoryUrl: 'javascript:alert(1)' }) });

        expect(screen.getByTestId('app-work-handoff-missing')).toBeTruthy();
        expect(inspectMock).not.toHaveBeenCalled();
    });

    it('without a hand-off the form is as it was: nothing is checked on its own', async () => {
        renderForm({ initialRepositoryUrl: UPSTREAM });

        expect((screen.getByTestId('app-work-url') as HTMLInputElement).value).toBe(UPSTREAM);
        expect(screen.queryByTestId('app-work-handoff-install')).toBeNull();
        expect(screen.queryByTestId('app-work-handoff-missing')).toBeNull();
        await act(async () => {
            await Promise.resolve();
        });
        expect(inspectMock).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(screen.getByTestId('app-work-check'));
        });
        await submit();
        expect(createMock.mock.calls[0][0]).not.toHaveProperty('installId');
        expect(createMock.mock.calls[0][0]).not.toHaveProperty('everOrg');
    });
});
