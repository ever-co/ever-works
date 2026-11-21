import { gunzipSync, gzipSync } from 'node:zlib';
import {
    FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES,
    type FleetAiCompletionBodyEncoding,
} from '@ever-works/contracts';

/**
 * Local AI completions — the body codec on the platform side (the node has
 * its own twin): JSON → gzip → base64 and back, bounded on BOTH sides of the
 * compression, so a body is never inflated into more memory than the relay
 * allows. Errors are one fixed-shape sentence, never a byte of the body.
 */

export class FleetAiCompletionCodecError extends Error {
    constructor(
        /** `too-large` — over a bound; `invalid` — not gzip / not JSON. */
        readonly reason: 'too-large' | 'invalid',
        message: string,
    ) {
        super(message);
        this.name = 'FleetAiCompletionCodecError';
    }
}

/**
 * `value` as an encoded body. Refuses (`too-large`) a value whose JSON exceeds
 * `maxDecodedBytes`, and one that does not fit the contract's encoded cap even
 * compressed.
 */
export function encodeFleetAiCompletionBody(
    value: unknown,
    maxDecodedBytes: number,
): { body: string; bodyEncoding: 'gzip-base64'; decodedBytes: number } {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new FleetAiCompletionCodecError('invalid', 'the body is not JSON');
    }
    const raw = Buffer.from(json, 'utf8');
    if (raw.length > maxDecodedBytes) {
        throw new FleetAiCompletionCodecError(
            'too-large',
            `the request is ${kib(raw.length)} KiB — more than the ${kib(maxDecodedBytes)} KiB a local AI completion carries`,
        );
    }
    const body = gzipSync(raw).toString('base64');
    if (body.length > FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES) {
        throw new FleetAiCompletionCodecError(
            'too-large',
            `the request is ${kib(body.length)} KiB compressed — more than the ${kib(
                FLEET_AI_COMPLETION_MAX_ENCODED_BODY_BYTES,
            )} KiB a local AI completion carries (shorten the context)`,
        );
    }
    return { body, bodyEncoding: 'gzip-base64', decodedBytes: raw.length };
}

/** The JSON value an encoded body holds. Throws for anything over `maxBytes` decoded, or not JSON. */
export function decodeFleetAiCompletionBody(
    body: string,
    encoding: FleetAiCompletionBodyEncoding,
    maxBytes: number,
): unknown {
    let text: string;
    if (encoding === 'json') {
        if (Buffer.byteLength(body, 'utf8') > maxBytes) {
            throw new FleetAiCompletionCodecError(
                'too-large',
                `the body is larger than ${maxBytes} bytes`,
            );
        }
        text = body;
    } else {
        let raw: Buffer;
        try {
            raw = gunzipSync(Buffer.from(body, 'base64'), { maxOutputLength: maxBytes });
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
                throw new FleetAiCompletionCodecError(
                    'too-large',
                    `the body is larger than ${maxBytes} bytes decoded`,
                );
            }
            throw new FleetAiCompletionCodecError('invalid', 'the body is not gzip-compressed');
        }
        text = raw.toString('utf8');
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new FleetAiCompletionCodecError('invalid', 'the body is not JSON');
    }
}

function kib(bytes: number): number {
    return Math.ceil(bytes / 1024);
}
