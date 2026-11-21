import { redactErrorText, redactGenerationText } from '../error-text-redaction';

/**
 * Generation errors and logs are shown to the Work's owner, and on app.ever.works that owner can be an
 * anonymous visitor. A provider message that echoes a masked or partial key would hand the last
 * characters of the PLATFORM key to anyone. These are the shapes real providers send.
 */

const R = '[redacted secret]';

describe('redactErrorText', () => {
    describe('keeps the human-readable part exactly as it was', () => {
        it.each([
            'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
            'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
            'No endpoints found for meta-llama/llama-3.3-70b-instruct:free.',
            'Repository not found. Please verify the repository exists and try again.',
            'Request failed for ever-works-cloud/anon-240f5bea-i-want-to-build-awesome-directory-of-ai-536ubq',
            'request id 3f2b1c9e-4d5a-4b6c-8d7e-9f0a1b2c3d4e (trace 3F2B1C9E-4D5A-4B6C-8D7E-9F0A1B2C3D4E)',
            // (The shared scanner treats "Bearer" + any 10+ characters as a credential, so prose
            // reading "Bearer authentication" was already redacted before this change.)
            'Bearer auth failed. Check your settings…',
            'Generation skipped... nothing to sync for this Work.',
            'Web search (Tavily) was unavailable during generation (HTTP 432). Some results may be missing.',
            'The model returned 1,234 tokens at 2026-11-20T22:31:06.621Z',
        ])('%s', (message) => {
            expect(redactErrorText(message)).toBe(message);
        });

        it('returns empty and missing text as it is', () => {
            expect(redactErrorText('')).toBe('');
        });
    });

    describe('removes keys a provider echoes back', () => {
        it('an OpenAI masked key, keeping the sentence and the help link', () => {
            const masked = `sk-proj-${'*'.repeat(140)}wxyz`;
            expect(
                redactErrorText(
                    `Incorrect API key provided: ${masked}. You can find your API key at https://platform.openai.com/account/api-keys.`,
                ),
            ).toBe(
                `Incorrect API key provided: ${R}. You can find your API key at https://platform.openai.com/account/api-keys.`,
            );
        });

        it('a partly masked key with its head and tail', () => {
            expect(
                redactErrorText(
                    'Incorrect API key provided: sk-abcd****************************WXyz.',
                ),
            ).toBe(`Incorrect API key provided: ${R}.`);
            expect(
                redactErrorText('Invalid key sk-proj-abcdefgh1234****wxyz for this project'),
            ).toBe(`Invalid key ${R} for this project`);
        });

        it('an ellipsis-masked key', () => {
            expect(redactErrorText('The key sk-…a1B2 was rejected')).toBe(
                `The key ${R} was rejected`,
            );
            expect(redactErrorText('OpenRouter key sk-or-v1-0a1b...9f8e is disabled')).toBe(
                `OpenRouter key ${R} is disabled`,
            );
        });

        it('a full OpenRouter key', () => {
            const key = `sk-or-v1-${'0a1b2c3d'.repeat(8)}`;
            expect(redactErrorText(`User not found for key ${key}`)).toBe(
                `User not found for key ${R}`,
            );
        });

        it('a Tavily key, full or masked', () => {
            expect(
                redactErrorText(
                    'Unauthorized: invalid API key tvly-dev-AbCdEf0123456789AbCdEf0123456789',
                ),
            ).toBe(`Unauthorized: invalid API key ${R}`);
            expect(redactErrorText('Unauthorized: invalid API key tvly-****WXYZ')).toBe(
                `Unauthorized: invalid API key ${R}`,
            );
        });

        it('GitHub tokens, full or masked', () => {
            expect(redactErrorText(`Bad credentials for ghp_${'AbCd0123'.repeat(5)}`)).toBe(
                `Bad credentials for ${R}`,
            );
            expect(
                redactErrorText(`Bad credentials for github_pat_${'11ABCDEFG0'.repeat(4)}_xyz`),
            ).toBe(`Bad credentials for ${R}`);
            expect(redactErrorText('Bad credentials for gho_****9z8Y')).toBe(
                `Bad credentials for ${R}`,
            );
        });

        it('a Bearer token, keeping the scheme word', () => {
            expect(
                redactErrorText(
                    '401 for header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.ZRrHA1',
                ),
            ).toBe(`401 for header Authorization: Bearer ${R}`);
            expect(redactErrorText('Authorization: Bearer abc123')).toBe(
                `Authorization: Bearer ${R}`,
            );
        });

        it('a key tail next to a key word', () => {
            expect(redactErrorText('The API key ending in …a1B2 has been revoked')).toBe(
                `The API key ending in ${R} has been revoked`,
            );
            expect(redactErrorText('token ending ...9f8e expired')).toBe(
                `token ending ${R} expired`,
            );
            expect(redactErrorText('masked as ****ab12 in the request')).toBe(
                `masked as ${R} in the request`,
            );
        });

        it('long hex and base64 runs', () => {
            expect(
                redactErrorText(
                    'invalid signature 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
                ),
            ).toBe(`invalid signature ${R}`);
            expect(redactErrorText('Firecrawl rejected fc-0123456789abcdef0123456789abcdef')).toBe(
                `Firecrawl rejected ${R}`,
            );
            expect(
                redactErrorText(
                    'basic credentials QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA= refused',
                ),
            ).toBe(`basic credentials ${R} refused`);
        });

        it('credentials in a URL, keeping scheme and host', () => {
            expect(
                redactErrorText('fetch https://oauth2:gho_abc@github.com/ever-works/x.git failed'),
            ).toBe('fetch https://***:***@github.com/ever-works/x.git failed');
        });
    });

    it('stays linear on long hostile input', () => {
        const hostile = `${'a'.repeat(50_000)}!${'*'.repeat(50_000)}${'.'.repeat(50_000)}`;
        const started = Date.now();
        redactErrorText(`sk-${hostile} Bearer ${hostile} key ${hostile}`);
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});

describe('redactGenerationText', () => {
    const masked = `sk-proj-${'*'.repeat(40)}wxyz`;

    it('redacts the error, every warning and every log message', () => {
        const status = {
            status: 'error',
            error: `Incorrect API key provided: ${masked}.`,
            warnings: [
                `Web search (Tavily) was unavailable during generation (invalid key ${masked}).`,
            ],
            recentLogs: [
                {
                    level: 'error',
                    message: `Parent agent: stream error - Incorrect API key provided: ${masked}.`,
                },
                { level: 'info', message: 'Generation started' },
            ],
        };

        expect(redactGenerationText(status)).toEqual({
            status: 'error',
            error: `Incorrect API key provided: ${R}.`,
            warnings: [`Web search (Tavily) was unavailable during generation (invalid key ${R}).`],
            recentLogs: [
                {
                    level: 'error',
                    message: `Parent agent: stream error - Incorrect API key provided: ${R}.`,
                },
                { level: 'info', message: 'Generation started' },
            ],
        });
    });

    it('returns the same object when nothing needs redacting', () => {
        const status = {
            status: 'error',
            error: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
            warnings: [],
            recentLogs: [{ message: 'Generation started' }],
        };
        expect(redactGenerationText(status)).toBe(status);
    });

    it('passes null and undefined through', () => {
        expect(redactGenerationText(null)).toBeNull();
        expect(redactGenerationText(undefined)).toBeUndefined();
    });
});
