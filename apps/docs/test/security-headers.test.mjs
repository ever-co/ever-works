/**
 * docs.ever.works sends the security headers every Ever website sends (the ever.co baseline) and
 * answers /.well-known/security.txt (RFC 9116), both from the docs image's nginx.conf.
 *
 * nginx drops every server-level `add_header` in a location that sets an `add_header` of its own,
 * so a new Cache-Control location silently strips the security headers from the files it serves.
 * These checks keep the set on the server block AND on every location that adds a header, keep the
 * nginx version out of the Server header, and fail once security.txt's Expires date has passed.
 *
 * This reads the config; it does not start nginx. The image build and the live checks after a
 * deploy (curl -I) cover the served responses.
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

/** Header name (lower case) -> the value every response must carry. All are sent with `always`. */
const SECURITY_HEADERS = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'x-frame-options': 'SAMEORIGIN',
	'content-security-policy': "base-uri 'self'; object-src 'none'; frame-ancestors 'self'",
	'permissions-policy': 'camera=(), geolocation=(), microphone=()'
};

/** A quoted nginx string body: anything but an unescaped quote. */
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;

/** `line` without its `#` comment; a `#` inside a quoted string is not a comment. */
function stripComment(line) {
	let quote;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '\\') i++;
		else if (quote) {
			if (ch === quote) quote = undefined;
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '#') return line.slice(0, i);
	}
	return line;
}

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
		const line = stripComment(raw).trim().replace(/\s+/g, ' ');
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

/** The `add_header` directives of a block: lower-case name -> { value, always }. */
function addHeaders(lines) {
	const headers = new Map();
	const re = new RegExp(String.raw`^add_header (\S+) ${QUOTED}( always)? ?;$`);
	for (const line of lines) {
		const m = re.exec(line);
		if (m) headers.set(m[1].toLowerCase(), { value: m[2], always: Boolean(m[3]) });
	}
	return headers;
}

function assertSecurityHeaders(lines, where) {
	const headers = addHeaders(lines);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		const got = headers.get(name);
		assert.ok(got, `${where} must add_header ${name}`);
		assert.equal(got.value, value, `${where}: ${name}`);
		assert.ok(got.always, `${where}: add_header ${name} needs \`always\` (else 3xx/4xx responses lack it)`);
	}
}

const { server, locations } = parseBlocks(nginx);

describe('docs.ever.works nginx.conf sends the security headers', () => {
	it('sets the full set at server level', () => {
		assertSecurityHeaders(server, `${nginxPath} server block`);
	});

	it('repeats the full set in every location that adds a header of its own', () => {
		const adding = locations.filter((l) => l.lines.some((line) => line.startsWith('add_header ')));
		for (const location of adding) {
			assertSecurityHeaders(location.lines, `\`${location.name}\` (sets its own add_header)`);
		}
	});

	it('turns server_tokens off', () => {
		assert.ok(server.includes('server_tokens off;'), `${nginxPath} must contain \`server_tokens off;\``);
	});
});

describe('docs.ever.works serves /.well-known/security.txt', () => {
	const location = locations.find((l) => l.name === 'location = /.well-known/security.txt');
	/** The fields of the `return 200 "..."` body. nginx turns each `\n` in a quoted string into a newline. */
	const fields = () => {
		const re = new RegExp(String.raw`^return 200 ${QUOTED};$`);
		const m = location.lines.map((line) => re.exec(line)).find(Boolean);
		assert.ok(m, 'the security.txt location must `return 200 "<body>";`');
		return m[1].split('\\n');
	};

	it('has an exact-match location answered as text/plain', () => {
		assert.ok(location, `${nginxPath} must have \`location = /.well-known/security.txt\``);
		assert.ok(location.lines.includes('default_type text/plain;'));
	});

	it('lists Contact, Canonical and Policy', () => {
		const body = fields();
		assert.ok(body.includes('Contact: mailto:security@ever.co'));
		assert.ok(body.includes('Canonical: https://docs.ever.works/.well-known/security.txt'));
		assert.ok(body.includes('Policy: https://github.com/ever-co/ever-works/security/policy'));
	});

	it('has an Expires date in the future (RFC 9116: renew it before it passes)', () => {
		const expires = fields().find((field) => field.startsWith('Expires: '));
		assert.ok(expires, 'security.txt must have an Expires field');
		const when = new Date(expires.slice('Expires: '.length));
		assert.ok(!Number.isNaN(when.getTime()), `unparseable ${expires}`);
		assert.ok(when.getTime() > Date.now(), `${expires} has passed: renew it in ${nginxPath}`);
	});
});
