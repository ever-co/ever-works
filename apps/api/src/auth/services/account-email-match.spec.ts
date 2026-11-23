import { ConflictException } from '@nestjs/common';
import { findAccountByEmail, normalizeAccountEmail } from './account-email-match';
import { SOCIAL_EMAIL_AMBIGUOUS_CODE, SOCIAL_EMAIL_AMBIGUOUS_MESSAGE } from './social-link-errors';

/**
 * The email-to-account rule the GitHub App setup and the agent onboarding share with the
 * OAuth sign-in: exact first, then a unique case-insensitive match, never a guess.
 */
describe('findAccountByEmail', () => {
    const repo = (
        byExactEmail: Record<string, { id: string }> = {},
        caseVariants: Array<{ id: string }> = [],
    ) => ({
        findByEmail: jest.fn(async (email: string) => byExactEmail[email] ?? null),
        findByEmailCaseInsensitiveForSocialAuth: jest.fn(async () => caseVariants),
    });

    it.each([
        [undefined, null],
        [null, null],
        ['   ', null],
        ['  Jane@Example.COM ', 'jane@example.com'],
    ])('normalizeAccountEmail(%p) is %p', (input, expected) => {
        expect(normalizeAccountEmail(input)).toBe(expected);
    });

    it.each([[undefined], [null], ['  ']])('queries nothing for %p', async (email) => {
        const users = repo();

        await expect(findAccountByEmail(users as never, email)).resolves.toBeNull();
        expect(users.findByEmail).not.toHaveBeenCalled();
        expect(users.findByEmailCaseInsensitiveForSocialAuth).not.toHaveBeenCalled();
    });

    it('answers the exact match on the normalised address without a fallback', async () => {
        const users = repo({ 'jane@example.com': { id: 'u-lower' } });

        await expect(findAccountByEmail(users as never, 'Jane@Example.com')).resolves.toEqual({
            id: 'u-lower',
        });
        expect(users.findByEmail).toHaveBeenCalledTimes(1);
        expect(users.findByEmailCaseInsensitiveForSocialAuth).not.toHaveBeenCalled();
    });

    it('then the exact match on the address as received, when its case differs', async () => {
        const users = repo({ 'José@Example.com': { id: 'u-as-typed' } });

        await expect(findAccountByEmail(users as never, ' José@Example.com ')).resolves.toEqual({
            id: 'u-as-typed',
        });
        expect(users.findByEmail.mock.calls).toEqual([['josé@example.com'], ['José@Example.com']]);
        expect(users.findByEmailCaseInsensitiveForSocialAuth).not.toHaveBeenCalled();
    });

    it('skips the as-received lookup when the address is already normalised', async () => {
        const users = repo();

        await findAccountByEmail(users as never, 'jane@example.com');

        expect(users.findByEmail.mock.calls).toEqual([['jane@example.com']]);
        expect(users.findByEmailCaseInsensitiveForSocialAuth).toHaveBeenCalledWith(
            'jane@example.com',
        );
    });

    it('answers the single case-insensitive match, or null for none', async () => {
        await expect(
            findAccountByEmail(repo({}, [{ id: 'u-variant' }]) as never, 'Jane@Example.com'),
        ).resolves.toEqual({ id: 'u-variant' });
        await expect(findAccountByEmail(repo() as never, 'Jane@Example.com')).resolves.toBeNull();
    });

    it('refuses two case variants with SOCIAL_EMAIL_AMBIGUOUS, naming neither', async () => {
        const users = repo({}, [{ id: 'u-a' }, { id: 'u-b' }]);

        const attempt = findAccountByEmail(users as never, 'Jane@Example.com');

        await expect(attempt).rejects.toBeInstanceOf(ConflictException);
        await expect(attempt).rejects.toMatchObject({
            response: {
                code: SOCIAL_EMAIL_AMBIGUOUS_CODE,
                message: SOCIAL_EMAIL_AMBIGUOUS_MESSAGE,
            },
        });
        expect(SOCIAL_EMAIL_AMBIGUOUS_MESSAGE).not.toMatch(/jane|@|\d/i);
    });
});
