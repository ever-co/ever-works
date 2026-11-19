import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Demo mode (`DEMO=true`) — ledger of the GitHub repositories a demo sandbox created, so the sweeper deletes
 * exactly those and nothing else.
 *
 * `sandboxUserId` deliberately has NO foreign key: the ledger must survive the sandbox user's deletion until
 * the repository itself is gone.
 */
@Entity({ name: 'demo_github_repos' })
@Index('idx_demo_github_repos_sandbox_user', ['sandboxUserId'])
export class DemoGithubRepo {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    sandboxUserId: string;

    @Column({ type: 'varchar', length: 255 })
    owner: string;

    @Column({ type: 'varchar', length: 255 })
    name: string;

    /** GitHub's numeric repo id; deletion requires the live repo id to match it. bigint reads back as a string on Postgres. */
    @Column({
        type: 'bigint',
        nullable: true,
        transformer: {
            to: (value?: number | null) => value ?? null,
            from: (value?: string | number | null) =>
                value === null || value === undefined ? null : Number(value),
        },
    })
    githubId: number | null;

    @CreateDateColumn()
    createdAt: Date;

    @PortableDateColumn({ nullable: true })
    deletedAt: Date | null;

    @Column({ type: 'text', nullable: true })
    lastError: string | null;

    @Column({ type: 'int', default: 0 })
    attempts: number;
}
