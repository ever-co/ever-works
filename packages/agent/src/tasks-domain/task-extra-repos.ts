import { BadRequestException } from '@nestjs/common';
import type { TaskExtraRepo } from '@ever-works/contracts';
import {
    FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN,
    TASK_MAX_EXTRA_REPOS,
    isReservedMountDir,
} from '@ever-works/contracts';
import { resolveMountDir } from '../entities/repo-connection.entity';
import type { RepoConnectionRepository } from '../database/repositories/repo-connection.repository';
import { repositoryIdFromCloneUrl } from './task-workspace.service';

/**
 * Multi-repo Task workspaces — THE `extraRepos` validator.
 *
 * Lifted VERBATIM out of `TasksService.normalizeExtraRepos` (slice C, PR
 * C2) when a second caller appeared: a Task Template step can now carry
 * its own `extraRepos` (slice AH), and a template step that is validated
 * by a second, slightly different implementation is a template step that
 * writes Tasks every run then refuses. There is deliberately ONE set of
 * rules; `TasksService.normalizeExtraRepos` is now a one-line delegation
 * to this function, and `tasks.service.extra-repos.spec.ts` passing
 * unchanged is the proof the move was behaviour-preserving.
 *
 * A free function rather than an injectable on purpose: every service
 * that needs it already holds (or can @Optional()-hold) a
 * `RepoConnectionRepository`, and a new provider would change positional
 * constructor arity for fixtures that construct services by hand.
 *
 * ⚠️ Import direction: this leaf imports `repositoryIdFromCloneUrl` from
 * `task-workspace.service`, which transitively pulls in
 * `TaskTransitionService` / `TaskChatService`. No cycle exists today
 * (nothing in that chain imports `task-templates.service` or this file),
 * but importing `task-templates.service` from anywhere under
 * `task-workspace.service` would create one.
 */

/** The collaborators the validator needs. Absent registry ⇒ refuse. */
export interface TaskExtraReposDeps {
    repoConnections?: RepoConnectionRepository;
}

/**
 * Validate and normalize a Task's (or a template step's) extra
 * repositories. Every connection must belong to the OWNER (the identity
 * the fleet plan resolves connections under — an org member editing
 * another member's Task cannot use their own) and be enabled; the
 * EFFECTIVE mount directory (explicit `mountDir`, else the connection's
 * mount path or name) must pass the same gate the fleet normalizer
 * applies at plan time and be unique case-insensitively (Windows and
 * macOS collide); two connections may not point at the same repository;
 * at most {@link TASK_MAX_EXTRA_REPOS} entries. `null` / `[]` mean
 * "none". Refusing HERE, naming the connection, beats accepting an edit
 * that every run then refuses.
 */
