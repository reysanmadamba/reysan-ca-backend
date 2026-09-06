// api/tenants.js
//
// GET    ?id absent  -> list active tenants
//        ?id=<uuid>  -> one tenant's full detail: profile, assigned admins
//                       (with email looked up), and usage stats
// POST   -> create a tenant, with CRM fields
// PUT    -> assign an existing account (created manually in Supabase) to
//           a tenant with a role
// PATCH  -> update a tenant's fields, including soft-delete via active:false
// DELETE -> unassign an admin from a tenant (removes their tenant_users row)
//
// Kept as one file (not split into separate endpoints) to stay under
// Vercel's 12-function Hobby plan limit.

import { supabaseAdmin, verifyAuth } from '../lib/auth-check.js';

const ALLOWED_ORIGINS = ['https://reysan.ca'];

async function findUserByEmail(email) {
    let page = 1;
    while (true) {
        const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (found) return found;
        if (data.users.length < 200) return null;
        page++;
    }
}

async function getTenantDetail(tenantId) {
    const { data: tenant, error: tenantErr } = await supabaseAdmin.from('tenants').select('*').eq('id', tenantId).single();
    if (tenantErr) throw tenantErr;

    const { data: tenantUsers, error: tuErr } = await supabaseAdmin
        .from('tenant_users')
        .select('id, user_id, role')
        .eq('tenant_id', tenantId);
    if (tuErr) throw tuErr;

    // Fixed N+1: one listUsers() call instead of one getUserById() per admin.
    // This was the actual cause of the 2-3s delay opening a tenant's detail page.
    const { data: userList } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const emailById = new Map((userList?.users || []).map((u) => [u.id, u.email]));

    const admins = tenantUsers.map((tu) => ({
        tenant_user_id: tu.id,
        user_id: tu.user_id,
        role: tu.role,
        email: emailById.get(tu.user_id) || 'unknown'
    }));

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: totalOrders } = await supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);

    const { count: ordersLast7d } = await supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('created_at', weekAgo);

    const { data: lastOrder } = await supabaseAdmin
        .from('orders')
        .select('created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    return {
        tenant,
        admins,
        stats: {
            total_orders: totalOrders || 0,
            orders_last_7_days: ordersLast7d || 0,
            last_order_at: lastOrder?.created_at || null
        }
    };
}

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).end();
    }

    const auth = await verifyAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (auth.role !== 'super_admin') return res.status(403).json({ error: 'Super admin access required' });

    try {
        if (req.method === 'GET') {
            if (req.query.id) {
                const detail = await getTenantDetail(req.query.id);
                return res.status(200).json(detail);
            }
            if (req.query.include_inactive === 'true') {
                const { data, error } = await supabaseAdmin.from('tenants').select('*').order('created_at', { ascending: false });
                if (error) return res.status(500).json({ error: error.message });
                return res.status(200).json({ tenants: data });
            }

            const { data, error } = await supabaseAdmin
                .from('tenants')
                .select('*')
                .eq('active', true)
                .order('created_at', { ascending: false });
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ tenants: data });
        }

        if (req.method === 'POST') {
            const { slug, name, vertical, subscription_tier, company_name, address, contact_email, contact_phone } = req.body;
            if (!slug || !name) return res.status(400).json({ error: 'slug and name are required' });

            const { data, error } = await supabaseAdmin
                .from('tenants')
                .insert({
                    slug,
                    name,
                    vertical: vertical || 'generic',
                    subscription_tier: subscription_tier || 'trial',
                    company_name: company_name || null,
                    address: address || null,
                    contact_email: contact_email || null,
                    contact_phone: contact_phone || null
                })
                .select()
                .single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ tenant: data });
        }

        if (req.method === 'PUT') {
            const { email, tenant_id, role } = req.body;
            if (!email || !tenant_id || !role) return res.status(400).json({ error: 'email, tenant_id, and role are required' });
            if (!['tenant_admin', 'super_admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

            const user = await findUserByEmail(email);
            if (!user) return res.status(404).json({ error: 'No account found with that email. Create it in Supabase first.' });

            const { data, error } = await supabaseAdmin
                .from('tenant_users')
                .upsert({ user_id: user.id, tenant_id: role === 'super_admin' ? null : tenant_id, role }, { onConflict: 'user_id' })
                .select()
                .single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ assignment: data });
        }

        if (req.method === 'PATCH') {
            const { id, ...fields } = req.body;
            if (!id) return res.status(400).json({ error: 'id is required' });

            const { data, error } = await supabaseAdmin.from('tenants').update(fields).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ tenant: data });
        }

        if (req.method === 'DELETE') {
            const { tenant_user_id } = req.body;
            if (!tenant_user_id) return res.status(400).json({ error: 'tenant_user_id is required' });

            const { error } = await supabaseAdmin.from('tenant_users').delete().eq('id', tenant_user_id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('tenants.js error', err);
        return res.status(500).json({ error: 'Something went wrong.' });
    }
}