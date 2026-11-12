import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * The Work picker's `ownedOnly` mode (review of #3164): the Task and Goal APIs file only on a
 * Work the caller OWNS, so those pickers offer only owned Works — but keep the CURRENT selection,
 * with its name, when it is a shared Work, and read past the first page so a first page full of
 * shared Works cannot hide the caller's own.
 */

const { getWorks } = vi.hoisted(() => ({ getWorks: vi.fn() }));
vi.mock('@/app/actions/dashboard/works', () => ({ getWorks }));

// A native <select> stands in for the portal-rendered listbox (same convention as GoalForm).
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        children,
        onValueChange,
        disabled,
        ...rest
    }: {
        value: string;
        children: React.ReactNode;
        onValueChange: (v: string) => void;
        disabled?: boolean;
    } & Record<string, unknown>) => (
        <select
            data-testid={rest['data-testid'] as string | undefined}
            value={value}
            disabled={disabled}
            onChange={(e) => onValueChange(e.currentTarget.value)}
        >
            {children}
        </select>
    ),
}));

import { WorkSelect } from './WorkSelect';

type Row = { id: string; name: string; kind: string; userRole: string };

const OWNED: Row = { id: 'w-own', name: 'My site', kind: 'directory', userRole: 'owner' };
const SHARED: Row = { id: 'w-shared', name: 'Shared site', kind: 'directory', userRole: 'editor' };
const OTHER_SHARED: Row = {
    id: 'w-other',
    name: 'Other shared',
    kind: 'directory',
    userRole: 'viewer',
};

function page(works: Row[], total = works.length) {
    return { success: true, works, total };
}

function sharedRows(count: number, from = 0): Row[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `w-s${from + i}`,
        name: `Shared ${from + i}`,
        kind: 'directory',
        userRole: 'viewer',
    }));
}

function renderPicker(props: Partial<React.ComponentProps<typeof WorkSelect>> = {}) {
    return render(
        <WorkSelect
            value=""
            onValueChange={vi.fn()}
            noneLabel="No Work"
            testId="picker"
            {...props}
        />,
    );
}

/** Option values once the picker has loaded (it is disabled while loading). */
async function offered(): Promise<string[]> {
    const select = screen.getByTestId('picker');
    await waitFor(() => expect(select).not.toBeDisabled());
    return Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value') ?? '');
}

function optionText(value: string): string | null {
    return (
        screen.getByTestId('picker').querySelector(`option[value="${value}"]`)?.textContent ?? null
    );
}

beforeEach(() => {
    getWorks.mockReset();
});

describe('WorkSelect — ownedOnly', () => {
    it('offers every Work without ownedOnly', async () => {
        getWorks.mockResolvedValue(page([OWNED, SHARED]));
        renderPicker();
        expect(await offered()).toEqual(['', 'w-own', 'w-shared']);
    });

    it('offers only the Works the caller owns, and counts only those', async () => {
        getWorks.mockResolvedValue(page([OWNED, SHARED, OTHER_SHARED]));
        const onLoaded = vi.fn();
        renderPicker({ ownedOnly: true, onLoaded });
        expect(await offered()).toEqual(['', 'w-own']);
        expect(onLoaded).toHaveBeenCalledWith(1);
    });

    it('keeps the current selection with its name when it is a shared Work', async () => {
        getWorks.mockResolvedValue(page([OWNED, SHARED, OTHER_SHARED]));
        renderPicker({ ownedOnly: true, value: SHARED.id });
        expect(await offered()).toEqual(['', 'w-own', 'w-shared']);
        // Its name, not the `w-shared…` id stub a Work the picker never loaded gets.
        expect(optionText(SHARED.id)).toBe('Shared site');
        expect(screen.getByTestId('picker')).toHaveValue(SHARED.id);
    });

    it('reads past a first page of shared Works, so an owned Work on page two is offered', async () => {
        getWorks
            .mockResolvedValueOnce(page(sharedRows(100), 150))
            .mockResolvedValueOnce(page([...sharedRows(49, 100), OWNED], 150));
        renderPicker({ ownedOnly: true });
        expect(await offered()).toEqual(['', 'w-own']);
        expect(getWorks).toHaveBeenCalledTimes(2);
        expect(getWorks).toHaveBeenLastCalledWith({ limit: 100, offset: 100 });
    });

    it('keeps the kind filter on every page', async () => {
        const app = { ...OWNED, kind: 'app' };
        getWorks
            .mockResolvedValueOnce(
                page(
                    sharedRows(100).map((w) => ({ ...w, kind: 'app' })),
                    101,
                ),
            )
            .mockResolvedValueOnce(page([app], 101));
        renderPicker({ ownedOnly: true, kinds: ['app'] });
        expect(await offered()).toEqual(['', 'w-own']);
        expect(getWorks).toHaveBeenNthCalledWith(1, { limit: 100, kind: 'app' });
        expect(getWorks).toHaveBeenNthCalledWith(2, { limit: 100, offset: 100, kind: 'app' });
    });

    it('reads one page only without ownedOnly', async () => {
        getWorks.mockResolvedValue(page(sharedRows(100), 150));
        renderPicker();
        await offered();
        expect(getWorks).toHaveBeenCalledTimes(1);
    });

    it('stops at 1000 Works', async () => {
        getWorks.mockImplementation(async ({ offset = 0 }: { offset?: number }) =>
            page(sharedRows(100, offset), 5000),
        );
        renderPicker({ ownedOnly: true });
        await offered();
        expect(getWorks).toHaveBeenCalledTimes(10);
    });

    it('keeps what it read when a later page fails, and says so', async () => {
        getWorks
            .mockResolvedValueOnce(page([OWNED, ...sharedRows(99)], 150))
            .mockResolvedValueOnce({ success: false, works: [], total: 0, error: 'down' });
        renderPicker({ ownedOnly: true });
        expect(await offered()).toEqual(['', 'w-own']);
        expect(screen.getByRole('alert')).toHaveTextContent('down');
    });
});
