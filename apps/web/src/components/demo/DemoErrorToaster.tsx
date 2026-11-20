'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { DEMO_ERROR_EVENT } from '@/lib/demo/demo-client-errors';
import type { DemoErrorKey } from '@/lib/demo/demo-errors';

/**
 * Shows the friendly `demo.errors.*` toast for a demo error a browser fetch reported
 * (`reportDemoErrorResponse`). Rendered only on a demo account; one toast per message, so
 * a burst of refused calls does not stack.
 */
export function DemoErrorToaster() {
    const t = useTranslations('demo.errors');

    useEffect(() => {
        const onError = (event: Event) => {
            const key = (event as CustomEvent<DemoErrorKey>).detail;
            toast.error(t(key), { id: `demo-error-${key}` });
        };
        window.addEventListener(DEMO_ERROR_EVENT, onError);
        return () => window.removeEventListener(DEMO_ERROR_EVENT, onError);
    }, [t]);

    return null;
}
