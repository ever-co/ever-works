/**
 * The prompt the generator form opens with.
 *
 * Normally the last request's prompt, else the prompt the Work was first created
 * with. On a demo instance the seeded draft directory Work has neither — it was
 * never generated, and its prompt lives in `work.description` — so, and only
 * there, a never-generated Work falls back to its description. With demo off the
 * result is exactly the old `lastPrompt || initialPrompt || ''`.
 */
export function resolveInitialPrompt(input: {
    lastPrompt?: string;
    initialPrompt?: string;
    workDescription?: string | null;
    isGenerated: boolean;
    demoMode: boolean;
}): string {
    const recorded = input.lastPrompt || input.initialPrompt || '';
    if (recorded || !input.demoMode || input.isGenerated) {
        return recorded;
    }
    return input.workDescription || '';
}
