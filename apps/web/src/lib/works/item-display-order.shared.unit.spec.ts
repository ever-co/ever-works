import { describe, expect, it } from 'vitest';
import { parseItemDisplayOrder } from './item-display-order.shared';

describe('parseItemDisplayOrder — UpdateItemDto.order is @IsInt() @Min(0)', () => {
    it('reads an empty field as "leave the order alone"', () => {
        expect(parseItemDisplayOrder('')).toEqual({ ok: true, value: undefined });
        expect(parseItemDisplayOrder('   ')).toEqual({ ok: true, value: undefined });
    });

    it.each([
        ['0', 0],
        ['7', 7],
        [' 12 ', 12],
    ])('accepts %j', (raw, value) => {
        expect(parseItemDisplayOrder(raw)).toEqual({ ok: true, value });
    });

    it.each(['-1', '1.5', '-0.5', 'abc', 'Infinity'])('refuses %j', (raw) => {
        expect(parseItemDisplayOrder(raw)).toEqual({ ok: false });
    });
});
