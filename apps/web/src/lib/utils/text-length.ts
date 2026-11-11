const PRESENTATION_SEQUENCE = /[^️︎][️︎]/g;
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/**
 * A string's length the way the API's validators measure it.
 *
 * class-validator's `@MaxLength` / `@MinLength` call validator.js `isLength`,
 * which counts UTF-16 units minus surrogate pairs (an emoji outside the BMP
 * counts once) and minus variation selectors that follow a character (`❤️`
 * counts once). `String.length` would count both twice, so a counter or a
 * client-side check built on it refuses text the API accepts. Same two
 * patterns as validator.js 13, both linear.
 */
export function validatorLength(text: string): number {
    const presentation = text.match(PRESENTATION_SEQUENCE)?.length ?? 0;
    const surrogates = text.match(SURROGATE_PAIR)?.length ?? 0;
    return text.length - presentation - surrogates;
}
