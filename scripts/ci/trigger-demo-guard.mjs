#!/usr/bin/env node
/**
 * Platform demo guard for `.github/workflows/release-trigger-selfhosted.yml` (docs/guides/demo-mode.md).
 *
 * The same task bundle is deployed a second time to the "Ever Works Demo" Trigger.dev project. Two rules
 * keep that deploy safe, and this script enforces both against the Trigger.dev API:
 *
 *   check-env             BEFORE the demo deploy: the target environment of the demo project must have
 *                         `DEMO` on, parsed exactly like the API does (`true`, `1` or `yes`, trimmed, any
 *                         case: packages/agent/src/config/index.ts). Without it the workers would run AI
 *                         calls without the demo's policy and quotas, so anything else fails the job:
 *                         variable missing, secret (value redacted), off, or the API unreachable.
 *   deactivate-schedules  AFTER the demo deploy: the bundle declares ~41 `schedules.task` crons (eight
 *                         every minute) for the platform. On a demo environment capped at 2 concurrent
 *                         runs they would queue ahead of every visitor's run, so every active
 *                         DECLARATIVE schedule outside the allowlist is deactivated. Trigger.dev keeps a
 *                         deactivated declarative schedule inactive across deploys; a schedule that a new
 *                         deploy adds starts active, which is why this runs after every demo deploy.
 *                         Kept: goal-advance-dispatcher (a visitor's running Goal loop advances only
 *                         through it) and agent-run-sweeper (reaps runs a killed worker left running).
 *
 * Environment: TRIGGER_API_URL, TRIGGER_ACCESS_TOKEN (the self-hosted PAT), TRIGGER_PROJECT_REF (the demo
 * project), TRIGGER_ENV (`staging` | `prod`), optional DEMO_SCHEDULE_ALLOW (comma/space separated task ids).
 * The PAT reads the environment's secret key for the schedules API; no secret is ever printed.
 *
 *   node scripts/ci/trigger-demo-guard.mjs check-env
 *   node scripts/ci/trigger-demo-guard.mjs deactivate-schedules
 *
 * No dependencies (global fetch), so it runs before or without `pnpm install`.
 */
import { fileURLToPath } from 'node:url';

/** The Ever Works PLATFORM project: the demo must never target it. */
export const PLATFORM_PROJECT_REF = 'proj_ixrpwdtsfolfxlbkgkle';
export const DEFAULT_SCHEDULE_ALLOW = Object.freeze(['goal-advance-dispatcher', 'agent-run-sweeper']);
const ENV_KEY_PREFIX = { staging: 'tr_stg_', prod: 'tr_prod_' };

export class GuardError extends Error {}

/** The API's own DEMO parse (packages/agent/src/config/index.ts `isDemoMode`). */
export function isDemoOn(value) {
	return ['true', '1', 'yes'].includes(
		String(value ?? '')
			.trim()
			.toLowerCase()
	);
}

export function parseAllowlist(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return [...DEFAULT_SCHEDULE_ALLOW];
	}
	return String(raw)
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Validates the inputs; throws GuardError with an operator-readable reason. */
export function readTarget(env) {
	const apiUrl = String(env.TRIGGER_API_URL || 'https://trigger.ever.co').replace(/\/+$/, '');
	const token = env.TRIGGER_ACCESS_TOKEN || '';
	const ref = env.TRIGGER_PROJECT_REF || '';
	const triggerEnv = env.TRIGGER_ENV || '';
	if (!/^https?:\/\/[^\s]+$/.test(apiUrl)) throw new GuardError('TRIGGER_API_URL is not a URL');
	if (!token) throw new GuardError('TRIGGER_ACCESS_TOKEN is empty');
	if (!/^proj_[a-z0-9]+$/.test(ref)) {
		throw new GuardError('TRIGGER_PROJECT_REF is not a Trigger.dev project ref (proj_...)');
	}
	if (ref === PLATFORM_PROJECT_REF) {
		throw new GuardError('TRIGGER_PROJECT_REF is the platform project; the demo needs its own project');
	}
	if (!Object.hasOwn(ENV_KEY_PREFIX, triggerEnv)) {
		throw new GuardError(`TRIGGER_ENV must be staging or prod, got "${triggerEnv}"`);
	}
	return { apiUrl, token, ref, triggerEnv, allow: parseAllowlist(env.DEMO_SCHEDULE_ALLOW) };
}

async function getJson(fetchImpl, url, token, init = {}) {
	let res;
	try {
		res = await fetchImpl(url, {
			...init,
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers || {}) },
			signal: AbortSignal.timeout(30_000)
		});
	} catch (err) {
		throw new GuardError(`${init.method || 'GET'} ${new URL(url).pathname}: ${err?.message || err}`);
	}
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { status: res.status, body };
}

