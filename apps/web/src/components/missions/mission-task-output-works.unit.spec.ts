import { describe, expect, it } from 'vitest';
import type { MissionWorkRelationDto } from '@/lib/api/missions';
import { missionTaskOutputWorks } from './mission-task-output-works';

/**
 * What a Mission's attached Works mean for its Task output: an App or Repository Work attached as
 * Improves or Operates is one it files Tasks on, and a Repository Work whose Task isolation is off
 * is reported so the Output card can say why nothing is filed there.
 */

function relation(overrides: Partial<MissionWorkRelationDto> = {}): MissionWorkRelationDto {
    return {
        id: 'rel-1',
        missionId: 'm1',
        workId: 'w-1',
        relation: 'improves',
        createdAt: '2026-11-10T00:00:00.000Z',
        workName: 'Bookings',
        workSlug: 'bookings',
        workKind: 'app',
        ...overrides,
    } as MissionWorkRelationDto;
}

describe('missionTaskOutputWorks', () => {
    it('nothing attached, or nothing loaded: no Work to file on', () => {
        expect(missionTaskOutputWorks([])).toEqual({ hasTaskWork: false, isolationOffWorks: [] });
        expect(missionTaskOutputWorks(undefined)).toEqual({
            hasTaskWork: false,
            isolationOffWorks: [],
        });
        expect(missionTaskOutputWorks(null)).toEqual({ hasTaskWork: false, isolationOffWorks: [] });
    });

    it('an App Work attached as Improves or Operates is a Work to file on, whatever its isolation setting says', () => {
        for (const kind of ['improves', 'operates'] as const) {
            expect(
                missionTaskOutputWorks([relation({ relation: kind, workTaskIsolation: 'off' })]),
            ).toEqual({ hasTaskWork: true, isolationOffWorks: [] });
        }
    });

    it('a Repository Work with Task isolation on is a Work to file on', () => {
        expect(
            missionTaskOutputWorks([
                relation({ workKind: 'repo', relation: 'operates', workTaskIsolation: 'worktree' }),
            ]),
        ).toEqual({ hasTaskWork: true, isolationOffWorks: [] });
    });

    it('a Repository Work with Task isolation off is attached, and reported once by name', () => {
        const result = missionTaskOutputWorks([
            relation({
                id: 'rel-a',
                workId: 'w-repo',
                workName: 'ever-works',
                workKind: 'repo',
                relation: 'improves',
                workTaskIsolation: 'off',
            }),
            // The same Work under the other relation is not a second entry.
            relation({
                id: 'rel-b',
                workId: 'w-repo',
                workName: 'ever-works',
                workKind: ' REPO ',
                relation: 'operates',
                workTaskIsolation: 'off',
            }),
        ]);
        expect(result).toEqual({
            hasTaskWork: true,
            isolationOffWorks: [{ workId: 'w-repo', workName: 'ever-works' }],
        });
    });

    it('falls back to the slug, then the id, for a Repository Work with no name', () => {
        expect(
            missionTaskOutputWorks([
                relation({
                    workId: 'w-repo',
                    workName: null,
                    workSlug: 'ever-works',
                    workKind: 'repo',
                    workTaskIsolation: 'off',
                }),
            ]).isolationOffWorks,
        ).toEqual([{ workId: 'w-repo', workName: 'ever-works' }]);
        expect(
            missionTaskOutputWorks([
                relation({
                    workId: 'w-repo',
                    workName: null,
                    workSlug: null,
                    workKind: 'repo',
                    workTaskIsolation: 'off',
                }),
            ]).isolationOffWorks,
        ).toEqual([{ workId: 'w-repo', workName: 'w-repo' }]);
    });

    it('never reports isolation as off when the API did not send the setting', () => {
        expect(missionTaskOutputWorks([relation({ workKind: 'repo' })])).toEqual({
            hasTaskWork: true,
            isolationOffWorks: [],
        });
        expect(
            missionTaskOutputWorks([relation({ workKind: 'repo', workTaskIsolation: null })]),
        ).toEqual({ hasTaskWork: true, isolationOffWorks: [] });
    });

    it('other kinds and other relations are never a Work to file on', () => {
        expect(
            missionTaskOutputWorks([
                relation({ workKind: 'directory', workTaskIsolation: 'worktree' }),
                relation({ workKind: 'awesome-repo', workTaskIsolation: 'worktree' }),
                relation({ workKind: 'project' }),
                relation({ workKind: null }),
                relation({ workKind: 'app', relation: 'markets' }),
                relation({ workKind: 'repo', relation: 'researches', workTaskIsolation: 'off' }),
            ]),
        ).toEqual({ hasTaskWork: false, isolationOffWorks: [] });
    });
});
