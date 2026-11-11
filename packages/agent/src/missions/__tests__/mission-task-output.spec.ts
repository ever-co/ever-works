import { WORK_KINDS } from '@ever-works/contracts';
import {
    MISSION_NO_APP_WORK_RELATION,
    MISSION_REPO_WORK_ISOLATION_OFF,
    missionFilesTasks,
    missionTaskOutputEligibility,
    missionTaskOutputPausedBySwitch,
    missionTaskOutputWarnings,
    normalizeMissionOutputMode,
    normalizeMissionTaskOutput,
} from '../mission-task-output';

/**
 * APW-08 T34 — a Mission's output, read without trusting the stored value: every field in bounds
 * or its default, garbage toward the defaults (plan §3.3), an unknown mode as `ideas`.
 */
describe('normalizeMissionTaskOutput (APW-08 T34)', () => {
    const AGENT = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

    it.each([
        ['nothing', undefined, { tasksPerTick: 1, openTasksCap: 3 }],
        ['null', null, { tasksPerTick: 1, openTasksCap: 3 }],
        ['an array', [2, 5], { tasksPerTick: 1, openTasksCap: 3 }],
        ['a string', 'tasks', { tasksPerTick: 1, openTasksCap: 3 }],
        [
            'the bounds',
            { tasksPerTick: 3, openTasksCap: 10 },
            { tasksPerTick: 3, openTasksCap: 10 },
        ],
        ['the floors', { tasksPerTick: 1, openTasksCap: 1 }, { tasksPerTick: 1, openTasksCap: 1 }],
        [
            'over the ceilings',
            { tasksPerTick: 4, openTasksCap: 11 },
            { tasksPerTick: 1, openTasksCap: 3 },
        ],
        [
            'under the floors',
            { tasksPerTick: 0, openTasksCap: -1 },
            { tasksPerTick: 1, openTasksCap: 3 },
        ],
        [
            'non-integers',
            { tasksPerTick: 1.5, openTasksCap: '5' },
            { tasksPerTick: 1, openTasksCap: 3 },
        ],
        [
            'an agent id',
            { agentId: AGENT },
            { tasksPerTick: 1, openTasksCap: 3, agentId: AGENT.toLowerCase() },
        ],
        ['a non-uuid agent id', { agentId: 'agent-1' }, { tasksPerTick: 1, openTasksCap: 3 }],
    ])('%s', (_name, raw, expected) => {
        expect(normalizeMissionTaskOutput(raw)).toEqual(expected);
    });
});

describe('the output mode (APW-08 T34)', () => {
    it('keeps the three modes and reads anything else as ideas', () => {
        expect(['ideas', 'tasks', 'both'].map(normalizeMissionOutputMode)).toEqual([
            'ideas',
            'tasks',
            'both',
        ]);
        for (const raw of [undefined, null, '', 'TASKS', 'all', 3]) {
            expect(normalizeMissionOutputMode(raw)).toBe('ideas');
        }
    });

    it('files Tasks for tasks and both only', () => {
        expect(missionFilesTasks('tasks')).toBe(true);
        expect(missionFilesTasks('both')).toBe(true);
        expect(missionFilesTasks('ideas')).toBe(false);
        expect(missionFilesTasks('garbage')).toBe(false);
    });
});

/**
 * Which attached Works a Mission's Task output files on: the kinds whose Tasks are delivered as
 * pull requests (`app`, `repo`), attached as Improves or Operates — and, for a Repository Work,
 * only while its Task isolation is on. The tick and the write path both ask this one function.
 */