/** check-env: resolves when DEMO is on in the target environment, throws GuardError otherwise. */
export async function checkDemoEnv(target, fetchImpl = fetch) {
	const { apiUrl, token, ref, triggerEnv } = target;
	const url = `${apiUrl}/api/v1/projects/${ref}/envvars/${triggerEnv}/DEMO`;
	const { status, body } = await getJson(fetchImpl, url, token);
	if (status === 404) {
		throw new GuardError(`DEMO is not set in ${ref}/${triggerEnv}: set DEMO=true before deploying the demo`);
	}
	if (status !== 200 || !body) {
		throw new GuardError(`reading DEMO in ${ref}/${triggerEnv} answered HTTP ${status}`);
	}
	if (body.isSecret === true) {
		throw new GuardError(`DEMO in ${ref}/${triggerEnv} is a secret variable (value redacted): make it a plain one`);
	}
	if (!isDemoOn(body.value)) {
		throw new GuardError(`DEMO in ${ref}/${triggerEnv} is not on: refusing to deploy the demo workers`);
	}
	return { demo: String(body.value).trim() };
}

async function envSecretKey(target, fetchImpl) {
	const { apiUrl, token, ref, triggerEnv } = target;
	const { status, body } = await getJson(fetchImpl, `${apiUrl}/api/v1/projects/${ref}/${triggerEnv}`, token);
	if (status !== 200 || !body) {
		throw new GuardError(`reading the ${triggerEnv} environment of ${ref} answered HTTP ${status}`);
	}
	const key = typeof body.apiKey === 'string' ? body.apiKey : '';
	if (!key.startsWith(ENV_KEY_PREFIX[triggerEnv])) {
		throw new GuardError(`the ${triggerEnv} secret key of ${ref} has an unexpected format`);
	}
	return key;
}

async function listSchedules(apiUrl, key, fetchImpl) {
	const all = [];
	for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
		const { status, body } = await getJson(fetchImpl, `${apiUrl}/api/v1/schedules?perPage=100&page=${page}`, key);
		if (status !== 200 || !body || !Array.isArray(body.data)) {
			throw new GuardError(`listing schedules (page ${page}) answered HTTP ${status}`);
		}
		all.push(...body.data);
		pages = Number(body.pagination?.totalPages) || 1;
	}
	return all;
}

/** deactivate-schedules: returns { deactivated: [task ids], keptActive: [task ids] }; throws on any failure. */
export async function deactivateSchedules(target, fetchImpl = fetch, log = () => {}) {
	const { apiUrl, allow } = target;
	const key = await envSecretKey(target, fetchImpl);
	const before = await listSchedules(apiUrl, key, fetchImpl);
	const todo = before.filter((s) => s.active === true && s.type === 'DECLARATIVE' && !allow.includes(s.task));
	const deactivated = [];
	for (const s of todo) {
		if (!/^sched_[A-Za-z0-9]+$/.test(String(s.id))) throw new GuardError('unexpected schedule id');
		const { status, body } = await getJson(fetchImpl, `${apiUrl}/api/v1/schedules/${s.id}/deactivate`, key, {
			method: 'POST'
		});
		if (status !== 200 || body?.active !== false) {
			throw new GuardError(`deactivating ${s.task} (${s.id}) answered HTTP ${status}`);
		}
		deactivated.push(s.task);
		log(`deactivated ${s.task} (${s.id})`);
	}
	const after = await listSchedules(apiUrl, key, fetchImpl);
	const left = after.filter((s) => s.active === true && s.type === 'DECLARATIVE' && !allow.includes(s.task));
	if (left.length > 0) {
		throw new GuardError(`still active after deactivation: ${left.map((s) => s.task).join(', ')}`);
	}
	const imperative = after.filter((s) => s.active === true && s.type !== 'DECLARATIVE').map((s) => s.task);
	if (imperative.length > 0) log(`note: active non-declarative schedules left alone: ${imperative.join(', ')}`);
	return { deactivated, keptActive: after.filter((s) => s.active === true).map((s) => s.task) };
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
	const command = argv[0];
	try {
		const target = readTarget(env);
		if (command === 'check-env') {
			const { demo } = await checkDemoEnv(target, fetchImpl);
			console.log(`DEMO=${demo} in ${target.ref}/${target.triggerEnv}: the demo deploy may proceed`);
			return 0;
		}
		if (command === 'deactivate-schedules') {
			const r = await deactivateSchedules(target, fetchImpl, (line) => console.log(line));
			console.log(
				`${target.ref}/${target.triggerEnv}: ${r.deactivated.length} platform schedule(s) deactivated; ` +
					`active: ${r.keptActive.join(', ') || 'none'}`
			);
			return 0;
		}
		console.error('usage: trigger-demo-guard.mjs <check-env|deactivate-schedules>');
		return 2;
	} catch (err) {
		if (err instanceof GuardError) {
			console.error(`::error::platform demo guard: ${err.message}`);
			return 1;
		}
		throw err;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main();
}
