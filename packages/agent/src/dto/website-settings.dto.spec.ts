import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateWebsiteSettingsDto } from './website-settings.dto';

async function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(UpdateWebsiteSettingsDto, body);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return errors.map((error) => ({ property: error.property, constraints: error.constraints }));
}

describe('UpdateWebsiteSettingsDto.company_website', () => {
    it('accepts an empty site URL — what the settings form sends for a Work that has none', async () => {
        // GET /works/:id/website-settings answers `company_website: ''` when no
        // URL is set and the form posts it back unchanged: every save of such a
        // Work used to fail with "company_website must be a URL address".
        expect(await errorsFor({ company_name: 'Acme', company_website: '' })).toEqual([]);
    });

    it('accepts an absent site URL', async () => {
        expect(await errorsFor({ company_name: 'Acme' })).toEqual([]);
    });

    it('accepts an http(s) URL', async () => {
        expect(await errorsFor({ company_website: 'https://acme.example' })).toEqual([]);
        expect(await errorsFor({ company_website: 'http://acme.example/about' })).toEqual([]);
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'ftp://acme.example',
        'acme.example',
        ' ',
    ])('still refuses %j', async (value) => {
        const errors = await errorsFor({ company_website: value });
        expect(errors.map((error) => error.property)).toEqual(['company_website']);
    });

    it('still refuses a site URL longer than 200 characters', async () => {
        const errors = await errorsFor({
            company_website: `https://acme.example/${'a'.repeat(200)}`,
        });
        expect(errors.map((error) => error.property)).toEqual(['company_website']);
    });
});

describe('UpdateWebsiteSettingsDto.company_name', () => {
    it('accepts 100 characters and refuses 101', async () => {
        expect(await errorsFor({ company_name: 'a'.repeat(100) })).toEqual([]);
        const errors = await errorsFor({ company_name: 'a'.repeat(101) });
        expect(errors.map((error) => error.property)).toEqual(['company_name']);
    });
});
