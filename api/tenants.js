// api/tenants.js
//
// GET  -> list all tenants (super_admin only)
// POST -> create a new tenant (super_admin only)
// PUT  -> assign an existing account (created manually in Supabase) to a
//         tenant with a role (super_admin only) — merged in from what was
//         assign-tenant.js, to stay under Vercel's 12-function Hobby limit

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

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).end();
    }

    const auth = await verifyAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (auth.role !== 'super_admin') return res.status(403).json({ error: 'Super admin access required' });

    if (req.method === 'GET') {
        const { data, error } = await supabaseAdmin.from('tenants').select('*').order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ tenants: data });
    }

    if (req.method === 'POST') {
        const { slug, name, vertical } = req.body;
        if (!slug || !name) return res.status(400).json({ error: 'slug and name are required' });

        const { data, error } = await supabaseAdmin
            .from('tenants')
            .insert({ slug, name, vertical: vertical || 'generic' })
            .select()
            .single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ tenant: data });
    }

    if (req.method === 'PUT') {
        const { email, tenant_id, role } = req.body;
        if (!email || !tenant_id || !role) return res.status(400).json({ error: 'email, tenant_id, and role are required' });
        if (!['tenant_admin', 'super_admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

        try {
            const user = await findUserByEmail(email);
            if (!user) return res.status(404).json({ error: 'No account found with that email. Create it in Supabase first.' });

            const { data, error } = await supabaseAdmin
                .from('tenant_users')
                .upsert({ user_id: user.id, tenant_id: role === 'super_admin' ? null : tenant_id, role }, { onConflict: 'user_id' })
                .select()
                .single();
            if (error) return res.status(500).json({ error: error.message });

            return res.status(200).json({ assignment: data });
        } catch (err) {
            console.error('assign error', err);
            return res.status(500).json({ error: 'Something went wrong.' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}