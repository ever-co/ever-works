import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS_BY_CHIP } from '@/components/new/new-prompt.shared';
import {
    GENERATED_WORK_SLUG_MAX_LENGTH,
    TYPED_WORK_SLUG_MAX_LENGTH,
    isValidWorkSlug,
    isWorkSlugTooLong,
    quickCreateSlugFromPrompt,
    slugifyForWork,
    WORK_SLUG_PATTERN,
    workSlugFromName,
} from './work-slug.shared';

const MESSAGES_DIR = join(__dirname, '../../../messages');

/** Every locale's Create-Work example chips (`dashboard.workCreation.ai.examplePrompts`). */
function exampleNamesByLocale(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const file of readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'))) {
        const messages = JSON.parse(readFileSync(join(MESSAGES_DIR, file), 'utf8'));
        const examples = messages?.dashboard?.workCreation?.ai?.examplePrompts ?? {};
        for (const example of Object.values(examples) as Array<{ name: string }>) {
            out.push([file.replace('.json', ''), example.name]);
        }
    }
    return out;
}

describe('workSlugFromName', () => {
    it('keeps Latin names readable', () => {
        expect(workSlugFromName('AI Tools Directory')).toBe('ai-tools-directory');
        expect(workSlugFromName('Café & Crème Guide')).toBe('cafe-creme-guide');
    });

    it('transliterates Cyrillic and Greek', () => {
        expect(workSlugFromName('Инструменты ИИ')).toBe('instrumenty-ii');
        expect(workSlugFromName('Каталог інструментів')).toBe('katalog-instrumentiv');
        expect(workSlugFromName('Οδηγός')).toBe('odigos');
    });

    it.each([
        '远程团队工具',
        'أدوات الذكاء الاصطناعي',
        'כלי בינה מלאכותית',
        'एआई उपकरण',
        'เครื่องมือ AI',
        '원격 근무 도구',
    ])('gives %s a valid slug — it used to be empty and the create failed', (name) => {
        const slug = workSlugFromName(name);
        expect(isValidWorkSlug(slug)).toBe(true);
    });

    it('is stable, so the browser and the server derive the same slug', () => {
        expect(workSlugFromName('远程团队工具')).toBe(workSlugFromName('远程团队工具'));
        expect(workSlugFromName('远程团队工具')).not.toBe(workSlugFromName('远程团队'));
    });

    it('caps a generated slug without leaving a trailing hyphen', () => {
        const slug = workSlugFromName('word '.repeat(40));
        expect(slug.length).toBeLessThanOrEqual(GENERATED_WORK_SLUG_MAX_LENGTH);
        expect(isValidWorkSlug(slug)).toBe(true);
    });

    it('is empty only for a blank name', () => {
        expect(workSlugFromName('   ')).toBe('');
    });

    it.each(exampleNamesByLocale())(
        'derives a valid slug from the %s example "%s"',
        (_locale, name) => {
            expect(workSlugFromName(name)).toMatch(WORK_SLUG_PATTERN);
        },
    );
});

describe('slugifyForWork', () => {
    it('normalizes a typed slug as before for ASCII input', () => {
        expect(slugifyForWork('My Work 2')).toBe('my-work-2');
        expect(slugifyForWork('--a--b--')).toBe('a-b');
    });
});

describe('quickCreateSlugFromPrompt', () => {
    it('never produces a double hyphen when the cut lands on a space', () => {
        // The 40th character of this prompt's slug is a hyphen: it used to give
        // `a-blog-about-indie-game-dev-and-tooling--abc123` → 400.
        const slug = quickCreateSlugFromPrompt(
            'A blog about indie game dev and tooling for small teams',
            'abc123',
        );
        expect(slug).toBe('a-blog-about-indie-game-dev-and-tooling-abc123');
        expect(isValidWorkSlug(slug)).toBe(true);
    });

    it('falls back to quick-<suffix> for a prompt with nothing to slugify', () => {
        expect(quickCreateSlugFromPrompt('!!!', 'abc123')).toBe('quick-abc123');
    });

    it('slugifies a non-Latin prompt', () => {
        expect(
            isValidWorkSlug(
                quickCreateSlugFromPrompt('Каталог инструментов для команды', 'abc123'),
            ),
        ).toBe(true);
    });

    it.each(Object.values(PLACEHOLDERS_BY_CHIP).flat())(
        'gives the example prompt "%s" a valid slug',
        (prompt) => {
            expect(quickCreateSlugFromPrompt(prompt, 'abc123')).toMatch(WORK_SLUG_PATTERN);
            expect(quickCreateSlugFromPrompt(prompt)).toMatch(WORK_SLUG_PATTERN);
        },
    );
});

describe('isWorkSlugTooLong — a typed slug may be as long as a repository name allows', () => {
    it('allows up to 92 characters (GitHub 100 minus "-website")', () => {
        expect(TYPED_WORK_SLUG_MAX_LENGTH).toBe(92);
        expect(isWorkSlugTooLong('a'.repeat(92))).toBe(false);
        expect(isWorkSlugTooLong('a'.repeat(93))).toBe(true);
    });

    it('keeps the 61-92 character slugs that work today', () => {
        expect(isWorkSlugTooLong('a'.repeat(GENERATED_WORK_SLUG_MAX_LENGTH + 1))).toBe(false);
        expect(isWorkSlugTooLong('a'.repeat(80))).toBe(false);
    });

    it('never flags a slug derived from a name', () => {
        expect(isWorkSlugTooLong(workSlugFromName('x '.repeat(200)))).toBe(false);
    });
});
