import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Review of #3164 — the Tasks API files a Task only on a Work the caller OWNS, so on a Work
 * shared with them the section's "Add existing" and "New task" could only end in a 400: the
 * Work page passes `canFileTasks={false}` and the section shows neither.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('./AddExistingTaskButton', () => ({
    AddExistingTaskButton: () => <button type="button">add-existing</button>,
}));
vi.mock('./TasksList', () => ({
    TasksList: () => <div data-testid="tasks-list" />,
}));
vi.mock('@/components/works/detail/WorkRunsSummaryBadges', () => ({
    WorkRunsSummaryBadges: () => null,
}));

import { TasksScopedSection } from './TasksScopedSection';

describe('TasksScopedSection — canFileTasks', () => {
    it('offers "Add existing" and "New task" by default', () => {
        render(<TasksScopedSection tasks={[]} scopeLabel="Work" scopeId="w1" />);
        expect(screen.getByText('add-existing')).toBeTruthy();
        expect(screen.getByText('newTask').closest('a')).toHaveAttribute(
            'href',
            expect.stringContaining('workId=w1'),
        );
    });

    it('offers neither when the viewer may not file Tasks on the scope, but keeps the list', () => {
        render(
            <TasksScopedSection tasks={[]} scopeLabel="Work" scopeId="w1" canFileTasks={false} />,
        );
        expect(screen.queryByText('add-existing')).toBeNull();
        expect(screen.queryByText('newTask')).toBeNull();
        expect(screen.getByTestId('tasks-list')).toBeTruthy();
    });
});