describe('missionTaskOutputEligibility', () => {
    const row = (
        workKind: string | null,
        workTaskIsolation: string | null = 'off',
        relation = 'improves',
    ) => ({ workId: 'w-1', relation, workKind, workTaskIsolation });

    it('an App Work is eligible whatever its isolation setting says (its Tasks are always isolated)', () => {
        expect(missionTaskOutputEligibility(row('app', 'off'))).toBe('eligible');
        expect(missionTaskOutputEligibility(row('app', 'worktree'))).toBe('eligible');
        expect(missionTaskOutputEligibility(row(' APP ', null, 'operates'))).toBe('eligible');
    });

    it('a Repository Work is eligible only while its Task isolation is on', () => {
        expect(missionTaskOutputEligibility(row('repo', 'worktree'))).toBe('eligible');
        expect(missionTaskOutputEligibility(row('repo', 'worktree', 'operates'))).toBe('eligible');
        expect(missionTaskOutputEligibility(row('repo', 'off'))).toBe('isolation-off');
        // Missing or unknown reads as off: nothing is filed on a Work that may get no branch.
        expect(missionTaskOutputEligibility(row('repo', null))).toBe('isolation-off');
        expect(missionTaskOutputEligibility(row('repo', 'on'))).toBe('isolation-off');
        expect(missionTaskOutputEligibility({ relation: 'improves', workKind: 'repo' })).toBe(
            'isolation-off',
        );
    });

    it.each(WORK_KINDS.filter((kind) => kind !== 'app' && kind !== 'repo'))(
        'the %s kind is never a target, with isolation on or off',
        (kind) => {
            expect(missionTaskOutputEligibility(row(kind, 'worktree'))).toBe('not-applicable');
            expect(missionTaskOutputEligibility(row(kind, 'off'))).toBe('not-applicable');
        },
    );

    it('an unknown or missing kind, and any other relation, are never a target', () => {
        expect(missionTaskOutputEligibility(row(null, 'worktree'))).toBe('not-applicable');
        expect(missionTaskOutputEligibility(row('no-such-kind', 'worktree'))).toBe(
            'not-applicable',
        );
        for (const relation of ['created', 'markets', 'researches', 'retires', '']) {
            expect(missionTaskOutputEligibility(row('app', 'worktree', relation))).toBe(
                'not-applicable',
            );
            expect(missionTaskOutputEligibility(row('repo', 'worktree', relation))).toBe(
                'not-applicable',
            );
        }
    });
});

describe('missionTaskOutputWarnings', () => {
    const app = { workId: 'w-app', relation: 'improves', workKind: 'app' };
    const repoOn = {
        workId: 'w-on',
        relation: 'operates',
        workKind: 'repo',
        workTaskIsolation: 'worktree',
    };
    const repoOff = {
        workId: 'w-off',
        relation: 'improves',
        workKind: 'repo',
        workTaskIsolation: 'off',
    };

    it('warns noAppWorkRelation when no App or Repository Work is attached as Improves or Operates', () => {
        expect(missionTaskOutputWarnings([])).toEqual([MISSION_NO_APP_WORK_RELATION]);
        expect(
            missionTaskOutputWarnings([
                { workId: 'w-site', relation: 'improves', workKind: 'directory' },
                { ...app, relation: 'markets' },
                { ...repoOn, relation: 'researches' },
            ]),
        ).toEqual([MISSION_NO_APP_WORK_RELATION]);
        // The code on the wire did not change with its meaning.
        expect(MISSION_NO_APP_WORK_RELATION).toBe('noAppWorkRelation');
    });

    it('warns nothing once an App Work, or a Repository Work with isolation on, is attached', () => {
        expect(missionTaskOutputWarnings([app])).toEqual([]);
        expect(missionTaskOutputWarnings([repoOn])).toEqual([]);
        expect(missionTaskOutputWarnings([app, repoOn])).toEqual([]);
    });

    it('warns repoWorkTaskIsolationOff for a Repository Work with isolation off — alone or beside an eligible Work', () => {
        expect(missionTaskOutputWarnings([repoOff])).toEqual([MISSION_REPO_WORK_ISOLATION_OFF]);
        expect(missionTaskOutputWarnings([app, repoOff])).toEqual([
            MISSION_REPO_WORK_ISOLATION_OFF,
        ]);
        expect(missionTaskOutputWarnings([repoOn, repoOff])).toEqual([
            MISSION_REPO_WORK_ISOLATION_OFF,
        ]);
        expect(MISSION_REPO_WORK_ISOLATION_OFF).toBe('repoWorkTaskIsolationOff');
    });
});

describe('missionTaskOutputPausedBySwitch', () => {
    it('the App-changes switch pauses App Works only', () => {
        expect(missionTaskOutputPausedBySwitch({ workKind: 'app' }, false)).toBe(true);
        expect(missionTaskOutputPausedBySwitch({ workKind: ' App ' }, false)).toBe(true);
        expect(missionTaskOutputPausedBySwitch({ workKind: 'repo' }, false)).toBe(false);
        expect(missionTaskOutputPausedBySwitch({ workKind: null }, false)).toBe(false);
    });

    it('nothing is paused while the switch is on', () => {
        expect(missionTaskOutputPausedBySwitch({ workKind: 'app' }, true)).toBe(false);
        expect(missionTaskOutputPausedBySwitch({ workKind: 'repo' }, true)).toBe(false);
    });
});
