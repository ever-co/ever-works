import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () =>
        Object.assign(
            (key: string, vars?: Record<string, unknown>) =>
                vars ? `${key}:${JSON.stringify(vars)}` : key,
            // The example-prompt chips read their list with `t.raw`.
            { raw: () => ({}) },
        ),
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const createWorkWithAI = vi.fn();
const checkWorkSlug = vi.fn();
vi.mock('@/app/actions/dashboard', () => ({
    createWorkWithAI: (...args: unknown[]) => createWorkWithAI(...args),
    checkWorkSlug: (...args: unknown[]) => checkWorkSlug(...args),
}));
vi.mock('@/app/actions/dashboard/generator-form', () => ({
    getGlobalFormSchema: vi.fn().mockResolvedValue({ success: false }),
}));
// One stable object, so the schema effect does not re-run on every render.
const providerSelection = {
    providers: {},
    handleProviderChange: vi.fn(),
    buildSelectedProviders: () => ({}),
    getUnconfiguredProviders: () => [],
    syncResolvedPipeline: vi.fn(),
};
vi.mock('@/lib/hooks/use-provider-selection', () => ({
    useProviderSelection: () => providerSelection,
}));
// Sections that load their own data and play no part in the slug.
vi.mock('./RepositoryOwnerCard', () => ({ RepositoryOwnerCard: () => null }));
vi.mock('./detail/generator/DynamicPluginFields', () => ({ DynamicPluginFields: () => null }));
vi.mock('./shared/ProviderSelectionSection', () => ({ ProviderSelectionSection: () => null }));
vi.mock('./shared/WorkTemplatePicker', () => ({ WorkTemplatePicker: () => null }));
vi.mock('./detail/shared', () => ({ CollapsibleSection: () => null }));

import { WorkAICreator } from './WorkAICreator';
import { TYPED_WORK_SLUG_MAX_LENGTH } from '@/lib/works/work-slug.shared';

const TOO_LONG = `errors.slugTooLong:${JSON.stringify({ max: TYPED_WORK_SLUG_MAX_LENGTH })}`;

function renderForm() {
    render(
        <WorkAICreator
            websiteTemplates={[]}
            initialPrompt="A directory of tools for remote teams"
        />,
    );
    fireEvent.change(screen.getByPlaceholderText('workNamePlaceholder'), {
        target: { value: 'Remote tools' },
    });
}

const slugField = () => screen.getByPlaceholderText('slugPlaceholder') as HTMLInputElement;
const generateButton = () =>
    screen.getByRole('button', { name: /generateButton/ }) as HTMLButtonElement;

/**
 * The API's slug rule has no length cap, so a typed slug of any length was
 * sent and the create failed only at repository creation. A typed slug now
 * gets the cap a derived one has, and the form says so.
 */
describe('WorkAICreator — a typed slug longer than a derived one may be', () => {
    beforeEach(() => {
        createWorkWithAI.mockReset();
        checkWorkSlug.mockReset();
        checkWorkSlug.mockImplementation(async (slug: string) => ({ available: true, slug }));
    });

    it('takes a slug of exactly the cap', () => {
        renderForm();
        fireEvent.change(slugField(), {
            target: { value: 'a'.repeat(TYPED_WORK_SLUG_MAX_LENGTH) },
        });

        expect(screen.queryByText(TOO_LONG)).toBeNull();
        expect(generateButton().disabled).toBe(false);
    });

    it('says why a longer one is refused, and does not create the Work', () => {
        renderForm();
        fireEvent.change(slugField(), {
            target: { value: 'a'.repeat(TYPED_WORK_SLUG_MAX_LENGTH + 1) },
        });

        expect(screen.getByText(TOO_LONG)).toBeTruthy();
        expect(slugField().getAttribute('aria-invalid')).toBe('true');
        expect(generateButton().disabled).toBe(true);

        fireEvent.click(generateButton());
        expect(createWorkWithAI).not.toHaveBeenCalled();
    });
});

describe("WorkAICreator — an Idea's slug suggestion", () => {
    beforeEach(() => {
        createWorkWithAI.mockReset();
        checkWorkSlug.mockReset();
        checkWorkSlug.mockImplementation(async (slug: string) => ({ available: true, slug }));
    });

    it('a 61-92 character slug is taken (it works today)', () => {
        renderForm();
        fireEvent.change(slugField(), { target: { value: 'a'.repeat(80) } });

        expect(screen.queryByText(TOO_LONG)).toBeNull();
        expect(generateButton().disabled).toBe(false);
    });

    it('opens with an over-long suggestion cut to fit, never with an error', () => {
        render(
            <WorkAICreator
                websiteTemplates={[]}
                initialPrompt="A directory of tools for remote teams"
                proposal={
                    {
                        id: 'p-1',
                        title: 'Remote tools',
                        slugSuggestion: `${'remote-tools-'.repeat(9)}x`,
                    } as never
                }
            />,
        );

        expect(slugField().value.length).toBeLessThanOrEqual(TYPED_WORK_SLUG_MAX_LENGTH);
        expect(slugField().value.endsWith('-')).toBe(false);
        expect(screen.queryByText(TOO_LONG)).toBeNull();
    });
});
