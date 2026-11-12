import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';

/**
 * Review of #3164 — the New Task form:
 *  - its Work picker offers only Works the caller OWNS (the Tasks API files a Task on no other);
 *  - more acceptance checks than the API takes (`ArrayMaxSize(20)`) or a command over its
 *    `MaxLength(2000)` is named before the create, instead of ending in the generic 400.
 */

const { editor, workSelectProps, push } = vi.hoisted(() => ({
    // What the stubbed checks editor hands the form when its "fill" button is clicked.
    editor: { rows: [] as TaskAcceptanceCheck[] },
    workSelectProps: vi.fn(),
    push: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push, back: vi.fn(), refresh: vi.fn() }),
    // `@/components/ui/button` re-wraps `Link` from the same module.
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/lib/api/agent-templates', () => ({ listAstTemplates: vi.fn(async () => []) }));
vi.mock('@/app/actions/task-templates', () => ({
    instantiateTaskTemplateAction: vi.fn(),
    listTaskTemplatesAction: vi.fn(async () => []),
}));
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        children,
        onValueChange,
        ...rest
    }: {
        value: string;
        children: React.ReactNode;
        onValueChange: (v: string) => void;
    } & Record<string, unknown>) => (
        <select
            data-testid={rest['data-testid'] as string | undefined}
            value={value}
            onChange={(e) => onValueChange(e.currentTarget.value)}
        >
            {children}
        </select>
    ),
}));
vi.mock('./WorkSelect', () => ({
    WorkSelect: (props: { testId?: string; ownedOnly?: boolean }) => {
        workSelectProps(props);
        return <div data-testid={props.testId} />;
    },
}));
vi.mock('./TaskExtraReposPicker', () => ({ TaskExtraReposPicker: () => null }));
vi.mock('./ChecksEditor', () => ({
    ChecksEditor: ({ onChange }: { onChange: (rows: TaskAcceptanceCheck[]) => void }) => (
        <button type="button" data-testid="editor-fill" onClick={() => onChange(editor.rows)}>
            fill
        </button>
    ),
}));

import { NewTaskForm } from './NewTaskForm';

const row = (i: number, overrides: Partial<TaskAcceptanceCheck> = {}): TaskAcceptanceCheck => ({
    id: `check-${i}`,
    name: `Check ${i}`,
    kind: 'test',
    command: 'pnpm test',
    required: true,
    ...overrides,
});

const createTask = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    createTask.mockResolvedValue({ id: 't-new' });
});

function createWithChecks(rows: TaskAcceptanceCheck[]) {
    editor.rows = rows;
    render(<NewTaskForm createTask={createTask} />);
    fireEvent.change(screen.getByPlaceholderText('namePlaceholder'), {
        target: { value: 'Ship the release' },
    });
    fireEvent.click(screen.getByTestId('new-task-checks-toggle'));
    fireEvent.click(screen.getByTestId('editor-fill'));
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
}

describe('NewTaskForm — the Work picker', () => {
    it('offers only the Works the caller owns', () => {
        render(<NewTaskForm createTask={createTask} />);
        expect(workSelectProps).toHaveBeenLastCalledWith(
            expect.objectContaining({ testId: 'new-task-work', ownedOnly: true }),
        );
    });
});

describe('NewTaskForm — acceptance-check limits', () => {
    it('refuses a 21st check with the reason, and creates nothing', async () => {
        createWithChecks(Array.from({ length: 21 }, (_, i) => row(i)));
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/^tooManyChecks:/);
        expect(alert.textContent).toContain('"count":21');
        expect(createTask).not.toHaveBeenCalled();
    });

    it('names the check whose command is over 2000 characters, and creates nothing', async () => {
        createWithChecks([row(1), row(2, { name: 'E2E', command: 'x'.repeat(2001) })]);
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/^commandTooLong:/);
        expect(alert.textContent).toContain('"name":"E2E"');
        expect(createTask).not.toHaveBeenCalled();
    });

    it('creates the Task with 20 checks at the limit', async () => {
        createWithChecks(
            Array.from({ length: 20 }, (_, i) => row(i, { command: 'y'.repeat(2000) })),
        );
        await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
        expect(createTask.mock.calls[0]![0].acceptanceChecks).toHaveLength(20);
        expect(push).toHaveBeenCalled();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
