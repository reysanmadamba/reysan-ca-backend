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
            .select('*, customers(id, name, phone, area_code_flag, phone_verified, banned)')
            .eq('tenant_id', resolved.tenantId)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) return res.status(500).json({ error: error.message });

        const { data: banned, error: bannedErr } = await supabaseAdmin
            .from('customers')
            .select('id, name, phone')
            .eq('tenant_id', resolved.tenantId)
            .eq('banned', true);
        if (bannedErr) return res.status(500).json({ error: bannedErr.message });

        return res.status(200).json({ orders: data, banned_customers: banned });
    }

    if (req.method === 'PATCH') {
        const { order_id, status, eta_minutes, needs_attention, attention_note, ban_customer_id, unban_customer_id, tenant_id } = req.body;
        const resolved = resolveTenantId(auth, tenant_id);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        // Ban/unban a customer — doesn't touch the orders table at all, so
        // handle it before the order_id requirement below applies.
        if (ban_customer_id || unban_customer_id) {
            const customerId = ban_customer_id || unban_customer_id;
            const { error: banErr } = await supabaseAdmin
                .from('customers')
                .update({ banned: !!ban_customer_id })
                .eq('id', customerId)
                .eq('tenant_id', resolved.tenantId);
            if (banErr) return res.status(500).json({ error: banErr.message });
            return res.status(200).json({ ok: true });
        }

        if (!order_id) return res.status(400).json({ error: 'order_id is required' });
        if (status === undefined && needs_attention === undefined) {
            return res.status(400).json({ error: 'status or needs_attention is required' });
        }

        const update = { updated_at: new Date().toISOString() };
        if (status !== undefined) update.status = status;
        if (eta_minutes !== undefined) update.eta_minutes = eta_minutes;
        if (needs_attention !== undefined) update.needs_attention = needs_attention;
        if (attention_note !== undefined) update.attention_note = attention_note;
        if (status === 'accepted') update.accepted_at = new Date().toISOString();

        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .update(update)
            .eq('id', order_id)
            .eq('tenant_id', resolved.tenantId) // can't touch another tenant's order even by guessing an id
            .select('*, customers(id, name, phone, area_code_flag, phone_verified, banned)')
            .single();
        if (error) return res.status(500).json({ error: error.message });

        if (status === 'accepted' && eta_minutes) {
            const message = `Hi ${order.customers.name}, your order has been received! It'll be ready for pickup in about ${eta_minutes} minutes. Our crew may call you if we have any questions about your order.`;
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