export async function normalizeTaskExtraRepos(
    deps: TaskExtraReposDeps,
    ownerId: string,
    raw: TaskExtraRepo[] | null | undefined,
    editorId: string = ownerId,
    /**
     * The Task's CURRENT extra repositories, on an update. An entry it already
     * had is not re-validated against the registry: when its connection was
     * deleted since, the entry is dropped (it can never mount again); when it
     * was disabled, the stored entry is kept as is (it can be re-enabled).
     * The Task editor always sends the whole list, so re-validating every
     * entry made one stale connection block every later edit of the list with
     * "not found" / "is disabled" — the picker no longer shows it, so the user
     * could not even untick it. New entries are validated in full.
     */
    current: readonly TaskExtraRepo[] | null = null,
): Promise<TaskExtraRepo[] | null> {
    if (raw === undefined || raw === null) return null;
    if (!Array.isArray(raw)) throw new BadRequestException('extraRepos must be an array.');
    if (raw.length === 0) return null;
    if (raw.length > TASK_MAX_EXTRA_REPOS) {
        throw new BadRequestException(
            `A Task can span at most ${TASK_MAX_EXTRA_REPOS} extra repositories (got ${raw.length}).`,
        );
    }
    if (!deps.repoConnections) {
        throw new BadRequestException(
            'Extra repositories are not available: the repository registry is not configured.',
        );
    }
    const seenConnections = new Set<string>();
    const seenDirs = new Map<string, string>();
    const seenRepositories = new Map<string, string>();
    const normalized: TaskExtraRepo[] = [];
    const currentById = new Map((current ?? []).map((entry) => [entry.repoConnectionId, entry]));
    for (const entry of raw) {
        const repoConnectionId =
            typeof entry?.repoConnectionId === 'string' ? entry.repoConnectionId.trim() : '';
        if (!repoConnectionId) {
            throw new BadRequestException('extraRepos entries need a repoConnectionId.');
        }
        if (seenConnections.has(repoConnectionId)) {
            throw new BadRequestException(
                `Repository connection ${repoConnectionId} is listed twice in extraRepos.`,
            );
        }
        seenConnections.add(repoConnectionId);
        const connection = await deps.repoConnections.findByIdAndUser(repoConnectionId, ownerId);
        const stored = currentById.get(repoConnectionId);
        if (!connection && stored) {
            continue;
        }
        if (connection && !connection.enabled && stored) {
            // Kept as stored, but it still takes part in the duplicate checks below: once
            // the connection is re-enabled it mounts again, so a new entry may not share
            // its directory or its repository (whichever of the two comes first in the list).
            const storedIdentity =
                typeof connection.url === 'string'
                    ? repositoryIdFromCloneUrl(connection.url)
                    : null;
            if (storedIdentity) {
                claimRepository(seenRepositories, storedIdentity, connection.name);
            }
            claimMountDir(
                seenDirs,
                stored.mountDir ?? resolveMountDir(connection.mountPath, connection.name),
                connection.name,
            );
            normalized.push(stored);
            continue;
        }
        if (!connection) {
            throw new BadRequestException(
                editorId === ownerId
                    ? `Repository connection ${repoConnectionId} not found.`
                    : `Repository connection ${repoConnectionId} not found: extra repositories must be connections in the Task owner's repository registry.`,
            );
        }
        if (!connection.enabled) {
            throw new BadRequestException(
                `Repository connection ${connection.name} is disabled and cannot be added to a Task.`,
            );
        }
        // The plan derives the repository identity from the URL; a
        // connection it cannot describe would fail every run.
        const identity =
            typeof connection.url === 'string' ? repositoryIdFromCloneUrl(connection.url) : null;
        if (!identity) {
            throw new BadRequestException(
                `Repository connection ${connection.name} cannot be mounted on a fleet run: its URL is not an <owner>/<repository> clone URL.`,
            );
        }
        claimRepository(seenRepositories, identity, connection.name);

        const mountDirRaw =
            typeof entry.mountDir === 'string' ? entry.mountDir.trim() : (entry.mountDir ?? null);
        const mountDir = mountDirRaw ? mountDirRaw : null;
        if (
            mountDir !== null &&
            (!FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN.test(mountDir) || isReservedMountDir(mountDir))
        ) {
            throw new BadRequestException(
                `extraRepos mountDir '${mountDir}' must be a single directory name (letters, digits, '.', '_' or '-'; no leading or trailing dot; not '.git', '.mounts', 'node_modules' or a Windows device name).`,
            );
        }
        // Registry mount paths are looser than fleet mount directories
        // (a leading dot and up to 200 characters pass there), so the
        // derived directory is checked against the fleet gate as well.
        const effectiveDir = mountDir ?? resolveMountDir(connection.mountPath, connection.name);
        if (
            mountDir === null &&
            (!FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN.test(effectiveDir) ||
                isReservedMountDir(effectiveDir))
        ) {
            throw new BadRequestException(
                `Repository connection ${connection.name} would be mounted at '${effectiveDir}', which is not a valid fleet mount directory (letters, digits, '.', '_' or '-'; no leading or trailing dot; up to 64 characters; not '.git', '.mounts', 'node_modules' or a Windows device name). Set an explicit mountDir for it.`,
            );
        }
        claimMountDir(seenDirs, effectiveDir, connection.name);

        if (entry.writable !== undefined && typeof entry.writable !== 'boolean') {
            throw new BadRequestException('extraRepos writable must be a boolean.');
        }
        normalized.push({
            repoConnectionId,
            ...(mountDir !== null ? { mountDir } : {}),
            ...(entry.writable === undefined ? {} : { writable: entry.writable }),
        });
    }
    return normalized.length > 0 ? normalized : null;
}

/** Record that `name` mounts `identity`; a second connection to the same repository is refused. */
function claimRepository(seen: Map<string, string>, identity: string, name: string): void {
    const sameRepository = seen.get(identity.toLowerCase());
    if (sameRepository) {
        throw new BadRequestException(
            `Repository connections ${sameRepository} and ${name} both point at ${identity}; a Task mounts each repository once.`,
        );
    }
    seen.set(identity.toLowerCase(), name);
}

/** Record that `name` mounts at `dir` (case-insensitively: Windows and macOS collide); a second one is refused. */
function claimMountDir(seen: Map<string, string>, dir: string, name: string): void {
    const sameDir = seen.get(dir.toLowerCase());
    if (sameDir) {
        throw new BadRequestException(
            `extraRepos mount directory '${dir}' is used twice (${sameDir} and ${name}); set a distinct mountDir.`,
        );
    }
    seen.set(dir.toLowerCase(), name);
}
