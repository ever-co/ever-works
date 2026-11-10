import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { MarkdownEditor } from './MarkdownEditor';

function Harness({ initial = '', maxLength }: { initial?: string; maxLength?: number }) {
    const [value, setValue] = useState(initial);
    return (
        <MarkdownEditor
            id="desc"
            label="Description"
            value={value}
            onChange={setValue}
            maxLength={maxLength}
            data-testid="editor"
        />
    );
}

describe('MarkdownEditor', () => {
    it('labels the textarea and links the hint through aria-describedby', () => {
        render(<Harness />);
        const textarea = screen.getByLabelText('Description');
        expect(textarea.tagName).toBe('TEXTAREA');
        expect(textarea.getAttribute('aria-describedby')).toContain('desc-hint');
        expect(document.getElementById('desc-hint')?.textContent).toBe('hint');
    });

    it('switches to a rendered Preview and back without losing the text', () => {
        render(<Harness />);
        fireEvent.change(screen.getByLabelText('Description'), {
            target: { value: '## Goal\n\n- **one**\n- two' },
        });
        fireEvent.click(screen.getByRole('tab', { name: 'preview' }));

        const preview = screen.getByTestId('editor-preview');
        expect(preview.hidden).toBe(false);
        expect(preview.querySelector('h4')?.textContent).toBe('Goal');
        expect(preview.querySelectorAll('li')).toHaveLength(2);
        expect(preview.querySelector('strong')?.textContent).toBe('one');
        expect(screen.getByRole('tab', { name: 'preview' }).getAttribute('aria-selected')).toBe(
            'true',
        );

        fireEvent.click(screen.getByRole('tab', { name: 'write' }));
        expect(screen.getByTestId('editor-preview').hidden).toBe(true);
        expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
            '## Goal\n\n- **one**\n- two',
        );
    });

    it('moves between the tabs with the arrow keys, Home and End (roving tabindex)', () => {
        render(<Harness initial="x" />);
        const write = screen.getByRole('tab', { name: 'write' });
        const preview = screen.getByRole('tab', { name: 'preview' });
        expect(write.tabIndex).toBe(0);
        expect(preview.tabIndex).toBe(-1);

        write.focus();
        fireEvent.keyDown(write, { key: 'ArrowRight' });
        expect(preview.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(preview);
        expect(preview.tabIndex).toBe(0);

        fireEvent.keyDown(preview, { key: 'Home' });
        expect(write.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(write);

        fireEvent.keyDown(write, { key: 'End' });
        expect(preview.getAttribute('aria-selected')).toBe('true');
        fireEvent.keyDown(preview, { key: 'ArrowLeft' });
        expect(write.getAttribute('aria-selected')).toBe('true');
    });

    it('says when there is nothing to preview', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('tab', { name: 'preview' }));
        expect(screen.getByTestId('editor-preview').textContent).toBe('emptyPreview');
    });

    it('shows a live counter and flags the field once it is over the limit', () => {
        render(<Harness initial="abc" maxLength={5} />);
        expect(document.getElementById('desc-counter')?.textContent).toBe(
            'counter:{"count":3,"max":5}',
        );
        const textarea = screen.getByLabelText('Description');
        expect(textarea.getAttribute('aria-invalid')).toBeNull();
        fireEvent.change(textarea, { target: { value: 'abcdefg' } });
        expect(textarea.getAttribute('aria-invalid')).toBe('true');
    });

    it('renders an error linked to the textarea', () => {
        render(
            <MarkdownEditor
                id="d2"
                label="Body"
                value=""
                onChange={() => {}}
                error="Enter a description."
            />,
        );
        const textarea = screen.getByLabelText('Body');
        expect(textarea.getAttribute('aria-describedby')).toContain('d2-error');
        expect(screen.getByRole('alert').textContent).toBe('Enter a description.');
    });
});
