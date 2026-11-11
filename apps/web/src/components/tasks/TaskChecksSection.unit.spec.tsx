import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';

const { editor, updateTaskAction } = vi.hoisted(() => ({
    // What the stubbed editor hands the section when its "fill" button is clicked.
    editor: { rows: [] as TaskAcceptanceCheck[] },
    updateTaskAction: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('@/app/actions/tasks', () => ({ updateTaskAction }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
    // `@/components/ui/button` re-wraps `Link` from the same module.
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('./GateChip', () => ({ GateChip: () => null }));
vi.mock('./ChecksEditor', () => ({
    ChecksEditor: ({ onChange }: { onChange: (rows: TaskAcceptanceCheck[]) => void }) => (
        <button type="button" data-testid="editor-fill" onClick={() => onChange(editor.rows)}>
            fill
        </button>
    ),
}));

import { TaskChecksSection } from './TaskChecksSection';

/**
 * APW-08 T51 (FR-61, S36) — a check whose tool is missing on the Fleet node reads as that, not as
 * a plain "Error": the gate row says "a tool this check needs is missing on this machine".
 */
describe('TaskChecksSection — the missing-tool row (APW-08 T51)', () => {
    const check = {
        id: 'repo/check-1',
        name: 'type-check',
        kind: 'command',
        command: 'cargo test',
    };

    function renderWith(result: Record<string, unknown>) {
        return render(
            <TaskChecksSection
                task={{ id: 't1', acceptanceChecks: [check] } as never}
                initialGateRun={
                    {
                        resolvedChecks: [check],
                        checkResults: [{ id: 'repo/check-1', durationMs: 5, ...result }],
                    } as never
                }
            />,
        );
    }

    it('an `error` with reason missingTool reads as a missing tool', () => {
        renderWith({ status: 'error', exitCode: 127, reason: 'missingTool' });
        const label = screen.getByText('result.missingTool');
        expect(screen.queryByText('result.error')).toBeNull();
        // A sentence, so it may wrap on a narrow view (CodeRabbit on #3045); a word never does.
        expect(label.className).toContain('min-w-0');
        expect(label.className).not.toContain('shrink-0');
    });

    it('any other `error`, and a red, keep their own labels', () => {
        const { unmount } = renderWith({ status: 'error', exitCode: null });
        expect(screen.getByText('result.error')).toBeTruthy();
        expect(screen.queryByText('result.missingTool')).toBeNull();
        unmount();
        renderWith({ status: 'red', exitCode: 1 });
        expect(screen.getByText('result.red')).toBeTruthy();
    });
});

// Review of #3164 (finding 4) — more checks than the API takes (`ArrayMaxSize(20)`) or a command
// over its `MaxLength(2000)` is named before the save, instead of ending in the generic 400.
describe('TaskChecksSection — limits the save cannot fix', () => {
    const row = (i: number, overrides: Partial<TaskAcceptanceCheck> = {}): TaskAcceptanceCheck => ({
        id: `check-${i}`,
        name: `Check ${i}`,
        kind: 'test',
        command: 'pnpm test',
        required: true,
        ...overrides,
    });

    function editAndSave(rows: TaskAcceptanceCheck[]) {
        editor.rows = rows;
        render(
            <TaskChecksSection
                task={{ id: 't1', acceptanceChecks: [] } as never}
                initialGateRun={null}
            />,
        );
        fireEvent.click(screen.getByTestId('task-checks-edit'));
        fireEvent.click(screen.getByTestId('editor-fill'));
        fireEvent.click(screen.getByTestId('task-checks-save'));
    }

    it('refuses a 21st check with the reason, and sends nothing', () => {
        updateTaskAction.mockClear();
        editAndSave(Array.from({ length: 21 }, (_, i) => row(i)));
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toMatch(/^tooManyChecks:/);
        expect(alert.textContent).toContain('"count":21');
        expect(alert.textContent).toContain('"max":20');
        expect(updateTaskAction).not.toHaveBeenCalled();
    });

    it('names the check whose command is over 2000 characters, and sends nothing', () => {
        updateTaskAction.mockClear();
        editAndSave([row(1), row(2, { name: 'E2E', command: 'x'.repeat(2001) })]);
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toMatch(/^commandTooLong:/);
        expect(alert.textContent).toContain('"name":"E2E"');
        expect(alert.textContent).toContain('"length":2001');
        expect(updateTaskAction).not.toHaveBeenCalled();
    });

    it('saves 20 checks with commands at the limit', async () => {
        updateTaskAction.mockReset();
        updateTaskAction.mockImplementation(
            async (_id: string, input: Record<string, unknown>) => ({
                id: 't1',
                acceptanceChecks: input.acceptanceChecks,
                maxGateAttempts: null,
            }),
        );
        const rows = Array.from({ length: 20 }, (_, i) => row(i, { command: 'y'.repeat(2000) }));
        editAndSave(rows);
        await waitFor(() => expect(updateTaskAction).toHaveBeenCalledTimes(1));
        expect(updateTaskAction.mock.calls[0]![1].acceptanceChecks).toHaveLength(20);
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
