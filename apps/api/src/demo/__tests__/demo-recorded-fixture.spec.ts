/**
 * The seeder file imports the agent's Goals / Missions barrels, whose `@src/notifications`
 * imports resolve to the API's notifications files under api Jest and reach better-auth's ESM
 * through this one file. Nothing here builds an auth runtime.
 */
jest.mock('../../auth/providers/auth-runtime.instance', () => ({
    createAuthRuntimeInstance: jest.fn(),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    DEMO_RECORDED_FIXTURE_FILE,
    loadDemoRecordedFixture,
    parseDemoRecordedFixture,
} from '../seed/demo-recorded-seeder';

/**
 * Platform demo mode — the recorded examples' fixture (design §5.2.3). The file is plain data
 * that a capture from a real run may replace, so the loader checks it: what a sandbox shows
 * must name a free model and lie in the past, and its cross-references must resolve.
 */

const FIXTURE_PATH = join(__dirname, '..', 'seed', DEMO_RECORDED_FIXTURE_FILE);

/** A fresh, mutable copy of the committed file. */
function rawFixture(): any {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

describe('demo recorded fixture', () => {
    it('loads the committed recorded examples', () => {
        const fixture = loadDemoRecordedFixture();
        expect(fixture.model.id).toBe('google/gemma-4-31b-it:free');
        expect(fixture.goal.iterations).toHaveLength(2);
        expect(fixture.mission.plan.filter((task) => task.run)).toHaveLength(1);
        expect(fixture.conversation.messages).toHaveLength(4);
        expect(fixture.activity).toHaveLength(10);
    });

    it('refuses a model that is not free', () => {
        const raw = rawFixture();
        raw.model.id = 'openai/gpt-5';
        expect(() => parseDemoRecordedFixture(raw)).toThrow('model.id must name a free model');
    });

    it('refuses a time that is not in the past', () => {
        const raw = rawFixture();
        raw.conversation.messages[3].atMinutes = 5;
        expect(() => parseDemoRecordedFixture(raw)).toThrow(
            'conversation.messages[3].atMinutes must be a negative number of minutes',
        );
    });

    it('refuses a run that finishes before it starts, or a transcript line outside the run', () => {
        const backwards = rawFixture();
        backwards.goal.iterations[0].run.finishedAtMinutes = -149;
        expect(() => parseDemoRecordedFixture(backwards)).toThrow(
            'goal.iterations[0].run must be queued, then started, then finished',
        );
        const outside = rawFixture();
        outside.goal.iterations[1].run.transcript[0].atMinutes = -10;
        expect(() => parseDemoRecordedFixture(outside)).toThrow(
            'goal.iterations[1].run.transcript[0] must fall between the start and the finish',
        );
    });

    it('refuses an activity entry that names no recorded run', () => {
        const raw = rawFixture();
        raw.activity[2].run = 'iteration-9';
        expect(() => parseDemoRecordedFixture(raw)).toThrow('activity[2].run names no run');
    });

    it('refuses a done planned Task without a run, and a chat the Agent opens', () => {
        const noRun = rawFixture();
        delete noRun.mission.plan[0].run;
        expect(() => parseDemoRecordedFixture(noRun)).toThrow(
            'mission.plan[0] has a run exactly when it is done',
        );
        // A never-run `todo` Task with no Goal is what the Task fan-out driver starts.
        const todo = rawFixture();
        todo.mission.plan[1].status = 'todo';
        expect(() => parseDemoRecordedFixture(todo)).toThrow(
            'mission.plan[1].status must be one of backlog, done',
        );
        const agentFirst = rawFixture();
        agentFirst.conversation.messages[0].by = 'agent';
        expect(() => parseDemoRecordedFixture(agentFirst)).toThrow(
            'conversation.messages[0] must be the visitor’s',
        );
    });

    it('ships the fixture with the built API (Nest CLI assets are relative to sourceRoot)', () => {
        const nestCli = JSON.parse(readFileSync(join(__dirname, '../../../nest-cli.json'), 'utf8'));
        expect(nestCli.sourceRoot).toBe('src');
        expect(nestCli.compilerOptions.assets).toContain('demo/seed/*.json');
    });
});
