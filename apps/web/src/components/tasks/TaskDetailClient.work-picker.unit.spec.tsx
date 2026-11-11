import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * Review of #3164 — the Task page's Work picker offers only Works the caller OWNS: the Tasks API
 * re-files a Task onto no other Work. Every section around it is stubbed; this spec is about the
 * picker's props only.
 */

const { workSelectProps } = vi.hoisted(() => ({ workSelectProps: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/app/actions/tasks', () => ({
    postTaskChatAction: vi.fn(),
    transitionTaskAction: vi.fn(),
    updateTaskAction: vi.fn(),
}));
vi.mock('@/components/record-visibility', () => ({ RecordVisibilityPanel: () => null }));
vi.mock('@/components/markdown/CollapsibleMarkdown', () => ({ CollapsibleMarkdown: () => null }));
vi.mock('@/components/markdown/MarkdownEditor', () => ({ MarkdownEditor: () => null }));
vi.mock('@/components/skills/SlashCommandAutocomplete', () => ({
    SlashCommandPopup: () => null,
    useSlashCommands: () => ({ handleKeyDown: vi.fn() }),
}));
vi.mock('./TaskScheduleSection', () => ({ TaskScheduleSection: () => null }));
vi.mock('./TaskChatMessageText', () => ({ TaskChatMessageText: () => null }));
vi.mock('./TaskPlanningSection', () => ({ TaskPlanningSection: () => null }));
vi.mock('./TaskSubtasksSection', () => ({ TaskSubtasksSection: () => null }));
vi.mock('./TaskActivitySection', () => ({ TaskActivitySection: () => null }));
vi.mock('./TaskAttachmentsSection', () => ({ TaskAttachmentsSection: () => null }));
vi.mock('./TaskBranchSection', () => ({ TaskBranchSection: () => null }));
vi.mock('./TaskChecksSection', () => ({ TaskChecksSection: () => null }));
vi.mock('./TaskDeliverySection', () => ({ TaskDeliverySection: () => null }));
vi.mock('./TaskCostSection', () => ({ TaskCostSection: () => null }));
vi.mock('./TaskRunControls', () => ({ TaskRunControls: () => null }));
vi.mock('./TaskRunsHistory', () => ({ TaskRunsHistory: () => null }));
vi.mock('./RunWithAgentMenu', () => ({ RunWithAgentMenu: () => null }));
vi.mock('./TaskDecisionConflicts', () => ({ TaskDecisionConflicts: () => null }));
vi.mock('./TaskDeleteButton', () => ({ TaskDeleteButton: () => null }));
vi.mock('./AgentSelect', () => ({ AgentSelect: () => null }));
vi.mock('./TaskExtraReposPicker', () => ({ TaskExtraReposPicker: () => null }));
vi.mock('./MissionSelect', () => ({ MissionSelect: () => null }));
vi.mock('./IdeaSelect', () => ({ IdeaSelect: () => null }));
vi.mock('./WorkSelect', () => ({
    WorkSelect: (props: { testId?: string; ownedOnly?: boolean }) => {
        workSelectProps(props);
        return null;
    },
}));

import { TaskDetailClient } from './TaskDetailClient';

describe('TaskDetailClient — the Work picker', () => {
    it('offers only the Works the caller owns', () => {
        render(
            <TaskDetailClient
                task={
                    {
                        id: 't1',
                        slug: 'T-1',
                        title: 'Ship it',
                        status: 'todo',
                        priority: 'p3',
                        description: '',
                        labels: [],
                        workId: 'w-own',
                        createdAt: '2026-11-11T09:00:00.000Z',
                        updatedAt: '2026-11-11T09:00:00.000Z',
                    } as never
                }
                initialChat={[]}
            />,
        );
        expect(workSelectProps).toHaveBeenLastCalledWith(
            expect.objectContaining({ testId: 'task-detail-work', ownedOnly: true }),
        );
    });
});
