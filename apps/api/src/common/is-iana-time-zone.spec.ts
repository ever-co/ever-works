import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsIanaTimeZone } from './is-iana-time-zone';

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
});
