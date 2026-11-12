/**
 * An item's display order as the API takes it. `UpdateItemDto.order`
 * (`packages/agent/src/items-generator/dto/update-item.dto.ts`) is
 * `@IsInt() @Min(0)`, so `-1` or `1.5` used to reach the API and come back as
 * a raw 400 ("order must not be less than 0"). The Edit-display dialog checks
 * the same rule first and says why.
 *
 * `value: undefined` = the field is empty: leave the item's order as it is.
 */
export type ItemDisplayOrderInput = { ok: true; value: number | undefined } | { ok: false };

/** Read the dialog's text field: empty, or a whole number of 0 or more. */
export function parseItemDisplayOrder(raw: string): ItemDisplayOrderInput {
    const trimmed = raw.trim();
    if (trimmed === '') {
        return { ok: true, value: undefined };
    }
    const value = Number(trimmed);
    // `Number.isInteger` is false for NaN, Infinity and fractions.
    if (!Number.isInteger(value) || value < 0) {
        return { ok: false };
    }
    return { ok: true, value };
}
