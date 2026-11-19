import {
    DEMO_AI_PROVIDER_ID,
    DemoError,
    DemoFeatureDisabledError,
    DemoModelNotAllowedError,
    DemoModelUnavailableError,
    DemoQuotaExceededError,
    DemoRateLimitedError,
    isFreeModelId,
    isModelUnavailableError,
    pickFreeModel,
} from '..';

/**
 * Platform demo mode — the free-model rule. A model id is free iff it ends in
 * `:free`; anything else is replaced by a free tier model, and when no free
 * model is configured the call fails closed.
 */
describe('demo AI policy', () => {
    describe('isFreeModelId', () => {
        it('accepts an OpenRouter :free id', () => {
            expect(isFreeModelId('google/gemma-4-31b-it:free')).toBe(true);
        });

        it('rejects a paid id', () => {
            expect(isFreeModelId('openai/gpt-6.1-sol')).toBe(false);
        });

        it('rejects an id that only contains :free', () => {
            expect(isFreeModelId('x:free:')).toBe(false);
            expect(isFreeModelId('x:free-trial')).toBe(false);
            expect(isFreeModelId('x:FREE')).toBe(false);
        });

        it('rejects empty, bare-suffix and missing ids', () => {
            expect(isFreeModelId(undefined)).toBe(false);
            expect(isFreeModelId('')).toBe(false);
            expect(isFreeModelId(':free')).toBe(false);
        });
    });

    describe('pickFreeModel', () => {
        const settings = {
            simpleModel: 'c:free',
            complexModel: 'a:free',
            defaultModel: 'b:free',
        };

        it('keeps a requested free model', () => {
            expect(pickFreeModel('z:free', settings, 'complex')).toBe('z:free');
        });

        it("replaces a paid model with the tier's free model", () => {
            expect(pickFreeModel('openai/gpt-6.1-sol', settings, 'complex')).toBe('a:free');
            expect(pickFreeModel('openai/gpt-6.1-sol', settings, 'simple')).toBe('c:free');
        });

        it('falls back to the default model when the tier has none or a paid one', () => {
            expect(pickFreeModel('openai/gpt-6.1-sol', settings, 'medium')).toBe('b:free');
            expect(
                pickFreeModel(
                    'openai/gpt-6.1-sol',
                    { complexModel: 'paid/model', defaultModel: 'b:free' },
                    'complex',
                ),
            ).toBe('b:free');
            expect(pickFreeModel(undefined, settings)).toBe('b:free');
        });

        it('ignores a non-string setting', () => {
            expect(
                pickFreeModel('paid', { complexModel: 42, defaultModel: 'b:free' }, 'complex'),
            ).toBe('b:free');
        });

        it('throws DemoModelNotAllowedError when no free model is configured', () => {
            expect(() =>
                pickFreeModel(
                    'openai/gpt-6.1-sol',
                    { complexModel: 'paid/a', defaultModel: 'paid/b' },
                    'complex',
                ),
            ).toThrow(DemoModelNotAllowedError);
            expect(() => pickFreeModel(undefined, {}, 'simple')).toThrow(DemoModelNotAllowedError);
        });
    });

    it('forces the openrouter provider', () => {
        expect(DEMO_AI_PROVIDER_ID).toBe('openrouter');
    });

    describe('isModelUnavailableError', () => {
        it.each([
            'Model google/gemma:free not found',
            '404 The model `x:free` does not exist',
            'No endpoints found for google/gemma-4-31b-it:free.',
            'google/gone:free is not a valid model ID',
        ])('matches %p', (message) => {
            expect(isModelUnavailableError(new Error(message))).toBe(true);
        });

        it('reads the cause of a wrapped error', () => {
            const wrapped = new Error('Provider call failed', {
                cause: new Error('No endpoints found for x:free'),
            });
            expect(isModelUnavailableError(wrapped)).toBe(true);
        });

        it.each(['Rate limit exceeded', '401 Missing Authentication header', 'timeout'])(
            'does not match %p',
            (message) => {
                expect(isModelUnavailableError(new Error(message))).toBe(false);
            },
        );

        it('does not match a non-error', () => {
            expect(isModelUnavailableError(undefined)).toBe(false);
            expect(isModelUnavailableError('model not found')).toBe(false);
        });
    });

    describe('errors', () => {
        it.each([
            [new DemoFeatureDisabledError('embeddings'), 'DEMO_DISABLED', 403],
            [new DemoQuotaExceededError('sandbox'), 'DEMO_AI_QUOTA', 429],
            [new DemoQuotaExceededError('day'), 'DEMO_AI_QUOTA', 429],
            [new DemoRateLimitedError(1500), 'DEMO_AI_BUSY', 429],
            [new DemoModelNotAllowedError('paid/x'), 'DEMO_MODEL_NOT_ALLOWED', 500],
            [new DemoModelUnavailableError('x:free'), 'DEMO_MODEL_UNAVAILABLE', 503],
        ])('%p carries its code and status', (error: DemoError, code, status) => {
            expect(error).toBeInstanceOf(DemoError);
            expect(error).toBeInstanceOf(Error);
            expect(error.code).toBe(code);
            expect(error.httpStatus).toBe(status);
            expect(error.name).toBe(error.constructor.name);
        });

        it('keeps what each error is about', () => {
            expect(new DemoFeatureDisabledError('embeddings').feature).toBe('embeddings');
            expect(new DemoQuotaExceededError('day').scope).toBe('day');
            expect(new DemoRateLimitedError(1500).retryAfterMs).toBe(1500);
            expect(new DemoModelNotAllowedError('paid/x').modelId).toBe('paid/x');
            expect(new DemoModelUnavailableError('x:free').modelId).toBe('x:free');
        });

        it('only the rate-limit error carries retryAfterMs', () => {
            expect(new DemoQuotaExceededError('sandbox').retryAfterMs).toBeUndefined();
        });

        it('shows the visitor a plain message when the model is gone', () => {
            expect(new DemoModelUnavailableError('x:free').message).toBe(
                'The demo AI model is temporarily unavailable',
            );
        });
    });
});
