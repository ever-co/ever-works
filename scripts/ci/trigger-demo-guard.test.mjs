// Unit tests for scripts/ci/trigger-demo-guard.mjs (no network: a fake fetch answers every call).
//   node --test scripts/ci/trigger-demo-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_SCHEDULE_ALLOW,
	GuardError,
	PLATFORM_PROJECT_REF,
	checkDemoEnv,
	deactivateSchedules,
	isDemoOn,
	main,
	parseAllowlist,
	readTarget
} from './trigger-demo-guard.mjs';

const ENV = {
	TRIGGER_API_URL: 'https://trigger.example.test/',
	TRIGGER_ACCESS_TOKEN: 'tr_pat_test',
	TRIGGER_PROJECT_REF: 'proj_demo123',
	TRIGGER_ENV: 'staging'
};

/** A fake Trigger.dev API: routes keyed by "METHOD path" (query string kept). Records every call. */
function fakeApi(routes) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		const u = new URL(url);
		const key = `${init.method || 'GET'} ${u.pathname}${u.search}`;
		calls.push({ key, auth: init.headers?.Authorization });
		const route = routes[key];
		if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
		const r = typeof route === 'function' ? route() : route;
		if (r instanceof Error) throw r;
		return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
	};
	return { fetchImpl, calls };
}

const target = () => readTarget(ENV);

test('isDemoOn mirrors the API parse (trimmed, any case, true/1/yes only)', () => {
	for (const v of ['true', 'TRUE', ' yes ', '1', 'Yes']) assert.equal(isDemoOn(v), true, v);
	for (const v of ['false', '0', '', 'on', 'enabled', undefined, null, 'true1'])
		assert.equal(isDemoOn(v), false, String(v));
});

test('readTarget refuses the platform project, a bad ref, a missing token and an unknown env', () => {
	assert.throws(() => readTarget({ ...ENV, TRIGGER_PROJECT_REF: PLATFORM_PROJECT_REF }), /platform project/);
	assert.throws(() => readTarget({ ...ENV, TRIGGER_PROJECT_REF: 'proj_A B' }), /not a Trigger.dev project ref/);
	assert.throws(() => readTarget({ ...ENV, TRIGGER_ACCESS_TOKEN: '' }), /TRIGGER_ACCESS_TOKEN is empty/);
	assert.throws(() => readTarget({ ...ENV, TRIGGER_ENV: 'dev' }), /staging or prod/);
	const t = target();
	assert.equal(t.apiUrl, 'https://trigger.example.test');
	assert.deepEqual(t.allow, [...DEFAULT_SCHEDULE_ALLOW]);
});

test('parseAllowlist accepts commas and spaces, and defaults when empty', () => {
	assert.deepEqual(parseAllowlist('a, b  c'), ['a', 'b', 'c']);
	assert.deepEqual(parseAllowlist(''), [...DEFAULT_SCHEDULE_ALLOW]);
});

const DEMO_PATH = 'GET /api/v1/projects/proj_demo123/envvars/staging/DEMO';

test('check-env passes only when DEMO is on and not secret', async () => {
	const ok = fakeApi({ [DEMO_PATH]: { body: { name: 'DEMO', value: 'true', isSecret: false } } });
	assert.deepEqual(await checkDemoEnv(target(), ok.fetchImpl), { demo: 'true' });
	assert.equal(ok.calls[0].auth, 'Bearer tr_pat_test');
});

test('check-env fails closed: missing, off, secret, other status, network error', async () => {
	const cases = [
		[{}, /is not set/],
		[{ [DEMO_PATH]: { body: { value: 'false', isSecret: false } } }, /is not on/],
		[{ [DEMO_PATH]: { body: { value: '', isSecret: false } } }, /is not on/],
		[{ [DEMO_PATH]: { body: { value: '<redacted>', isSecret: true } } }, /secret variable/],
		[{ [DEMO_PATH]: { status: 401, body: { error: 'Invalid' } } }, /HTTP 401/],
		[{ [DEMO_PATH]: () => new TypeError('fetch failed') }, /fetch failed/]
	];
	for (const [routes, re] of cases) {
		await assert.rejects(
			checkDemoEnv(target(), fakeApi(routes).fetchImpl),
			(e) => e instanceof GuardError && re.test(e.message)
		);
	}
});

const KEY_PATH = 'GET /api/v1/projects/proj_demo123/staging';
const LIST = (page) => `GET /api/v1/schedules?perPage=100&page=${page}`;
const sched = (id, task, active, type = 'DECLARATIVE') => ({ id, task, active, type });

