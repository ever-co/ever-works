/**
 * docs.ever.works sends the security headers every Ever website sends (the ever.co baseline) and
 * answers /.well-known/security.txt (RFC 9116), both from the docs image's nginx.conf.
 *
 * nginx drops every server-level `add_header` in a location that sets an `add_header` of its own,
 * so a new Cache-Control location silently strips the security headers from the files it serves.
 * These checks keep the set on the server block AND on every location that adds a header, keep the
 * nginx version out of the Server header, and fail once security.txt's Expires date has passed.
 *
 * Run: `pnpm --filter ever-works-docs test` (node's built-in runner, no dependencies).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '../..');
const nginxPath = '.deploy/docker/docs/nginx.conf';
const nginx = readFileSync(path.join(repoRoot, nginxPath), 'utf8');

const SECURITY_HEADERS = [
	'add_header X-Content-Type-Options "nosniff" always;',
	'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
	'add_header X-Frame-Options "SAMEORIGIN" always;',
	`add_header Content-Security-Policy "base-uri 'self'; object-src 'none'; frame-ancestors 'self'" always;`,
	'add_header Permissions-Policy "camera=(), geolocation=(), microphone=()" always;'
];

/**
 * The server block's own directives and each location's directives, comments dropped. Only one
 * nesting level of locations is expected (the file has no nested locations).
 */
function parseBlocks(source) {
	const server = [];
	const locations = [];
	let depth = 0;
	let current;
	for (const raw of source.split('\n')) {
		const line = raw.replace(/#.*$/, '').trim();
		if (!line) continue;
		if (line.startsWith('location ') && line.endsWith('{')) {
			current = { name: line.slice(0, -1).trim(), lines: [] };
			locations.push(current);
			depth++;
			continue;
		}
		if (line.endsWith('{')) {
			depth++;
			continue;
		}
		if (line === '}') {
			depth--;
			if (depth === 1) current = undefined;
			continue;
		}
		(current ? current.lines : server).push(line);
	}
	return { server, locations };
}

const { server, locations } = parseBlocks(nginx);

describe('docs.ever.works nginx.conf sends the security headers', () => {
	it('sets the full set at server level', () => {
		for (const header of SECURITY_HEADERS) {
			assert.ok(server.includes(header), `${nginxPath} server block must contain \`${header}\``);
		}
	});

	it('repeats the full set in every location that adds a header of its own', () => {
		for (const location of locations.filter((l) => l.lines.some((line) => line.startsWith('add_header ')))) {
			for (const header of SECURITY_HEADERS) {
				assert.ok(
					location.lines.includes(header),
					`\`${location.name}\` sets add_header, which drops the server-level ones: it must repeat \`${header}\``
				);
			}
		}
	});

	it('turns server_tokens off', () => {
		assert.ok(server.includes('server_tokens off;'), `${nginxPath} must contain \`server_tokens off;\``);
	});
});

describe('docs.ever.works serves /.well-known/security.txt', () => {
	const location = locations.find((l) => l.name === 'location = /.well-known/security.txt');
	const body = () => {
		const ret = location.lines.find((line) => line.startsWith('return 200 "'));
		assert.ok(ret, 'the security.txt location must `return 200 "<body>"`');
		return ret.slice('return 200 "'.length, ret.lastIndexOf('"')).split('\\n');
	};

	it('has an exact-match location answered as text/plain', () => {
		assert.ok(location, `${nginxPath} must have \`location = /.well-known/security.txt\``);
		assert.ok(location.lines.includes('default_type text/plain;'));
	});

	it('lists Contact, Canonical and Policy', () => {
		const fields = body();
		assert.ok(fields.includes('Contact: mailto:security@ever.co'));
		assert.ok(fields.includes('Canonical: https://docs.ever.works/.well-known/security.txt'));
		assert.ok(fields.includes('Policy: https://github.com/ever-co/ever-works/security/policy'));
	});

	it('has an Expires date in the future (RFC 9116: renew it before it passes)', () => {
		const expires = body().find((field) => field.startsWith('Expires: '));
		assert.ok(expires, 'security.txt must have an Expires field');
		const when = new Date(expires.slice('Expires: '.length));
		assert.ok(!Number.isNaN(when.getTime()), `unparseable ${expires}`);
		assert.ok(when.getTime() > Date.now(), `${expires} has passed: renew it in ${nginxPath}`);
	});
});
