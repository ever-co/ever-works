import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ItemData } from '@/lib/api/types-only';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

const updateItem = vi.fn();
vi.mock('@/app/actions/dashboard/items', () => ({
    updateItem: (...args: unknown[]) => updateItem(...args),
    removeItem: vi.fn(),
    captureScreenshot: vi.fn(),
    checkItemHealth: vi.fn(),
}));
// The menu and the dialog render inline, so the test reaches the Edit-display
// dialog the way a click on "Edit display" does.
vi.mock('@/components/ui/dropdown-menu', () => ({
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>
            {children}
        </button>
    ),
}));
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./MarkdownBodyField', () => ({ MarkdownBodyField: () => null }));
vi.mock('./ScreenshotProviderDialog', () => ({ ScreenshotProviderDialog: () => null }));

import { ItemActions } from './ItemActions';

const item = { slug: 'acme', name: 'Acme', featured: false } as ItemData;

function openDisplayDialog() {
    render(<ItemActions item={item} />);
    fireEvent.click(screen.getByRole('button', { name: /editDisplay/ }));
    return screen.getByRole('dialog');
}

const orderField = () => screen.getByRole('spinbutton') as HTMLInputElement;
const updateButton = () => screen.getByRole('button', { name: 'updateItem' });

/**
 * `UpdateItemDto.order` is `@IsInt() @Min(0)`: -1 or 1.5 used to be sent and
 * came back as the API's raw 400. The dialog now says why and sends nothing.
 */
describe('ItemActions — Edit display: the display order the API accepts', () => {
    beforeEach(() => {
        updateItem.mockReset();
        updateItem.mockResolvedValue({ status: 'success' });
    });

    it.each(['-1', '1.5'])('refuses %s with the reason, and sends nothing', (raw) => {
        openDisplayDialog();
        fireEvent.change(orderField(), { target: { value: raw } });

        expect(screen.getByText('orderInvalid')).toBeTruthy();
        expect(orderField().getAttribute('aria-invalid')).toBe('true');
        expect((updateButton() as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(updateButton());
        expect(updateItem).not.toHaveBeenCalled();
    });

    it('sends a whole number of 0 or more', async () => {
        openDisplayDialog();
        fireEvent.change(orderField(), { target: { value: '0' } });

        expect(screen.queryByText('orderInvalid')).toBeNull();
        fireEvent.click(updateButton());

        await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
        expect(updateItem.mock.calls[0]![1]).toMatchObject({ item_slug: 'acme', order: 0 });
    });

    it('leaves the order alone when the field is empty', async () => {
        openDisplayDialog();
        fireEvent.click(updateButton());

        await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
        expect(updateItem.mock.calls[0]![1].order).toBeUndefined();
    });
});
