import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    classifyServerError,
    useAutosaveStatus,
    type AutosaveFlushArgs,
    type AutosaveFlushResult,
} from './use-autosave-status';

type Save = (args: AutosaveFlushArgs) => Promise<AutosaveFlushResult>;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function renderAutosave(save: Save, debounceMs = 100, initialBody = 'a') {
    return renderHook(
        ({ save: current }: { save: Save }) =>
            useAutosaveStatus({ initialBody, debounceMs, save: current }),
        { initialProps: { save } },
    );
}

describe('useAutosaveStatus', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('saves the latest body once the debounce window passes', async () => {
        const save = vi.fn<Save>().mockResolvedValue({ success: true });
        const { result } = renderAutosave(save);

        act(() => result.current.schedule('ab'));
        act(() => result.current.schedule('abc'));
        expect(result.current.status).toBe('dirty');
        expect(save).not.toHaveBeenCalled();

        await act(() => vi.advanceTimersByTimeAsync(100));

        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith({ candidate: 'abc' });
        expect(result.current.status).toBe('saved');
        expect(result.current.savedAt).not.toBeNull();
    });

    it('does not save a body that is back to the last saved one', async () => {
        const save = vi.fn<Save>().mockResolvedValue({ success: true });
        const { result } = renderAutosave(save);

        act(() => result.current.schedule('a'));
        await act(() => vi.advanceTimersByTimeAsync(100));

        expect(save).not.toHaveBeenCalled();
        expect(result.current.status).toBe('idle');
    });

    it('saves what was typed during an in-flight save once that save lands', async () => {
        const first = deferred<AutosaveFlushResult>();
        const save = vi
            .fn<Save>()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValue({ success: true });
        const { result } = renderAutosave(save);

        act(() => result.current.schedule('ab'));
        await act(() => vi.advanceTimersByTimeAsync(100));
        expect(save).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe('saving');

        // Typing while the first save is out: the debounce fires, but a save
        // is already in flight, so nothing new goes out yet.
        act(() => result.current.schedule('abc'));
        await act(() => vi.advanceTimersByTimeAsync(100));
        expect(save).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe('saving');

        await act(async () => {
            first.resolve({ success: true });
        });
        expect(result.current.status).toBe('saved');

        await act(() => vi.advanceTimersByTimeAsync(100));
        expect(save).toHaveBeenCalledTimes(2);
        expect(save).toHaveBeenLastCalledWith({ candidate: 'abc' });
        expect(result.current.status).toBe('saved');
    });

    it('calls the save function passed on the latest render', async () => {
        const firstSave = vi.fn<Save>().mockResolvedValue({ success: true });
        const secondSave = vi.fn<Save>().mockResolvedValue({ success: true });
        const { result, rerender } = renderAutosave(firstSave);

        act(() => result.current.schedule('ab'));
        rerender({ save: secondSave });
        await act(() => vi.advanceTimersByTimeAsync(100));

        expect(firstSave).not.toHaveBeenCalled();
        expect(secondSave).toHaveBeenCalledWith({ candidate: 'ab' });
    });

    it('saves at once when the debounce window is 0', async () => {
        const save = vi.fn<Save>().mockResolvedValue({ success: true });
        const { result } = renderAutosave(save, 0);

        await act(async () => {
            result.current.schedule('ab');
        });

        expect(save).toHaveBeenCalledWith({ candidate: 'ab' });
        expect(result.current.status).toBe('saved');
    });

    it('reports a refused save with its error kind', async () => {
        const save = vi
            .fn<Save>()
            .mockResolvedValue({ success: false, error: 'HTTP 409 version mismatch' });
        const { result } = renderAutosave(save);

        act(() => result.current.schedule('ab'));
        await act(() => vi.advanceTimersByTimeAsync(100));

        expect(result.current.status).toBe('error');
        expect(result.current.errorKind).toBe('conflict');
    });

    it('drops a pending save on reset', async () => {
        const save = vi.fn<Save>().mockResolvedValue({ success: true });
        const { result } = renderAutosave(save);

        act(() => result.current.schedule('ab'));
        act(() => result.current.reset('other document'));
        await act(() => vi.advanceTimersByTimeAsync(100));

        expect(save).not.toHaveBeenCalled();
        expect(result.current.status).toBe('idle');
    });
});

describe('classifyServerError', () => {
    it('sorts a server message into conflict, locked or generic', () => {
        expect(classifyServerError('HTTP 409')).toBe('conflict');
        expect(classifyServerError('document is locked')).toBe('locked');
        expect(classifyServerError('HTTP 500')).toBe('generic');
        expect(classifyServerError(undefined)).toBe('generic');
    });
});
