import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IANA_TIME_ZONE_NAME, IsIanaTimeZone, isIanaTimeZone } from './is-iana-time-zone';

class Probe {
    @IsIanaTimeZone()
    timezone!: string;
}

const isValid = async (timezone: unknown) =>
    (await validate(plainToInstance(Probe, { timezone }))).length === 0;

describe('IsIanaTimeZone', () => {
    // What browsers report today (Intl.DateTimeFormat().resolvedOptions().timeZone).
    // The old exact-match list from Node 24's ICU had only the older spellings,
    // so "Local time" failed with a 400 for these users.
    it.each([
        'Asia/Kolkata',
        'Europe/Kyiv',
        'Asia/Yangon',
        'Asia/Ho_Chi_Minh',
        'Asia/Kathmandu',
        'America/Nuuk',
    ])('accepts the current name %s', async (zone) => {
        expect(await isValid(zone)).toBe(true);
    });

    it.each([
        'Asia/Calcutta',
        'Europe/Kiev',
        'UTC',
        'GMT',
        'Etc/UTC',
        'Etc/GMT+5',
        'America/Argentina/Buenos_Aires',
    ])('still accepts %s', async (zone) => {
        expect(await isValid(zone)).toBe(true);
    });

    it.each([
        'Mars/Phobos',
        '',
        ' Europe/London',
        '+05:00',
        "x'><script>",
        'Europe/London/Extra/Deep',
        42,
    ])('refuses %j', async (zone) => {
        expect(await isValid(zone)).toBe(false);
    });

    // Review of #3162: `Intl.DateTimeFormat` accepts all of these, so a
    // shape-plus-Intl check let them through and stored them verbatim. None is
    // an IANA name as written.
    it.each([
        // ICU's bare abbreviations: PST is Los Angeles WITH daylight saving,
        // IST resolves to India (a user may mean Ireland or Israel).
        'PST',
        'IST',
        'EST',
        'CET',
        // Case variants (`TimeZoneSetting.modeOf` matches only exact 'UTC' / 'GMT').
        'utc',
        'gmt',
        'Utc',
        'europe/london',
        'Europe/london',
        'EUROPE/LONDON',
        'ASIA/KOLKATA',
        'Asia/KOLKATA',
        'ETC/UTC',
        'Etc/utc',
        'america/new_york',
        // ICU's legacy SystemV namespace.
        'SystemV/EST5',
        'SystemV/PST8PDT',
        // Not a zone at all, though shaped like one.
        'Not/AZone',
        'Etc/Unknown',
        'Etc/GMT+15',
    ])('refuses the non-IANA spelling %j (Intl would accept most of these)', async (zone) => {
        expect(await isValid(zone)).toBe(false);
    });

    it('accepts every canonical name the runtime lists, exactly as listed', async () => {
        const listed = (
            Intl as typeof Intl & { supportedValuesOf(key: string): string[] }
        ).supportedValuesOf('timeZone');
        expect(listed.length).toBeGreaterThan(300);
        const refused = listed.filter((zone) => !isIanaTimeZone(zone));
        expect(refused).toEqual([]);
        // The shape alone covers them too, so a runtime whose list holds the
        // other spelling of a zone (Asia/Kolkata vs Asia/Calcutta) still passes.
        expect(listed.filter((zone) => !IANA_TIME_ZONE_NAME.test(zone))).toEqual([]);
    });

    it.each([
        'America/New_York',
        'America/Los_Angeles',
        'America/Sao_Paulo',
        'America/Port-au-Prince',
        'America/North_Dakota/New_Salem',
        'America/Indiana/Tell_City',
        'America/Ciudad_Juarez',
        'Europe/London',
        'Europe/Berlin',
        'Europe/Isle_of_Man',
        'Africa/Dar_es_Salaam',
        'Asia/Tokyo',
        'Asia/Ust-Nera',
        'Australia/Sydney',
        'Antarctica/DumontDUrville',
        'Pacific/Kanton',
        'Pacific/Auckland',
        'Etc/GMT-14',
        'Etc/GMT+12',
        'Etc/GMT0',
        'Etc/GMT',
        'Etc/UCT',
        'Etc/Universal',
    ])('accepts the real zone %s', async (zone) => {
        expect(await isValid(zone)).toBe(true);
    });

    it('reports one error with the contract message', async () => {
        const errors = await validate(plainToInstance(Probe, { timezone: 'PST' }));
        expect(errors).toHaveLength(1);
        expect(Object.values(errors[0].constraints ?? {})).toEqual([
            'timezone must be a valid IANA timezone identifier',
        ]);
    });
});
