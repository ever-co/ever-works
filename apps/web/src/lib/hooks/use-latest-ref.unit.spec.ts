import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLatestRef } from './use-latest-ref';

describe('useLatestRef', () => {
    it('starts with the first value', () => {
        const { result } = renderHook(() => useLatestRef('first'));

        expect(result.current.current).toBe('first');
    });

    it('holds the value of the latest committed render, in the same ref object', () => {
        const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
            initialProps: { value: 1 },
        });
        const ref = result.current;

        rerender({ value: 2 });

        expect(result.current).toBe(ref);
        expect(ref.current).toBe(2);
    });
});
