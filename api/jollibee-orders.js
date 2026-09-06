// api/jollibee-orders.js
//
// GET  -> list orders for this tenant, joined with customer name/phone
// PATCH -> update an order's status/eta; on accept, logs a mock SMS
//          (no real Twilio wired up yet, this just records what WOULD be sent)

const { createClient } = require('@supabase/supabase-js');
const { verifyAuth } = require('./auth-check');

const TENANT_SLUG = 'jollibee';
const ALLOWED_ORIGINS = ['https://reysan.ca'];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async (req, res) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

    const auth = await verifyAuth(req, TENANT_SLUG);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });

    const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', TENANT_SLUG).single();
    if (!tenant) return res.status(500).json({ error: 'Configuration error' });

    if (req.method === 'GET') {
        const { data, error } = await supabase
            .from('orders')
            .select('*, customers(name, phone, area_code_flag, phone_verified)')
            .eq('tenant_id', tenant.id)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ orders: data });
    }

    if (req.method === 'PATCH') {
        const { order_id, status, eta_minutes } = req.body;
        if (!order_id || !status) return res.status(400).json({ error: 'order_id and status are required' });

        const update = { status, updated_at: new Date().toISOString() };
        if (eta_minutes !== undefined) update.eta_minutes = eta_minutes;

        const { data: order, error } = await supabase
            .from('orders')
            .update(update)
            .eq('id', order_id)
            .eq('tenant_id', tenant.id)
            .select('*, customers(name, phone)')
            .single();
        if (error) return res.status(500).json({ error: error.message });

        // On accept: log a mock SMS. status is 'mock_sent' so it's obvious in
        // the data this was never actually texted — swap this block out for a
        // real Twilio call later without touching anything else here.
        if (status === 'accepted' && eta_minutes) {
            const message = `Hi ${order.customers.name}, your Jollibee order has been received! It'll be ready for pickup in about ${eta_minutes} minutes.`;
            await supabase.from('notifications').insert({
                tenant_id: tenant.id,
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
};