import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateWorkDto } from './create-work.dto';

/**
 * `CreateWorkDto.installId` and `CreateWorkDto.everOrg`: what a person sent here
 * from Ever Platform's marketplace brings with them. Both are **claims**: the
 * DTO only lets them through the global pipe (`whitelist` +
 * `forbidNonWhitelisted`, which would otherwise answer `property installId
 * should not exist`), and it decides nothing about them. Whether a claim is
 * read, and what is stored, is the caller's (`AppWorkCreateOptions`); a value
 * that is not spelled like an id is ignored there, never refused here, so a
 * request that carries one is as valid as a request that does not.
 */
const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const EVER_ORG = '01JMQCK0RG000000000000000A';

const website = {
    slug: 'demo',
    name: 'Demo',
    description: 'Demo description',
    organization: false,
} as const;

const app = {
    slug: 'my-app',
    name: 'My App',
    description: 'An app wrapped as a Work',
    organization: false,
    kind: 'app',
    repositoryUrl: 'https://github.com/ever-works/templates',
    repositoryMode: 'link',
} as const;

/** The global pipe's options (`apps/api/src/main.ts`). */
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

async function check(body: Record<string, unknown>) {
    const dto = plainToInstance(CreateWorkDto, body);
    const errors = await validate(dto, PIPE);
    return { dto, properties: errors.map((error) => error.property) };
}

describe('CreateWorkDto — the marketplace install claim', () => {
    it.each([
        ['an App', app],
        ['a generated site', website],
    ])('is optional for %s: a request without it is as it always was', async (_name, base) => {
        const { dto, properties } = await check({ ...base });
        expect(properties).toEqual([]);
        expect(dto.installId).toBeUndefined();
        expect(dto.everOrg).toBeUndefined();
    });

    it.each([
        ['an App', app],
        ['a generated site', website],
    ])('passes the pipe for %s, as it came (nothing is decided here)', async (_name, base) => {
        const { dto, properties } = await check({ ...base, installId: INSTALL, everOrg: EVER_ORG });
        expect(properties).toEqual([]);
        expect(dto.installId).toBe(INSTALL);
        expect(dto.everOrg).toBe(EVER_ORG);
    });

    it.each([
        ['empty', ''],
        ['not an install id', 'install-1'],
        ['lower case', INSTALL.toLowerCase()],
        ['an address', 'https://apps.example.test/installs/1'],
    ])(
        'a value that is not spelled like an id is not an error (%s): it is ignored later',
        async (_name, value) => {
            const { properties } = await check({ ...app, installId: value, everOrg: value });
            expect(properties).toEqual([]);
        },
    );

    it.each([
        ['a number', 42],
        ['an object', { id: INSTALL }],
        ['a list', [INSTALL]],
        ['text that is too long', 'x'.repeat(65)],
    ])('refuses only what is not short text (%s)', async (_name, value) => {
        expect((await check({ ...app, installId: value })).properties).toEqual(['installId']);
        expect((await check({ ...app, everOrg: value })).properties).toEqual(['everOrg']);
    });

    it('a field the DTO does not declare is still refused by the pipe', async () => {
        const { properties } = await check({ ...app, installId: INSTALL, install: INSTALL });
        expect(properties).toEqual(['install']);
    });
});
