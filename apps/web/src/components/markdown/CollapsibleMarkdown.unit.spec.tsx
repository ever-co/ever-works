import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { CollapsibleMarkdown } from './CollapsibleMarkdown';

/** jsdom does no layout: pretend the rendered content is `height` px tall. */
function stubScrollHeight(height: number) {
    return vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('CollapsibleMarkdown', () => {
    it('renders short content in full, without a toggle', () => {
        stubScrollHeight(40);
        render(<CollapsibleMarkdown content={'Short **mission**.'} data-testid="desc" />);
        expect(screen.getByTestId('desc').querySelector('strong')?.textContent).toBe('mission');
        expect(screen.queryByRole('button')).toBeNull();
        expect(
            screen
                .getByTestId('desc')
                .querySelector('[data-collapsed]')
                ?.getAttribute('data-collapsed'),
        ).toBe('false');
    });

    it('clamps long content and toggles it with an accessible Show more / Show less button', () => {
        stubScrollHeight(900);
        render(
            <CollapsibleMarkdown
                content={'## Plan\n\n' + '- step\n'.repeat(40)}
                collapsedHeight={100}
                data-testid="desc"
            />,
        );
        const region = screen.getByTestId('desc').querySelector<HTMLElement>('[data-collapsed]')!;
        const toggle = screen.getByRole('button', { name: 'showMore' });
        expect(region.getAttribute('data-collapsed')).toBe('true');
        expect(region.style.maxHeight).toBe('100px');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.getAttribute('aria-controls')).toBe(region.id);

        fireEvent.click(toggle);
        expect(region.getAttribute('data-collapsed')).toBe('false');
        expect(region.style.maxHeight).toBe('');
        expect(screen.getByRole('button', { name: 'showLess' }).getAttribute('aria-expanded')).toBe(
            'true',
        );

        fireEvent.click(screen.getByRole('button', { name: 'showLess' }));
        expect(region.getAttribute('data-collapsed')).toBe('true');
    });

    it('does not clamp content only slightly taller than the collapsed height', () => {
        // 110px against a 100px clamp: hiding one line behind "Show more" is worse than showing it.
        stubScrollHeight(110);
        render(
            <CollapsibleMarkdown
                content={'a\n\nb\n\nc'}
                collapsedHeight={100}
                data-testid="desc"
            />,
        );
        expect(screen.queryByRole('button')).toBeNull();
    });
});
