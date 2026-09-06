// api/auth-check.js
//
// Shared by any dashboard-facing endpoint. Verifies the logged-in user's
// Supabase Auth session, then checks tenant_users for their role. A
// tenant_admin can only ever act on their own tenant; a super_admin can
// act on any tenant.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function verifyAuth(req, requiredTenantSlug) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return { error: 'Missing authorization token', status: 401 };

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return { error: 'Invalid or expired session', status: 401 };

    const { data: tenantUser, error: tuErr } = await supabase
        .from('tenant_users')
        .select('role, tenant_id')
        .eq('user_id', userData.user.id)
        .maybeSingle();
    if (tuErr || !tenantUser) return { error: 'No dashboard access configured for this account', status: 403 };

    if (tenantUser.role === 'super_admin') {
        return { role: 'super_admin', tenantId: null, userId: userData.user.id };
    }

    const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', requiredTenantSlug).single();
    if (!tenant || tenantUser.tenant_id !== tenant.id) {
        return { error: 'Not authorized for this tenant', status: 403 };
    }

    return { role: 'tenant_admin', tenantId: tenant.id, userId: userData.user.id };
}

module.exports = { verifyAuth };