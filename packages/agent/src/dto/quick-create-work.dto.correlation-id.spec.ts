import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { QuickCreateWorkDto } from './quick-create-work.dto';

/**
 * `QuickCreateWorkDto.correlationId`: the funnel id the ever.works home page
 * puts in the onboarding hand-off URL (`#corrId=…`), so a value a visitor can
 * edit. It is persisted on `work.lastDeployCorrelationId`, a `varchar(64)`, and
 * the funnel telemetry endpoint already requires `^[A-Za-z0-9_-]{8,64}$`. The
 * DTO holds it to the same shape: an over-long value is a 400 here rather
 * than a database error after the Work's repository was provisioned.
 */
const BASE = {
    slug: 'ai-robots',
    name: 'AI robots',
    description: 'A directory of AI robot companies',
    prompt: 'A directory of AI robot companies and their products',
} as const;

/** The global pipe's options (`apps/api/src/main.ts`). */
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

async function errorsFor(correlationId: unknown) {
    const dto = plainToInstance(QuickCreateWorkDto, { ...BASE, correlationId });
    const errors = await validate(dto, PIPE);
    return errors.filter((error) => error.property === 'correlationId');
}

describe('QuickCreateWorkDto.correlationId', () => {
    it.each([
        ['a UUID v4', '1b4e28ba-2fa1-41d2-883f-0016d899e4b1'],
        ['the wizard fallback', 'corr-1732140000000-k3j9x2ab'],
        ['eight characters', 'abcdef12'],
        ['sixty-four characters', 'a'.repeat(64)],
    ])('accepts %s', async (_label, value) => {
        expect(await errorsFor(value)).toHaveLength(0);
    });

    it('stays optional', async () => {
        expect(await errorsFor(undefined)).toHaveLength(0);
    });

    it.each([
        ['longer than the varchar(64) column', 'a'.repeat(65)],
        ['shorter than eight characters', 'abc'],
        ['markup', '<script>alert(1)</script>'],
        ['spaces', 'corr id with spaces'],
        ['a non-string', 123],
    ])('refuses %s', async (_label, value) => {
        expect(await errorsFor(value)).not.toHaveLength(0);
    });
});
