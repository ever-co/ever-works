import { Injectable } from '@nestjs/common';
import type { User } from '@ever-works/agent/entities';

/** What the seeder created for one demo sandbox. */
export type DemoSeedSummary = {
    organizationId: string;
    projectWorkId: string;
    directoryWorkId: string;
    recordedGoalId: string | null;
};

/**
 * Seeds a fresh demo sandbox's workspace. Placeholder: the real seeding (organization,
 * the project Work, the draft directory Work, the recorded goal) arrives with the seeder task.
 */
@Injectable()
export class DemoSandboxSeederService {
    async seed(_user: User): Promise<DemoSeedSummary> {
        return { organizationId: '', projectWorkId: '', directoryWorkId: '', recordedGoalId: null };
    }
}
