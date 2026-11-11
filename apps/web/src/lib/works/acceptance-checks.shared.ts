import { z } from 'zod';
import {
    FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN,
    TASK_ACCEPTANCE_CHECK_KINDS,
    TASK_CHECK_PHASES,
    type TaskAcceptanceCheckKind,
    type TaskCheckPhase,
} from '@ever-works/contracts';

/**
 * The web side of one acceptance check (quality gates) — the same contract as
 * the API's `AcceptanceCheckDto` (`packages/agent/src/dto/acceptance-check.dto.ts`).
 *
 * Two defects lived here: the id allowed 64 characters where the API allows 41
 * (so a check named after a long sentence saved with a 400), and the schema did
 * not list `phase`, `mountDir` or `envPassthrough`. zod strips unknown keys, and
 * the API replaces the whole `checkDefaults` list, so every save through the
 * Quality gates card silently turned setup steps into gate checks, moved checks
 * back to the primary worktree and revoked their environment grants.
 */

/** `ACCEPTANCE_CHECK_ID_PATTERN` in `acceptance-check.dto.ts`. */
export const ACCEPTANCE_CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,40}$/;
export const ACCEPTANCE_CHECK_ID_MAX_LENGTH = 41;

/** `ENV_NAME_PATTERN` / `MAX_ENV_PASSTHROUGH` in `packages/agent/src/tasks-domain/check-env.ts`. */
export const CHECK_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_CHECK_ENV_PASSTHROUGH = 32;

export const acceptanceCheckSchema = z.object({
    id: z.string().regex(ACCEPTANCE_CHECK_ID_PATTERN),
    name: z.string().min(1).max(120),
    kind: z.enum(
        TASK_ACCEPTANCE_CHECK_KINDS as [TaskAcceptanceCheckKind, ...TaskAcceptanceCheckKind[]],
    ),
    command: z.string().min(1).max(2000),
    cwd: z.string().max(512).optional(),
    mountDir: z.string().regex(FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN).optional(),
    phase: z.enum(TASK_CHECK_PHASES as [TaskCheckPhase, ...TaskCheckPhase[]]).optional(),
    timeoutSec: z.number().int().min(1).max(3600).optional(),
    required: z.boolean(),
    disabled: z.boolean().optional(),
    envPassthrough: z
        .array(z.string().regex(CHECK_ENV_NAME_PATTERN))
        .max(MAX_CHECK_ENV_PASSTHROUGH)
        .optional(),
});

/**
 * "Type check!" → "type-check": the id the checks editor derives from a check's
 * name, cut to the API's 41 characters (without a trailing dash).
 */
export function slugifyCheckId(raw: string): string {
    return raw
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, ACCEPTANCE_CHECK_ID_MAX_LENGTH)
        .replace(/-+$/g, '');
}
