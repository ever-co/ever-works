import { isRepositoryWorkKind, workKindDeliversTasksAsPullRequests } from '@ever-works/contracts';
import type { MissionWorkRelationDto } from '@/lib/api/missions';

/** A Repository Work the Mission cannot file Tasks on while its Task isolation is off. */
export interface MissionIsolationOffWork {
    workId: string;
    workName: string;
}

/**
 * What a Mission's attached Works mean for its Task output, as the Output card shows it.
 *
 * - `hasTaskWork` — a Work whose Tasks are delivered as pull requests (an App Work or a
 *   Repository Work, `workKindDeliversTasksAsPullRequests`) is attached as Improves or Operates.
 *   Without one the card says what to attach.
 * - `isolationOffWorks` — the attached Repository Works whose Task isolation is off. A Task there
 *   would get no branch and no pull request, so the Mission files nothing on them until the
 *   setting is on; the card names them and links to their settings.
 *
 * The API decides the same thing when a Mission is saved (`warnings`: `noAppWorkRelation`,
 * `repoWorkTaskIsolationOff`) and on every tick; this is the same rule read from the relations
 * the page already has, so the card can say it before a save. A relation with no
 * `workTaskIsolation` (an API that does not send it yet) is never reported as off.
 */
export function missionTaskOutputWorks(
    relations: readonly MissionWorkRelationDto[] | null | undefined,
): { hasTaskWork: boolean; isolationOffWorks: MissionIsolationOffWork[] } {
    const isolationOffWorks: MissionIsolationOffWork[] = [];
    let hasTaskWork = false;
    for (const relation of relations ?? []) {
        if (relation.relation !== 'improves' && relation.relation !== 'operates') continue;
        if (!workKindDeliversTasksAsPullRequests(relation.workKind)) continue;
        hasTaskWork = true;
        if (
            isRepositoryWorkKind(relation.workKind) &&
            typeof relation.workTaskIsolation === 'string' &&
            relation.workTaskIsolation !== 'worktree' &&
            !isolationOffWorks.some((work) => work.workId === relation.workId)
        ) {
            isolationOffWorks.push({
                workId: relation.workId,
                workName: relation.workName ?? relation.workSlug ?? relation.workId,
            });
        }
    }
    return { hasTaskWork, isolationOffWorks };
}
