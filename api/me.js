// api/me.js
//
// GET -> who is this, what role do they have, which tenant (if any) are
// they locked to. The dashboard needs this before it can decide whether
// to show a tenant switcher, the admin panel, or just one tenant's data.

import { supabaseAdmin, verifyAuth } from '../lib/auth-check.js';

const ALLOWED_ORIGINS = ['https://reysan.ca'];

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).end();
    }

    const auth = await verifyAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    if (auth.role === 'super_admin') {
        return res.status(200).json({ role: 'super_admin', tenant: null });
    }

    const { data: tenant } = await supabaseAdmin.from('tenants').select('*').eq('id', auth.tenantId).single();
    return res.status(200).json({ role: 'tenant_admin', tenant });
} 
