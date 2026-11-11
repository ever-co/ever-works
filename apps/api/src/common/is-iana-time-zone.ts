import { ValidateBy, isTimeZone, type ValidationOptions } from 'class-validator';

/**
 * The shape of an IANA `Area/Location` zone name, case-sensitive:
 *  - `Etc/` names: `Etc/UTC`, `Etc/GMT+5`, `Etc/GMT-14`, `Etc/Universal`…;
 *  - otherwise a capitalised area word (`Europe`, `America`) and one or two
 *    location segments that start upper-then-lower case (`London`,
 *    `Argentina/Buenos_Aires`, `Port-au-Prince`, `DumontDUrville`).
 * Every one of the 418 names in Node 24's `Intl.supportedValuesOf('timeZone')`
 * matches.
 *
 * It refuses what `Intl` also accepts but is not an IANA name as written: ICU's
 * bare abbreviations (`PST` — Los Angeles with DST; `IST` — India, though a user
 * may mean Ireland or Israel; `EST`), ICU's `SystemV/*` ids, case variants
 * (`utc`, `europe/london`, `EUROPE/LONDON` — stored verbatim, and `utc` would
 * read as "local" to `TimeZoneSetting.modeOf`) and bare offsets (`+05:00`).
 * A mixed-case variant inside a segment (`Europe/LonDON`) still passes: only a
 * full name list could refuse it, and `Intl` formats it like `Europe/London`.
 */
export const IANA_TIME_ZONE_NAME =
    /^(?:Etc\/(?:GMT(?:[+-]?\d{1,2})?|UTC|UCT|Universal|Zulu|Greenwich)|[A-Z][a-z]+(?:\/[A-Z][a-z][A-Za-z0-9_+-]*){1,2})$/;

const MESSAGE = 'timezone must be a valid IANA timezone identifier';

/**
 * The runtime's canonical zone names, plus `UTC` / `GMT`, which V8 leaves out of
 * the list although every runtime formats with them. Computed once.
 */
const SUPPORTED_TIME_ZONES: ReadonlySet<string> = new Set([
    ...(Intl as typeof Intl & { supportedValuesOf(key: string): string[] }).supportedValuesOf(
        'timeZone',
    ),
    'UTC',
    'GMT',
]);

/**
 * True for an IANA time zone name the runtime can format in:
 *  - one of the runtime's canonical names (or `UTC` / `GMT`), exactly as listed; or
 *  - an `Area/Location` name ({@link IANA_TIME_ZONE_NAME}) that `Intl.DateTimeFormat`
 *    accepts (class-validator's `isTimeZone`).
 *
 * The second arm is why this is not a plain allow-list: `supportedValuesOf` holds
 * ONE spelling per zone, and which one depends on the runtime's ICU. Node 24 lists
 * `Asia/Calcutta` and `Europe/Kiev` but not `Asia/Kolkata` / `Europe/Kyiv` /
 * `Asia/Yangon` / `Etc/UTC`, while browsers report the current names — so with the
 * exact-match list "Local time" failed with a 400 for users in India, Ukraine,
 * Myanmar, Vietnam, Nepal…
 */
export function isIanaTimeZone(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (SUPPORTED_TIME_ZONES.has(value)) return true;
    return IANA_TIME_ZONE_NAME.test(value) && isTimeZone(value);
}

/**
 * Class-validator decorator for {@link isIanaTimeZone}: an IANA time zone name
 * the runtime can actually format in, so no `RangeError` from
 * `Intl.DateTimeFormat` downstream.
 */
export function IsIanaTimeZone(validationOptions?: ValidationOptions): PropertyDecorator {
    return ValidateBy(
        {
            name: 'isIanaTimeZone',
            validator: {
                validate: (value: unknown) => isIanaTimeZone(value),
                defaultMessage: () => MESSAGE,
            },
        },
        validationOptions,
    );
}
