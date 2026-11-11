import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

/**
 * Stand-in parser: `parse-error` throws while parsing (like the stack overflow
 * in PR #3137 review B1), `render-error` parses fine but returns a tree whose
 * component throws while React renders it.
 */
function Exploding(): never {
    throw new Error('render failed');
}
vi.mock('react-markdown', () => ({
    default: (options: { children: string }) => {
        if (options.children === 'parse-error')
            throw new RangeError('Maximum call stack size exceeded');
        if (options.children === 'render-error') return <Exploding />;
        return <p>{options.children}</p>;
    },
}));

import { MarkdownContent, MarkdownInline } from './MarkdownContent';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('MarkdownContent — an unforeseen parser failure never takes the page down', () => {
    it('a parse that throws falls back to plain text on the client', () => {
        const { getByTestId } = render(<MarkdownContent content="parse-error" data-testid="md" />);
        const root = getByTestId('md');
        expect(root.querySelector('[data-markdown-fallback]')).not.toBeNull();
        expect(root.querySelector('pre')?.textContent).toBe('parse-error');
    });

    it('a parse that throws falls back on the server too (no error boundary runs there)', () => {
        const html = renderToString(<MarkdownContent content="parse-error" />);
        expect(html).toContain('data-markdown-fallback');
        expect(html).toContain('parse-error');
    });

    it('a component that throws while rendering is caught by the error boundary', () => {
        // React reports the caught error to the console; keep the output clean.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { getByTestId } = render(<MarkdownContent content="render-error" data-testid="md" />);
        expect(getByTestId('md').querySelector('[data-markdown-fallback]')).not.toBeNull();
    });

    it('the boundary gives new content a fresh attempt', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { getByTestId, rerender } = render(
            <MarkdownContent content="render-error" data-testid="md" />,
        );
        expect(getByTestId('md').querySelector('[data-markdown-fallback]')).not.toBeNull();
        rerender(<MarkdownContent content="fine now" data-testid="md" />);
        expect(getByTestId('md').querySelector('[data-markdown-fallback]')).toBeNull();
        expect(getByTestId('md').textContent).toBe('fine now');
    });

    it('MarkdownInline has the same two nets', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(render(<MarkdownInline content="parse-error" />).container.textContent).toBe(
            'parse-error',
        );
        expect(render(<MarkdownInline content="render-error" />).container.textContent).toBe(
            'render-error',
        );
    });
});