test('deactivate-schedules deactivates every active declarative schedule outside the allowlist, across pages', async () => {
	let listed = 0;
	const state = {
		sched_a: sched('sched_a', 'mission-tick', true),
		sched_b: sched('sched_b', 'goal-advance-dispatcher', true),
		sched_c: sched('sched_c', 'kb-reconcile', false),
		sched_d: sched('sched_d', 'app-health-poll', true),
		sched_e: sched('sched_e', 'custom-user-schedule', true, 'IMPERATIVE')
	};
	const page = (ids) => ({
		data: ids.map((id) => state[id]),
		pagination: { currentPage: 1, totalPages: 2, count: 5 }
	});
	const api = fakeApi({
		[KEY_PATH]: { body: { apiKey: 'tr_stg_secret', name: 'Ever Works Demo' } },
		[LIST(1)]: () => (listed++, { body: page(['sched_a', 'sched_b', 'sched_c']) }),
		[LIST(2)]: () => ({ body: page(['sched_d', 'sched_e']) }),
		'POST /api/v1/schedules/sched_a/deactivate': () => ((state.sched_a.active = false), { body: state.sched_a }),
		'POST /api/v1/schedules/sched_d/deactivate': () => ((state.sched_d.active = false), { body: state.sched_d })
	});
	const logs = [];
	const r = await deactivateSchedules(target(), api.fetchImpl, (l) => logs.push(l));
	assert.deepEqual(r.deactivated, ['mission-tick', 'app-health-poll']);
	assert.deepEqual(r.keptActive.sort(), ['custom-user-schedule', 'goal-advance-dispatcher']);
	assert.equal(listed, 2, 'listed before and after');
	// The schedules API is called with the ENV secret key, never the PAT; the PAT only reads the key.
	assert.ok(api.calls.filter((c) => c.key.includes('/schedules')).every((c) => c.auth === 'Bearer tr_stg_secret'));
	assert.equal(api.calls.find((c) => c.key === KEY_PATH).auth, 'Bearer tr_pat_test');
	assert.ok(logs.some((l) => l.includes('left alone: custom-user-schedule')));
	assert.ok(!logs.join('\n').includes('tr_stg_secret'), 'the key is never logged');
});

test('deactivate-schedules is a no-op when only the allowlist is active', async () => {
	const api = fakeApi({
		[KEY_PATH]: { body: { apiKey: 'tr_stg_k' } },
		[LIST(1)]: {
			body: {
				data: [sched('sched_b', 'agent-run-sweeper', true), sched('sched_c', 'mission-tick', false)],
				pagination: { totalPages: 1 }
			}
		}
	});
	const r = await deactivateSchedules(target(), api.fetchImpl);
	assert.deepEqual(r.deactivated, []);
	assert.ok(!api.calls.some((c) => c.key.startsWith('POST')));
});

test('deactivate-schedules fails closed: wrong key prefix, a failed deactivate, a schedule still active', async () => {
	const prodTarget = readTarget({ ...ENV, TRIGGER_ENV: 'prod' });
	await assert.rejects(
		deactivateSchedules(
			prodTarget,
			fakeApi({ 'GET /api/v1/projects/proj_demo123/prod': { body: { apiKey: 'tr_stg_x' } } }).fetchImpl
		),
		/unexpected format/
	);
	const listing = { body: { data: [sched('sched_a', 'mission-tick', true)], pagination: { totalPages: 1 } } };
	await assert.rejects(
		deactivateSchedules(
			target(),
			fakeApi({
				[KEY_PATH]: { body: { apiKey: 'tr_stg_k' } },
				[LIST(1)]: listing,
				'POST /api/v1/schedules/sched_a/deactivate': { status: 500, body: {} }
			}).fetchImpl
		),
		/answered HTTP 500/
	);
	await assert.rejects(
		deactivateSchedules(
			target(),
			fakeApi({
				[KEY_PATH]: { body: { apiKey: 'tr_stg_k' } },
				[LIST(1)]: listing,
				'POST /api/v1/schedules/sched_a/deactivate': { body: { active: false } }
			}).fetchImpl
		),
		/still active after deactivation: mission-tick/
	);
});

test('main exits 1 with a ::error:: line on a guard failure and 2 on a bad command', async () => {
	const errors = [];
	const orig = console.error;
	console.error = (l) => errors.push(l);
	try {
		assert.equal(
			await main(['check-env'], { ...ENV, TRIGGER_PROJECT_REF: PLATFORM_PROJECT_REF }, fakeApi({}).fetchImpl),
			1
		);
		assert.match(errors[0], /^::error::platform demo guard: .*platform project/);
		assert.equal(await main(['nope'], ENV, fakeApi({}).fetchImpl), 2);
	} finally {
		console.error = orig;
	}
	assert.equal(
		await main(['check-env'], ENV, fakeApi({ [DEMO_PATH]: { body: { value: 'yes', isSecret: false } } }).fetchImpl),
		0
	);
});
