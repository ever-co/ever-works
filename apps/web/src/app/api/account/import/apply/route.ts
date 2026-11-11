import { handleAccountImport } from '@/lib/account/account-import-route';

/** Account import (apply) — see `handleAccountImport` (large bodies, not a server action). */
export async function POST(request: Request) {
    return handleAccountImport(request, 'apply');
}
