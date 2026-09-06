// api/auth-check.js
//
// Shared by every dashboard-facing endpoint. Verifies the logged-in user's
// Supabase Auth session, then checks tenant_users for their role.
//
//   super_admin -> tenantId is null here; caller must resolve which tenant
//                  they want via resolveTenantId() below.
//   tenant_admin -> locked to exactly the tenant in tenant_users, can never
//                   act on any other tenant's data.

import { createClient } from '@supabase/supabase-js';

export const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function verifyAuth(req) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return { error: 'Missing authorization token', status: 401 };

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return { error: 'Invalid or expired session', status: 401 };

    const { data: tenantUser, error: tuErr } = await supabaseAdmin
        .from('tenant_users')
        .select('role, tenant_id')
        .eq('user_id', userData.user.id)
        .maybeSingle();
    if (tuErr || !tenantUser) return { error: 'No dashboard access configured for this account', status: 403 };

    return {
        role: tenantUser.role,
        tenantId: tenantUser.role === 'super_admin' ? null : tenantUser.tenant_id,
        userId: userData.user.id
    };
}

// Resolves which tenant an already-authenticated request should act on.
//   - tenant_admin: always their own tenant, regardless of what's passed in.
//   - super_admin: must explicitly pass tenant_id (query param on GET,
//     body field on POST/PATCH) since they aren't locked to one.
export function resolveTenantId(auth, requestedTenantId) {
    if (auth.role === 'tenant_admin') return { tenantId: auth.tenantId };
    if (auth.role === 'super_admin') {
        if (!requestedTenantId) return { error: 'tenant_id is required for super_admin requests', status: 400 };
        return { tenantId: requestedTenantId };
    }
    return { error: 'Unrecognized role', status: 403 };
}