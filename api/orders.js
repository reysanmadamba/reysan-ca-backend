// api/orders.js
//
// GET  -> list orders for the caller's tenant (tenant_admin) or a specified
//         tenant (super_admin, via ?tenant_id=)
// PATCH -> update an order's status/eta; on accept, logs a mock SMS

import { supabaseAdmin, verifyAuth, resolveTenantId } from '../lib/auth-check.js';

const ALLOWED_ORIGINS = ['https://reysan.ca'];

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).end();
    }

    const auth = await verifyAuth(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    if (req.method === 'GET') {
        const resolved = resolveTenantId(auth, req.query.tenant_id);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        const { data, error } = await supabaseAdmin
            .from('orders')
            .select('*, customers(name, phone, area_code_flag, phone_verified)')
            .eq('tenant_id', resolved.tenantId)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ orders: data });
    }

    if (req.method === 'PATCH') {
        const { order_id, status, eta_minutes, tenant_id } = req.body;
        if (!order_id || !status) return res.status(400).json({ error: 'order_id and status are required' });

        const resolved = resolveTenantId(auth, tenant_id);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        const update = { status, updated_at: new Date().toISOString() };
        if (eta_minutes !== undefined) update.eta_minutes = eta_minutes;

        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .update(update)
            .eq('id', order_id)
            .eq('tenant_id', resolved.tenantId) // can't touch another tenant's order even by guessing an id
            .select('*, customers(name, phone)')
            .single();
        if (error) return res.status(500).json({ error: error.message });

        if (status === 'accepted' && eta_minutes) {
            const message = `Hi ${order.customers.name}, your order has been received! It'll be ready for pickup in about ${eta_minutes} minutes.`;
            await supabaseAdmin.from('notifications').insert({
                tenant_id: resolved.tenantId,
                customer_id: order.customer_id,
                order_id: order.id,
                channel: 'sms',
                message,
                status: 'mock_sent'
            });
        }

        return res.status(200).json({ order });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}