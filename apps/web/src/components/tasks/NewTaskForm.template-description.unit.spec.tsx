import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { instantiateTaskTemplateAction } = vi.hoisted(() => ({
    instantiateTaskTemplateAction: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/lib/api/agent-templates', () => ({ listAstTemplates: vi.fn(async () => []) }));
vi.mock('@/app/actions/task-templates', () => ({
    instantiateTaskTemplateAction,
    listTaskTemplatesAction: vi.fn(async () => [
        { id: 'tpl-1', name: 'Compound workflow', slug: 'compound', steps: [] },
    ]),
}));
// The pickers load their own data; they play no part in the description.
vi.mock('./WorkSelect', () => ({ WorkSelect: () => null }));
vi.mock('./TaskExtraReposPicker', () => ({ TaskExtraReposPicker: () => null }));
vi.mock('./ChecksEditor', () => ({ ChecksEditor: () => null }));

import { NewTaskForm } from './NewTaskForm';
import { TASK_TEMPLATE_DESCRIPTION_MAX_LENGTH } from '@/lib/api/task-templates.shared';

const descriptionField = () =>
    screen.getByPlaceholderText('descriptionPlaceholder') as HTMLTextAreaElement;
const submitButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

async function renderInTemplateMode() {
    render(<NewTaskForm createTask={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('namePlaceholder'), {
        target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getByTestId('new-task-mode-template'));
    // The template list loads on the first switch into template mode.
    await waitFor(() => expect(submitButton('createFromTemplate').disabled).toBe(false));
}

/**
 * `InstantiateTaskTemplateDto.description` is `@MaxLength(8000)`; the template
 * mode of the New-Task form had no limit and a longer description came back as
 * the API's 400.
 */
describe('NewTaskForm — template mode keeps the description within 8000 characters', () => {
    beforeEach(() => {
        instantiateTaskTemplateAction.mockReset();
        instantiateTaskTemplateAction.mockResolvedValue({ parentTask: { id: 'task-1' } });
    });

    it('sends a description of exactly the cap', async () => {
        await renderInTemplateMode();
        fireEvent.change(descriptionField(), {
            target: { value: 'd'.repeat(TASK_TEMPLATE_DESCRIPTION_MAX_LENGTH) },
        });

        expect(screen.queryByTestId('new-task-description-too-long')).toBeNull();
        fireEvent.click(submitButton('createFromTemplate'));
        await waitFor(() => expect(instantiateTaskTemplateAction).toHaveBeenCalledTimes(1));
        expect(instantiateTaskTemplateAction.mock.calls[0]![1].description).toHaveLength(
            TASK_TEMPLATE_DESCRIPTION_MAX_LENGTH,
        );
    });

    it('says a longer one is too long, and sends nothing', async () => {
        await renderInTemplateMode();
        fireEvent.change(descriptionField(), {
            target: { value: 'd'.repeat(TASK_TEMPLATE_DESCRIPTION_MAX_LENGTH + 1) },
        });

        const notice = screen.getByTestId('new-task-description-too-long');
        expect(notice.textContent).toBe(
            `descriptionTooLong:${JSON.stringify({ max: 8000, count: 8001 })}`,
        );
        expect(descriptionField().getAttribute('aria-describedby')).toBe(notice.id);
        expect(submitButton('createFromTemplate').disabled).toBe(true);

        fireEvent.submit(descriptionField().closest('form')!);
        expect(instantiateTaskTemplateAction).not.toHaveBeenCalled();
    });

    it('leaves a blank Task’s description alone (that endpoint has no cap)', () => {
        render(<NewTaskForm createTask={vi.fn()} />);
        fireEvent.change(descriptionField(), {
            target: { value: 'd'.repeat(TASK_TEMPLATE_DESCRIPTION_MAX_LENGTH + 1) },
        });

        expect(screen.queryByTestId('new-task-description-too-long')).toBeNull();
    });
});
