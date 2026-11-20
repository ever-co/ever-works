import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_PORT_WATCH_MAX, type FleetPortsListResponse } from '@ever-works/contracts';

vi.mock('./ports.shared', () => ({ portsClient: { list: vi.fn() } }));

import { portsClient } from './ports.shared';
import { usePortsLive } from './use-ports-live';

const list = vi.mocked(portsClient.list);

describe('usePortsLive watch list', () => {
    beforeEach(() => {
        list.mockResolvedValue({
            ok: true,
            data: { ports: [] } as unknown as FleetPortsListResponse,
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('adds ports in order, once each, and reads with the new list', async () => {
        const { result } = renderHook(() => usePortsLive('node-1'));

        act(() => {
            result.current.addWatch(3000);
            result.current.addWatch(5173);
            result.current.addWatch(3000);
        });

        expect(result.current.watch).toEqual([3000, 5173]);
        await waitFor(() => expect(list).toHaveBeenLastCalledWith('node-1', [3000, 5173]));
    });

    it('removes a watched port and ignores one that is not watched', () => {
        const { result } = renderHook(() => usePortsLive('node-1'));

        act(() => {
            result.current.addWatch(3000);
            result.current.addWatch(5173);
        });
        act(() => {
            result.current.removeWatch(3000);
            result.current.removeWatch(9999);
        });

        expect(result.current.watch).toEqual([5173]);
    });

    it(`stops at ${FLEET_PORT_WATCH_MAX} watched ports`, () => {
        const { result } = renderHook(() => usePortsLive('node-1'));

        act(() => {
            for (let port = 1; port <= FLEET_PORT_WATCH_MAX + 2; port++) {
                result.current.addWatch(port);
            }
        });

        expect(result.current.watch).toHaveLength(FLEET_PORT_WATCH_MAX);
        expect(result.current.watch.at(-1)).toBe(FLEET_PORT_WATCH_MAX);
    });
});
