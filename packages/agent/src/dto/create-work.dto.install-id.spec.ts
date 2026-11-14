import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateWorkDto } from './create-work.dto';

/**
 * `CreateWorkDto.installId`: the install on Ever Platform's marketplace a Work
 * is created for, when the address that sent the person here named one. It is
 * optional for every kind, an install id of Ever Platform when present (a ULID,
 * stored in its canonical upper-case spelling), and whitelisted by the global
 * pipe (`whitelist` + `forbidNonWhitelisted`), which would otherwise answer
 * `property installId should not exist`.
 */
const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';

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

describe('CreateWorkDto.installId', () => {
    it.each([
        ['an App', app],
        ['a generated site', website],
    ])('is optional for %s', async (_name, base) => {
        const { dto, properties } = await check({ ...base });
        expect(properties).toEqual([]);
        expect(dto.installId).toBeUndefined();
    });

    it.each([
        ['an App', app],
        ['a generated site', website],
    ])('is accepted and kept for %s', async (_name, base) => {
        const { dto, properties } = await check({ ...base, installId: INSTALL });
        expect(properties).toEqual([]);
        expect(dto.installId).toBe(INSTALL);
    });

    it('is kept in its canonical spelling, whatever its case or surrounding space', async () => {
        const { dto, properties } = await check({
            ...app,
            installId: `  ${INSTALL.toLowerCase()} `,
        });
        expect(properties).toEqual([]);
        expect(dto.installId).toBe(INSTALL);
    });

    it.each([
        ['empty', ''],
        ['too short', INSTALL.slice(0, 25)],
        ['too long', `${INSTALL}0`],
        // The letters I, L, O and U never appear in an id.
        ['a letter outside the alphabet', `${INSTALL.slice(0, 25)}U`],
        ['an address', 'https://apps.example.test/installs/1'],
        ['a path', '../../etc/passwd'],
        ['a number', 42],
        ['an object', { id: INSTALL }],
    ])('refuses a value that is not an install id (%s)', async (_name, installId) => {
        const { properties } = await check({ ...app, installId });
        expect(properties).toEqual(['installId']);
    });

    it('a field the DTO does not declare is still refused by the pipe', async () => {
        const { properties } = await check({ ...app, installId: INSTALL, install: INSTALL });
        expect(properties).toEqual(['install']);
    });
});
