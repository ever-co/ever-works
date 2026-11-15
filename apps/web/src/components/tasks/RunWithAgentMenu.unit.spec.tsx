import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render as renderPlain, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import { RunWithAgentMenu } from './RunWithAgentMenu';
import { isRunRefused, runRefusalText } from './run-refusal';

/** Rendered through the REAL English catalogue, so a missing key shows as a raw key path and fails. */
function render(ui: ReactElement, catalogue: object = messages) {
    return renderPlain(
        <NextIntlClientProvider locale="en" messages={catalogue as typeof messages}>
            {ui}
        </NextIntlClientProvider>,
    );
}

/**
 * Board dispatch (kanban M3) — the Run affordance and its agent picker.
 *
 * The load-bearing behaviour is that the component branches on the
 * action's stable `code`, NEVER on a message: production redacts thrown
 * Server-Action messages, so a message-driven UI silently does nothing
 * once deployed.
 */

const runTaskAction = vi.fn();
const listTaskRunCandidatesAction = vi.fn();

vi.mock('@/app/actions/tasks', () => ({
    runTaskAction: (...args: unknown[]) => runTaskAction(...args),
    listTaskRunCandidatesAction: (...args: unknown[]) => listTaskRunCandidatesAction(...args),
}));

describe('RunWithAgentMenu', () => {
    beforeEach(() => {
        runTaskAction.mockReset();
        listTaskRunCandidatesAction.mockReset();
        listTaskRunCandidatesAction.mockResolvedValue([]);
    });

    it('runs with the server-resolved Agent when there is no ambiguity', async () => {
        runTaskAction.mockResolvedValue({
            ok: true,
            run: { taskId: 't1', agentId: 'a1', runId: 'r1', dispatched: true, parked: false },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        await waitFor(() => expect(runTaskAction).toHaveBeenCalledWith('t1', null));
        expect(await screen.findByText('Run started.')).toBeTruthy();
        expect(screen.queryByTestId('task-run-agent-picker')).toBeNull();
    });

    it('opens the picker with the server-supplied candidates on RUN_AGENT_AMBIGUOUS', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_AGENT_AMBIGUOUS',
            message: 'pick one',
            candidates: [
                { id: 'a1', name: 'Builder', source: 'assignee' },
                { id: 'a2', name: 'Reviewer', source: 'work-default' },
            ],
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        const picker = await screen.findByTestId('task-run-agent-picker');
        expect(picker).toBeTruthy();
        expect(screen.getAllByTestId('task-run-agent-option')).toHaveLength(2);
        // The candidates came off the failure body — no second round trip.
        expect(listTaskRunCandidatesAction).not.toHaveBeenCalled();
    });

    it('re-dispatches with the chosen Agent when the user picks one', async () => {
        runTaskAction.mockResolvedValueOnce({
            ok: false,
            code: 'RUN_AGENT_AMBIGUOUS',
            message: 'pick one',
            candidates: [
                { id: 'a1', name: 'Builder', source: 'assignee' },
                { id: 'a2', name: 'Reviewer', source: 'work-default' },
            ],
        });
        runTaskAction.mockResolvedValueOnce({
            ok: true,
            run: { taskId: 't1', agentId: 'a2', runId: 'r2', dispatched: true, parked: false },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        await screen.findByTestId('task-run-agent-picker');
        fireEvent.click(screen.getAllByTestId('task-run-agent-option')[1]);
        await waitFor(() => expect(runTaskAction).toHaveBeenLastCalledWith('t1', 'a2'));
    });

    it('explains RUN_NO_AGENT instead of failing silently', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_NO_AGENT',
            message: 'no agent',
            candidates: [],
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(/No Agent is assigned to this Task/i)).toBeTruthy();
    });

    it('points at the live run on RUN_ALREADY_IN_FLIGHT rather than racing a second one', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_ALREADY_IN_FLIGHT',
            message: 'already running',
            runId: 'r-live',
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(/already in flight/i)).toBeTruthy();
        expect(screen.queryByTestId('task-run-agent-picker')).toBeNull();
    });

    it('reports a parked run as queued-for-capacity, not as a failure', async () => {
        runTaskAction.mockResolvedValue({
            ok: true,
            run: {
                taskId: 't1',
                agentId: 'a1',
                runId: 'r1',
                dispatched: false,
                parked: true,
                queuedReason: 'concurrency-limit',
            },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(/waiting for capacity/i)).toBeTruthy();
    });

    it('loads candidates lazily when the board opens the picker itself (the drag fallback)', async () => {
        listTaskRunCandidatesAction.mockResolvedValue([
            { id: 'a1', name: 'Builder', source: 'work-default' },
        ]);
        render(<RunWithAgentMenu taskId="t1" open onOpenChange={() => undefined} />);
        await waitFor(() => expect(listTaskRunCandidatesAction).toHaveBeenCalledWith('t1'));
        expect(await screen.findByText('Builder')).toBeTruthy();
    });

    it('surfaces an unknown failure code with its message instead of swallowing it', async () => {
        runTaskAction.mockResolvedValue({
            ok: false,
            code: 'RUN_FAILED',
            message: 'job runtime not configured',
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText('job runtime not configured')).toBeTruthy();
    });

    // APW-08 T12 (ACC-08-08) — a dispatch the platform refused is answered 2xx with
    // `dispatched: false` and the reason; it must never read as "Run started".
    it('a refused run says why, as an alert, and never "Run started"; onRunStarted is not called', async () => {
        const s15 =
            "This app's code can only run on one of your machines or in an isolated sandbox, and none is set up.";
        runTaskAction.mockResolvedValue({
            ok: true,
            run: {
                taskId: 't1',
                agentId: 'a1',
                runId: null,
                dispatched: false,
                parked: false,
                error: `noIsolatedRuntime: ${s15}`,
            },
        });
        const onRunStarted = vi.fn();
        render(<RunWithAgentMenu taskId="t1" onRunStarted={onRunStarted} />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        await waitFor(() => expect(screen.getByTestId('task-run-message').textContent).toBe(s15));
        const message = screen.getByTestId('task-run-message');
        expect(message.getAttribute('role')).toBe('alert');
        expect(message.getAttribute('data-tone')).toBe('error');
        expect(screen.queryByText('Run started.')).toBeNull();
        expect(onRunStarted).not.toHaveBeenCalled();
    });
});

describe('RunWithAgentMenu — every user-facing string comes from the catalogue', () => {
    const copy = messages.dashboard.tasksPage.runMenu;

    beforeEach(() => {
        runTaskAction.mockReset();
        listTaskRunCandidatesAction.mockReset();
        listTaskRunCandidatesAction.mockResolvedValue([]);
    });

    it('labels the button and the picker from the catalogue (accessible names, not literals)', async () => {
        listTaskRunCandidatesAction.mockResolvedValue([
            { id: 'a1', name: 'Builder', source: 'assignee' },
            { id: 'a2', name: 'Reviewer', source: 'task' },
            { id: 'a3', name: 'Planner', source: 'work-default' },
        ]);
        render(<RunWithAgentMenu taskId="t1" open onOpenChange={() => undefined} />);
        const button = screen.getByTestId('task-run-button');
        expect(button.getAttribute('aria-label')).toBe(copy.runLabel);
        expect(button.getAttribute('title')).toBe(copy.runTitle);
        expect(button.textContent).toBe(copy.run);
        const picker = await screen.findByTestId('task-run-agent-picker');
        expect(picker.getAttribute('aria-label')).toBe(copy.pickerLabel);
        expect(screen.getByText(copy.runWith)).toBeTruthy();
        const options = await screen.findAllByTestId('task-run-agent-option');
        expect(options.map((option) => option.textContent)).toEqual([
            `Builder${copy.sourceAssignee}`,
            `Reviewer${copy.sourceTask}`,
            `Planner${copy.sourceWorkDefault}`,
        ]);
    });

    it('says so from the catalogue when no Agent is available', async () => {
        render(<RunWithAgentMenu taskId="t1" open onOpenChange={() => undefined} />);
        expect(await screen.findByText(copy.noAgentAvailable)).toBeTruthy();
    });

    it('translates the queued message and keeps the server reason verbatim', async () => {
        runTaskAction.mockResolvedValue({
            ok: true,
            run: {
                taskId: 't1',
                agentId: 'a1',
                runId: 'r1',
                dispatched: false,
                parked: true,
                queuedReason: 'concurrency-limit',
            },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(
            await screen.findByText(copy.queued.replace('{reason}', 'concurrency-limit')),
        ).toBeTruthy();
    });

    it('uses the translated fallbacks for a refusal with no sentence and for a failure with no message', async () => {
        runTaskAction.mockResolvedValueOnce({
            ok: true,
            run: { taskId: 't1', agentId: 'a1', runId: null, dispatched: false, parked: false },
        });
        render(<RunWithAgentMenu taskId="t1" />);
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(copy.refusedFallback)).toBeTruthy();

        runTaskAction.mockResolvedValueOnce({ ok: false, code: 'RUN_FAILED', message: '' });
        fireEvent.click(screen.getByTestId('task-run-button'));
        expect(await screen.findByText(copy.runFailed)).toBeTruthy();
    });

    it('renders a translated catalogue, not the English literals', async () => {
        const translated = {
            dashboard: {
                tasksPage: {
                    runMenu: {
                        ...copy,
                        run: 'Ejecutar',
                        runLabel: 'Ejecutar esta tarea',
                        runStarted: 'Ejecución iniciada.',
                    },
                },
            },
        };
        runTaskAction.mockResolvedValue({
            ok: true,
            run: { taskId: 't1', agentId: 'a1', runId: 'r1', dispatched: true, parked: false },
        });
        render(<RunWithAgentMenu taskId="t1" />, translated);
        const button = screen.getByTestId('task-run-button');
        expect(button.textContent).toBe('Ejecutar');
        expect(button.getAttribute('aria-label')).toBe('Ejecutar esta tarea');
        fireEvent.click(button);
        expect(await screen.findByText('Ejecución iniciada.')).toBeTruthy();
        expect(screen.queryByText('Run started.')).toBeNull();
    });
});

describe('run-refusal (APW-08 T12)', () => {
    it('a run that neither started nor parked is refused', () => {
        expect(isRunRefused({ dispatched: false, parked: false })).toBe(true);
        expect(isRunRefused({ dispatched: true, parked: false })).toBe(false);
        expect(isRunRefused({ dispatched: false, parked: true })).toBe(false);
    });

    it('shows the refusal sentence without its stable code, or a plain fallback', () => {
        expect(runRefusalText('noIsolatedRuntime: None is set up.')).toBe('None is set up.');
        expect(runRefusalText('agent-not-found')).toBe('The run did not start.');
        expect(runRefusalText(undefined)).toBe('The run did not start.');
        // A caller with a catalogue passes its own words; a real sentence still wins over it.
        expect(runRefusalText(undefined, 'No se inició.')).toBe('No se inició.');
        expect(runRefusalText('noIsolatedRuntime: None is set up.', 'No se inició.')).toBe(
            'None is set up.',
        );
    });
});
