import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WebsiteTemplateOption } from '@/lib/api/work';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { WorkTemplatePicker } from './WorkTemplatePicker';

const row = (
    id: string,
    isDefault: boolean,
    defaultForWorkKinds: string[],
): WebsiteTemplateOption => ({
    id,
    name: id,
    description: '',
    isDefault,
    sourceType: 'built_in',
    originType: 'standard',
    defaultForWorkKinds,
});

/** `GET /api/works/website-templates` for a user with no saved default. */
const TEMPLATES = [
    row('classic', true, ['directory', 'awesome-repo', 'default']),
    row('web', false, ['website', 'landing-page', 'blog']),
];

const selected = () =>
    screen
        .getAllByRole('option')
        .filter((option) => option.getAttribute('aria-selected') === 'true')
        .map((option) => option.getAttribute('data-testid'));

/**
 * Review A6 — with nothing picked, the picker highlighted `classic` while a
 * website Work with no saved default builds with `web`.
 */
describe('WorkTemplatePicker — nothing picked highlights what the Work will build with', () => {
    it('highlights `web` for a website Work', () => {
        render(
            <WorkTemplatePicker
                customTemplates={TEMPLATES}
                blueprints={[]}
                workKind="website"
                value=""
                onChange={vi.fn()}
            />,
        );

        expect(selected()).toEqual(['work-template-option-web']);
    });

    it('highlights `classic` for a directory Work', () => {
        render(
            <WorkTemplatePicker
                customTemplates={TEMPLATES}
                blueprints={[]}
                workKind="directory"
                value=""
                onChange={vi.fn()}
            />,
        );

        expect(selected()).toEqual(['work-template-option-classic']);
    });
});
