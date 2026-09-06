// api/menu.js
//
// GET    -> list menu items for the tenant
// POST   -> add a new item
// PATCH  -> edit an existing item
// DELETE -> remove an item (hard delete — remove/soft-delete tradeoff is a
//           later decision; fine for a demo/early stage)

import { supabaseAdmin, verifyAuth, resolveTenantId } from './auth-check.js';

const ALLOWED_ORIGINS = ['https://reysan.ca'];

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).end();
    }

    const auth = await verifyAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    if (req.method === 'GET') {
        const resolved = resolveTenantId(auth, req.query.tenant_id);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        const { data, error } = await supabaseAdmin
            .from('menu_items')
            .select('*')
            .eq('tenant_id', resolved.tenantId)
            .order('category')
            .order('name');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ items: data });
    }

    if (req.method === 'POST') {
        const { tenant_id, category, name, description, price, popular, spicy, allergens, veg } = req.body;
        const resolved = resolveTenantId(auth, tenant_id);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
        if (!category || !name || price === undefined) {
            return res.status(400).json({ error: 'category, name, and price are required' });
        }

        const { data, error } = await supabaseAdmin
            .from('menu_items')
            .insert({
                tenant_id: resolved.tenantId,
                category,
                name,
                description: description || null,
                price,
                popular: !!popular,
                spicy: !!spicy,
                allergens: allergens || [],
                veg: !!veg
            })
            .select()
            .single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ item: data });
    }

    if (req.method === 'PATCH') {
        const { id, tenant_id, ...fields } = req.body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const resolved = resolveTenantId(auth, tenant_id);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        const { data, error } = await supabaseAdmin
            .from('menu_items')
            .update(fields)
            .eq('id', id)
            .eq('tenant_id', resolved.tenantId)
            .select()
            .single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ item: data });
    }

    if (req.method === 'DELETE') {
        const { id, tenant_id } = req.body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const resolved = resolveTenantId(auth, tenant_id);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        const { error } = await supabaseAdmin.from('menu_items').delete().eq('id', id).eq('tenant_id', resolved.tenantId);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}