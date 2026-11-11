import React from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}(${JSON.stringify(vars)})` : key,
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
}));

// `Button` pulls in the locale-aware Link, which resolves `next/navigation` through next-intl —
// unavailable under jsdom.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const setTaskRecurringAction = vi.fn();
const clearTaskRecurringAction = vi.fn();
vi.mock('@/app/actions/tasks', () => ({
    setTaskRecurringAction: (...args: unknown[]) => setTaskRecurringAction(...args),
    clearTaskRecurringAction: (...args: unknown[]) => clearTaskRecurringAction(...args),
}));

import { MaxOpenInstancesEditor, MaxOpenInstancesField } from './TaskRecurringOverlapControl';
import { TaskRecurringSection } from './TaskRecurringSection';
import { formatMaxOpenInstances, parseMaxOpenInstances } from './recurring-overlap';
import type { Task } from '@/lib/api/tasks';

/**
 * Recurring Tasks overlap limit — the "At most N open at a time" control: blank is "no limit",
 * a whole number 1..100 is the limit, anything else is refused before it reaches the API; on a
 * Task that is already recurring it saves the limit ALONE (the cadence and next fire stay).
 */
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        slug: 'T-1',
        title: 'Quality loop',
        status: 'todo',
        priority: 'p3',
        isRecurring: true,
        recurrenceRule: null,
        recurrenceCron: '0 9 * * *',
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: '2026-11-12T09:00:00.000Z',
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 4,
        recurrenceMaxOpenInstances: 3,
        recurrenceSkippedAt: null,
        parentRecurringTaskId: null,
        ...overrides,
    } as Task;
}

describe('parseMaxOpenInstances', () => {
    it('blank is no limit; 1..100 is the limit; everything else is invalid', () => {
        expect(parseMaxOpenInstances('')).toEqual({ ok: true, value: null });
        expect(parseMaxOpenInstances('   ')).toEqual({ ok: true, value: null });
        expect(parseMaxOpenInstances('1')).toEqual({ ok: true, value: 1 });
        expect(parseMaxOpenInstances(' 3 ')).toEqual({ ok: true, value: 3 });
        expect(parseMaxOpenInstances('100')).toEqual({ ok: true, value: 100 });
        for (const text of ['0', '101', '-1', '2.5', '1e2', 'abc', '3x']) {
            expect(parseMaxOpenInstances(text)).toEqual({ ok: false });
        }
        expect(formatMaxOpenInstances(null)).toBe('');
        expect(formatMaxOpenInstances(undefined)).toBe('');
        expect(formatMaxOpenInstances(4)).toBe('4');
    });
});

describe('MaxOpenInstancesField', () => {
    it('shows the hint, and the bound when the text is invalid', () => {
        const onChange = vi.fn();
        const { rerender } = render(<MaxOpenInstancesField id="f" value="" onChange={onChange} />);
        expect(screen.getByLabelText('maxOpenInstances')).toBeTruthy();
        expect(screen.getByText('maxOpenInstancesHint')).toBeTruthy();
        fireEvent.change(screen.getByTestId('task-recurring-max-open'), { target: { value: '2' } });
        expect(onChange).toHaveBeenCalledWith('2');

        rerender(<MaxOpenInstancesField id="f" value="0" onChange={onChange} />);
        expect(screen.getByText('maxOpenInstancesInvalid({"max":100})')).toBeTruthy();
        expect(screen.getByTestId('task-recurring-max-open').getAttribute('aria-invalid')).toBe(
            'true',
        );
    });
});

describe('MaxOpenInstancesEditor (a Task that is already recurring)', () => {
    beforeEach(() => {
        setTaskRecurringAction.mockReset();
        setTaskRecurringAction.mockResolvedValue(makeTask());
        refresh.mockReset();
    });

    it('starts from the stored limit and offers Save only after a change', () => {
        render(<MaxOpenInstancesEditor task={makeTask()} />);
        expect((screen.getByTestId('task-recurring-max-open') as HTMLInputElement).value).toBe('3');
        expect(screen.queryByTestId('task-recurring-max-open-save')).toBeNull();
    });

    it('saves the new limit alone, then refreshes', async () => {
        render(<MaxOpenInstancesEditor task={makeTask()} />);
        fireEvent.change(screen.getByTestId('task-recurring-max-open'), { target: { value: '5' } });
        fireEvent.click(screen.getByTestId('task-recurring-max-open-save'));
        await waitFor(() =>
            expect(setTaskRecurringAction).toHaveBeenCalledWith('task-1', {
                recurrenceMaxOpenInstances: 5,
            }),
        );
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('blank clears the limit (null)', async () => {
        render(<MaxOpenInstancesEditor task={makeTask()} />);
        fireEvent.change(screen.getByTestId('task-recurring-max-open'), { target: { value: '' } });
        fireEvent.click(screen.getByTestId('task-recurring-max-open-save'));
        await waitFor(() =>
            expect(setTaskRecurringAction).toHaveBeenCalledWith('task-1', {
                recurrenceMaxOpenInstances: null,
            }),
        );
    });

    it('an invalid limit cannot be saved', () => {
        render(<MaxOpenInstancesEditor task={makeTask({ recurrenceMaxOpenInstances: null })} />);
        fireEvent.change(screen.getByTestId('task-recurring-max-open'), { target: { value: '0' } });
        const save = screen.getByTestId('task-recurring-max-open-save');
        expect(save.hasAttribute('disabled')).toBe(true);
        fireEvent.click(save);
        expect(setTaskRecurringAction).not.toHaveBeenCalled();
    });

    it('shows the server refusal', async () => {
        setTaskRecurringAction.mockRejectedValueOnce(new Error('Refused by the server'));
        render(<MaxOpenInstancesEditor task={makeTask()} />);
        fireEvent.change(screen.getByTestId('task-recurring-max-open'), { target: { value: '2' } });
        fireEvent.click(screen.getByTestId('task-recurring-max-open-save'));
        await waitFor(() =>
            expect(screen.getByRole('alert').textContent).toBe('Refused by the server'),
        );
    });
});

describe('TaskRecurringSection with the overlap limit', () => {
    beforeEach(() => {
        setTaskRecurringAction.mockReset();
        setTaskRecurringAction.mockResolvedValue(makeTask());
    });

    it('an active template shows the limit editor and its last skipped slot', () => {
        render(
            <TaskRecurringSection
                task={makeTask({ recurrenceSkippedAt: '2026-11-11T09:00:05.000Z' })}
            />,
        );
        expect(screen.getByTestId('task-recurring-max-open-editor')).toBeTruthy();
        expect(screen.getByText('lastSkipped')).toBeTruthy();
        expect(screen.getByTestId('task-recurring-last-skipped').textContent).toBe(
            new Date('2026-11-11T09:00:05.000Z').toLocaleString(),
        );
    });

    it('no skip, no "last skipped" row', () => {
        render(<TaskRecurringSection task={makeTask()} />);
        expect(screen.queryByTestId('task-recurring-last-skipped')).toBeNull();
    });

    it('"Make recurring" sends the limit with the cadence when set, and omits it when blank', async () => {
        const plain = makeTask({ isRecurring: false, recurrenceMaxOpenInstances: null });
        const { unmount } = render(<TaskRecurringSection task={plain} />);
        fireEvent.click(screen.getByTestId('task-recurring-promote'));
        fireEvent.change(screen.getByTestId('task-recurring-max-open'), { target: { value: '2' } });
        fireEvent.click(screen.getByTestId('task-recurring-save'));
        await waitFor(() => expect(setTaskRecurringAction).toHaveBeenCalledTimes(1));
        expect(setTaskRecurringAction.mock.calls[0][1]).toMatchObject({
            recurrenceRule: expect.stringContaining('FREQ=WEEKLY'),
            recurrenceMaxOpenInstances: 2,
        });
        unmount();

        render(<TaskRecurringSection task={plain} />);
        fireEvent.click(screen.getByTestId('task-recurring-promote'));
        fireEvent.click(screen.getByTestId('task-recurring-save'));
        await waitFor(() => expect(setTaskRecurringAction).toHaveBeenCalledTimes(2));
        expect(setTaskRecurringAction.mock.calls[1][1]).not.toHaveProperty(
            'recurrenceMaxOpenInstances',
        );
    });

    it('an invalid limit blocks "Make recurring"', () => {
        render(<TaskRecurringSection task={makeTask({ isRecurring: false })} />);
        fireEvent.click(screen.getByTestId('task-recurring-promote'));
        fireEvent.change(screen.getByTestId('task-recurring-max-open'), {
            target: { value: '101' },
        });
        expect(screen.getByTestId('task-recurring-save').hasAttribute('disabled')).toBe(true);
    });
});

describe('overlap limit messages', () => {
    const MESSAGES_DIR = path.join(__dirname, '../../../messages');
    const files = readdirSync(MESSAGES_DIR).filter((file) => file.endsWith('.json'));
    type Catalogue = Record<string, any>;
    const load = (file: string): Catalogue =>
        JSON.parse(readFileSync(path.join(MESSAGES_DIR, file), 'utf8')) as Catalogue;

    /** `t('<key>'` calls in the control's source, under `dashboard.tasksPage.recurring`. */
    function controlKeys(): string[] {
        const source = readFileSync(
            path.join(__dirname, 'TaskRecurringOverlapControl.tsx'),
            'utf8',
        );
        return [...new Set([...source.matchAll(/\bt\('([A-Za-z0-9]+)'/g)].map((m) => m[1]))].sort();
    }

    it('every key the control, the Schedules row and the badge ask for is in every locale', () => {
        expect(files).toHaveLength(21);
        const recurringKeys = [...controlKeys(), 'lastSkipped'];
        expect(recurringKeys).toEqual(
            expect.arrayContaining([
                'maxOpenInstances',
                'maxOpenInstancesHint',
                'maxOpenInstancesInvalid',
                'save',
                'saveError',
            ]),
        );
        const gaps: string[] = [];
        for (const file of files) {
            const dashboard = load(file).dashboard ?? {};
            for (const key of recurringKeys) {
                if (typeof dashboard.tasksPage?.recurring?.[key] !== 'string') {
                    gaps.push(`${file}: tasksPage.recurring.${key}`);
                }
            }
            for (const key of ['lastSkipped', 'lastSkippedHint']) {
                if (typeof dashboard.schedules?.[key] !== 'string')
                    gaps.push(`${file}: schedules.${key}`);
            }
            if (typeof dashboard.schedules?.runNow?.tooManyOpenConfirm !== 'string') {
                gaps.push(`${file}: schedules.runNow.tooManyOpenConfirm`);
            }
            if (typeof dashboard.activity?.filters?.types?.scheduleSkipped !== 'string') {
                gaps.push(`${file}: activity.filters.types.scheduleSkipped`);
            }
        }
        expect(gaps).toEqual([]);
    });

    it('keeps the ICU arguments in every translation', () => {
        for (const file of files) {
            const dashboard = load(file).dashboard;
            expect(dashboard.tasksPage.recurring.maxOpenInstancesInvalid).toContain('{max}');
            expect(dashboard.schedules.runNow.tooManyOpenConfirm).toContain('{name}');
        }
    });
});
