// api/tenants.js
//
// GET  -> list all tenants (super_admin only)
// POST -> create a new tenant (super_admin only)

import { supabaseAdmin, verifyAuth } from '../lib/auth-check.js';

const ALLOWED_ORIGINS = ['https://reysan.ca'];

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    return res.status(405).json({ error: 'Method not allowed' });
}