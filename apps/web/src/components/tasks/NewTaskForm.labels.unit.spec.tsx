import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/lib/api/agent-templates', () => ({ listAstTemplates: vi.fn() }));
vi.mock('@/app/actions/task-templates', () => ({
    instantiateTaskTemplateAction: vi.fn(),
    listTaskTemplatesAction: vi.fn(),
}));
// The pickers load their own data; they play no part in the labels.
vi.mock('./WorkSelect', () => ({ WorkSelect: () => null }));
vi.mock('./TaskExtraReposPicker', () => ({ TaskExtraReposPicker: () => null }));
vi.mock('./ChecksEditor', () => ({ ChecksEditor: () => null }));

import { NewTaskForm } from './NewTaskForm';

const labelsInput = () => screen.getByPlaceholderText('labelsPlaceholder') as HTMLInputElement;

/**
 * Review of #3172 — each label is cut to the API's 80 characters on create;
 * the form now says so instead of cutting it without a word.
 */
describe('NewTaskForm — a label past 80 characters', () => {
    const createTask = vi.fn();

    beforeEach(() => {
        createTask.mockReset();
        createTask.mockResolvedValue({ id: 't1' });
    });

    it('says nothing while every label fits', () => {
        render(<NewTaskForm createTask={createTask} />);
        fireEvent.change(labelsInput(), { target: { value: `ok, ${'x'.repeat(80)}` } });
        expect(screen.queryByTestId('new-task-labels-too-long')).toBeNull();
    });

    it('says a longer label will be shortened, and sends it shortened', async () => {
        render(<NewTaskForm createTask={createTask} />);
        fireEvent.change(screen.getByPlaceholderText('namePlaceholder'), {
            target: { value: 'Ship it' },
        });
        fireEvent.change(labelsInput(), { target: { value: `ok, ${'y'.repeat(81)}` } });

        const notice = screen.getByTestId('new-task-labels-too-long');
        expect(notice.textContent).toBe('labelsTooLong:{"max":80}');
        expect(labelsInput().getAttribute('aria-describedby')).toBe(notice.id);

        fireEvent.click(screen.getByRole('button', { name: 'create' }));
        await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
        expect(createTask.mock.calls[0]![0].labels).toEqual(['ok', 'y'.repeat(80)]);
    });
});
