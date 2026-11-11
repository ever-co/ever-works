import { IsTimeZone, Matches } from 'class-validator';

/**
 * The shape of an IANA zone name: `UTC`, `Europe/London`,
 * `America/Argentina/Buenos_Aires`, `Etc/GMT+5`. Refuses bare offsets
 * (`+05:00`), which `Intl` would accept but are not zone identifiers.
 */
export const IANA_TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

const MESSAGE = 'timezone must be a valid IANA timezone identifier';

/**
 * A time zone the runtime can actually format in (`Intl.DateTimeFormat`, via
 * class-validator's `IsTimeZone`), written as an IANA zone name.
 *
 * Replaces an exact-match allow-list built from `Intl.supportedValuesOf
 * ('timeZone')`. That list holds ONE spelling per zone and which one depends on
 * the runtime's ICU: Node 24 lists `Asia/Calcutta` and `Europe/Kiev` but not
 * `Asia/Kolkata` / `Europe/Kyiv` / `Asia/Yangon` / `Etc/UTC`, while browsers
 * report the current names. So "Local time" (the browser's zone) failed with a
 * 400 for users in India, Ukraine, Myanmar, Vietnam, Nepal… although `Intl`
 * formats with either spelling — the RangeError the allow-list guarded against
 * cannot happen for a zone `IsTimeZone` accepts.
 */
export function IsIanaTimeZone(): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        Matches(IANA_TIME_ZONE_NAME, { message: MESSAGE })(target, propertyKey);
        IsTimeZone({ message: MESSAGE })(target, propertyKey);
    };
}
