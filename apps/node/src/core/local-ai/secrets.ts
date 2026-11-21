import { readFile, stat } from 'node:fs/promises';
import type { LocalAiApiKeyRef } from './types';

/**
 * Reading a local provider's API key — at use time, every time.
 *
 * Read per probe and per run rather than once at startup, so an operator who
 * rotates the key (writes a new file, or restarts with a new env value) is
 * picked up without a restart, and the value lives in memory only while a
 * request or a run needs it.
 *
 * Every error names WHERE the key was looked for (a path, an env var name) and
 * what was wrong, and never a byte of what was found.
 */

/** Largest key file the node reads. A real key is tens of bytes. */
export const LOCAL_AI_MAX_KEY_BYTES = 4096;

export class LocalAiSecretError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LocalAiSecretError';
	}
}

/** How keys are read. Injected so tests never touch a disk or the real environment. */
export interface LocalAiSecretIo {
	/** The file's contents, or null when it does not exist. Rejects for any other failure. */
	readKeyFile(path: string): Promise<string | null>;
	/** Where `apiKeyEnv` names are looked up — the node's own process environment. */
	env: Readonly<Record<string, string | undefined>>;
}

/**
 * The key `ref` points at, trimmed, or null for a keyless provider.
 *
 * Refused (throws {@link LocalAiSecretError}) when the file or variable is
 * missing, empty, too large, or holds whitespace or a control character inside
 * the key — the value goes into an HTTP header and an environment variable,
 * where a newline would split it into something else.
 */
export async function readLocalAiApiKey(ref: LocalAiApiKeyRef | null, io: LocalAiSecretIo): Promise<string | null> {
	if (!ref) return null;
	let raw: string | null | undefined;
	let where: string;
	if (ref.source === 'file') {
		where = `the API key file ${ref.path}`;
		try {
			raw = await io.readKeyFile(ref.path);
		} catch (error) {
			const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
			if (code === 'LOCAL_AI_KEY_TOO_LARGE') {
				throw new LocalAiSecretError(
					`${where} is larger than ${LOCAL_AI_MAX_KEY_BYTES} bytes — is it the right file?`
				);
			}
			throw new LocalAiSecretError(
				`${where} could not be read${typeof code === 'string' && /^[A-Z_]{2,32}$/.test(code) ? ` (${code})` : ''}`
			);
		}
		if (raw === null) throw new LocalAiSecretError(`${where} does not exist`);
	} else {
		where = `the environment variable ${ref.name}`;
		raw = lookupEnv(io.env, ref.name);
		if (raw === undefined) throw new LocalAiSecretError(`${where} is not set`);
	}
	const key = raw.trim();
	if (!key) throw new LocalAiSecretError(`${where} is empty`);
	if (key.length > LOCAL_AI_MAX_KEY_BYTES) {
		throw new LocalAiSecretError(`${where} is larger than ${LOCAL_AI_MAX_KEY_BYTES} bytes — is it the right one?`);
	}
	// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
	if (/[\s\u0000-\u001f\u007f]/.test(key)) {
		throw new LocalAiSecretError(
			`${where} holds more than one word or a control character; it must hold only the key`
		);
	}
	return key;
}

/** Case-insensitive lookup (Windows env names are), exact spelling first. */
function lookupEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
	if (typeof env[name] === 'string') return env[name];
	const upper = name.toUpperCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toUpperCase() === upper && typeof value === 'string') return value;
	}
	return undefined;
}

/** The real key-file reader: refuses anything that is not a small regular file. */
export async function readKeyFileFromDisk(path: string): Promise<string | null> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	if (!info.isFile()) {
		throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
	}
	if (info.size > LOCAL_AI_MAX_KEY_BYTES) {
		throw Object.assign(new Error('key file too large'), { code: 'LOCAL_AI_KEY_TOO_LARGE' });
	}
	return readFile(path, 'utf8');
}
