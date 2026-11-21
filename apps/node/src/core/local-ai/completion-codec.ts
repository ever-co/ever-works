import { gunzipSync, gzipSync } from 'node:zlib';
import { FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES, type FleetAiCompletionBodyEncoding } from '@ever-works/contracts';

/**
 * The `ai-completion` body codec on the node: JSON → gzip → base64 and back,
 * bounded on BOTH sides of the compression (the encoded size against the
 * contract's cap, the decoded size against the caller's), so a body can never
 * be inflated into more memory than the relay allows.
 *
 * Errors are one fixed-shape sentence: never a byte of the body.
 */

export class LocalAiCompletionCodecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LocalAiCompletionCodecError';
	}
}

/** `value` as an encoded body. Throws when the encoded body would not fit the contract's cap. */
export function encodeLocalAiCompletionBody(value: unknown): { body: string; bodyEncoding: 'gzip-base64' } {
	const json = JSON.stringify(value);
	const body = gzipSync(Buffer.from(json, 'utf8')).toString('base64');
	if (body.length > FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES) {
		throw new LocalAiCompletionCodecError(
			`the answer is ${Math.ceil(body.length / 1024)} KiB encoded — more than the ${
				FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES / 1024
			} KiB a completion carries back`
		);
	}
	return { body, bodyEncoding: 'gzip-base64' };
}

/** The JSON value an encoded body holds. Throws for anything over `maxBytes` decoded, or not JSON. */
export function decodeLocalAiCompletionBody(
	body: string,
	encoding: FleetAiCompletionBodyEncoding,
	maxBytes: number
): unknown {
	let text: string;
	if (encoding === 'json') {
		if (Buffer.byteLength(body, 'utf8') > maxBytes) {
			throw new LocalAiCompletionCodecError(`the request is larger than ${maxBytes} bytes`);
		}
		text = body;
	} else {
		let raw: Buffer;
		try {
			raw = gunzipSync(Buffer.from(body, 'base64'), { maxOutputLength: maxBytes });
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			throw new LocalAiCompletionCodecError(
				code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError
					? `the request is larger than ${maxBytes} bytes decoded`
					: 'the request body is not gzip-compressed'
			);
		}
		text = raw.toString('utf8');
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new LocalAiCompletionCodecError('the request body is not JSON');
	}
}
