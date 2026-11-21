import {
    MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT,
    getCustomizationPromptForBaseTemplate,
    hasCustomizationPromptForBaseTemplate,
} from '../index';

describe('customization prompt registry', () => {
    it('returns the minimal-template prompt for "minimal"', () => {
        expect(getCustomizationPromptForBaseTemplate('minimal')).toBe(
            MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT,
        );
        expect(hasCustomizationPromptForBaseTemplate('minimal')).toBe(true);
    });

    it('returns null for templates without a registered prompt (e.g. classic)', () => {
        expect(getCustomizationPromptForBaseTemplate('classic')).toBeNull();
        expect(hasCustomizationPromptForBaseTemplate('classic')).toBe(false);
    });

    it('treats unknown ids and null/undefined as unsupported', () => {
        expect(getCustomizationPromptForBaseTemplate('unknown')).toBeNull();
        expect(getCustomizationPromptForBaseTemplate(null)).toBeNull();
        expect(getCustomizationPromptForBaseTemplate(undefined)).toBeNull();
        expect(hasCustomizationPromptForBaseTemplate('')).toBe(false);
    });

    describe('minimal-template prompt', () => {
        // These assertions pin load-bearing fragments of the prompt: if any of
        // them silently drop, the agent may break the user's fork. Updating a
        // matcher here should be a deliberate change.
        it("forbids functional / config changes so the user's site stays mergeable upstream", () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/visual design brief/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/Do not edit/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/\*\.astro/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/\*\.ts/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/config/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/deployment files/i);
        });

        it('reminds the agent it must not commit or push', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/No commits (?:or|, no) PRs/i);
        });

        it('points the agent at the compile-safe styling surface and canonical levers', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(
                /apps\/web\/src\/styles\/theme\.css/,
            );
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/plain CSS/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/global\.css/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/design tokens/i);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/data-component/);
        });

        it('marks shared workspace packages and content as off-limits', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/packages\/\*\*/);
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(/\.content\/\*\*/);
        });

        it('lists every Tailwind directive that gets theme.css rejected', () => {
            for (const directive of [
                '@apply',
                '@tailwind',
                '@theme',
                '@source',
                '@reference',
                '@plugin',
                '@config',
                '@utility',
                '@variant',
                '@custom-variant',
            ]) {
                expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toContain(`\`${directive}\``);
            }
        });

        // The template's apps/web/src/styles/theme.css comment documents these
        // hooks (directory UI added to directory-web-minimal-template on
        // 2026-11-21). Keep this list in step with that comment.
        it('names the hooks of the directory UI so agents can target it', () => {
            for (const component of [
                'directory-browser',
                'search-dialog',
                'display-settings',
                'theme-toggle',
                'mobile-menu',
                'item-detail',
                'similar-items',
                'share-links',
                'category-cards',
                'submit-form',
                'submit-cta',
                'featured-section',
                'back-to-top',
                'legal-page',
            ]) {
                expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toContain(
                    `[data-component="${component}"]`,
                );
            }
            for (const part of [
                'sidebar',
                'category-chips',
                'toolbar',
                'search',
                'tag-filter',
                'sort',
                'view-toggle',
                'result-count',
                'active-filters',
                'results',
                'pagination',
                'search-trigger',
                'submit',
                'gallery',
                'info',
                'sticky-cta',
            ]) {
                expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toContain(`[data-part="${part}"]`);
            }
        });

        it('documents the visitor display preferences set on <html>', () => {
            for (const selector of [
                'html[data-layout="classic"]',
                'html[data-layout="grid"]',
                'html[data-view="grid"]',
                'html[data-view="list"]',
                'html[data-view="compact"]',
                'html[data-width="fixed"]',
                'html[data-width="full"]',
                'html[data-pagination="standard"]',
                'html[data-pagination="infinite"]',
            ]) {
                expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toContain(selector);
            }
        });

        it('says the directory UI is already themed by the design tokens', () => {
            expect(MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT).toMatch(
                /already (?:styled|themed) (?:from|by) the design tokens/i,
            );
        });
    });
});
