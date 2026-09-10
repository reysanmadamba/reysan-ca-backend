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

async function getTenantDetail(tenantId, dateFrom, dateTo) {
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

  // Usage/cost for a custom date range — defaults to the last 30 days if
  // none given. Aggregated here in JS rather than a DB function, since
  // volume at this scale doesn't need it yet.
  const rangeStart = dateFrom || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rangeEnd = dateTo || now.toISOString();
  const { data: usageRows } = await supabaseAdmin
    .from('chat_logs')
    .select('created_at, cost_usd')
    .eq('tenant_id', tenantId)
    .gte('created_at', rangeStart)
    .lt('created_at', rangeEnd);

  const rows = usageRows || [];
  const totalCost = rows.reduce((sum, r) => sum + Number(r.cost_usd || 0), 0);
  const totalMessages = rows.length;

  // Bucket by day across the selected range, oldest first.
  const dailyMap = new Map();
  const dayCursor = new Date(rangeStart);
  const dayEnd = new Date(rangeEnd);
  while (dayCursor < dayEnd) {
    const key = dayCursor.toISOString().slice(0, 10);
    dailyMap.set(key, { date: key, cost: 0, messages: 0 });
    dayCursor.setDate(dayCursor.getDate() + 1);
  }
  rows.forEach((r) => {
    const day = r.created_at.slice(0, 10);
    const bucket = dailyMap.get(day);
    if (bucket) {
      bucket.cost += Number(r.cost_usd || 0);
      bucket.messages += 1;
    }
  });

  return {
    tenant,
    admins,
    users: (userList?.users || []).map((u) => ({ id: u.id, email: u.email })),
    stats: {
      total_orders: totalOrders || 0,
      orders_last_7_days: ordersLast7d || 0
    },
    usage: {
      total_cost_usd: totalCost,
      total_messages: totalMessages,
      daily: Array.from(dailyMap.values())
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

  // Carve-out: a tenant_admin may fetch their OWN detail/usage report (used
  // by their dashboard's Reports tab), but nothing else here — every other
  // route (listing all tenants, creating/assigning, platform revenue, etc.)
  // stays super_admin only. Force the id to their own tenant regardless of
  // what was requested, so they can never pass someone else's.
  if (auth.role === 'tenant_admin' && req.method === 'GET' && !req.query.plans && !req.query.revenue_report && !req.query.subscription_history && !req.query.include_inactive) {
    try {
      const detail = await getTenantDetail(auth.tenantId, req.query.date_from, req.query.date_to);
      return res.status(200).json(detail);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (auth.role !== 'super_admin') return res.status(403).json({ error: 'Super admin access required' });

  try {
    if (req.method === 'GET') {
      if (req.query.id) {
        const detail = await getTenantDetail(req.query.id, req.query.date_from, req.query.date_to);
        return res.status(200).json(detail);
      }

      // Configurable per-tier pricing, used for the revenue report.
      if (req.query.plans === 'true') {
        const { data, error } = await supabaseAdmin.from('subscription_plans').select('*');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ plans: data });
      }

      // Platform revenue — real recorded payments, not a guessed snapshot,
      // bucketed by month for the graph.
      if (req.query.revenue_report === 'true') {
        const { date_from, date_to } = req.query;
        if (!date_from || !date_to) return res.status(400).json({ error: 'date_from and date_to are required' });

        const { data: payments, error } = await supabaseAdmin
          .from('subscription_payments')
          .select('amount, created_at, tenant_id')
          .gte('created_at', date_from)
          .lt('created_at', date_to);
        if (error) return res.status(500).json({ error: error.message });

        const monthlyMap = new Map();
        (payments || []).forEach((p) => {
          const key = p.created_at.slice(0, 7); // YYYY-MM
          monthlyMap.set(key, (monthlyMap.get(key) || 0) + Number(p.amount));
        });
        const monthly = Array.from(monthlyMap.entries())
          .map(([month, total]) => ({ month, total }))
          .sort((a, b) => a.month.localeCompare(b.month));

        const totalRevenue = (payments || []).reduce((sum, p) => sum + Number(p.amount), 0);
        return res.status(200).json({ total_revenue: totalRevenue.toFixed(2), payment_count: (payments || []).length, monthly });
      }

      if (req.query.subscription_history === 'true') {
        const { data, error } = await supabaseAdmin
          .from('tenant_subscription_history')
          .select('*')
          .eq('tenant_id', req.query.tenant_id)
          .order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ history: data });
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

      // Safety guard: this form can elevate or create access, but never
      // silently downgrade an existing super_admin. That has to be a
      // deliberate action in Supabase directly, not a form mistake.
      const { data: existing } = await supabaseAdmin
        .from('tenant_users')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();
      if (existing?.role === 'super_admin' && role !== 'super_admin') {
        return res.status(400).json({ error: 'This account is a super_admin. Downgrade it directly in Supabase if intended.' });
      }

      const { data, error } = await supabaseAdmin
        .from('tenant_users')
        .upsert({ user_id: user.id, tenant_id: role === 'super_admin' ? null : tenant_id, role }, { onConflict: 'user_id' })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ assignment: data });
    }

    if (req.method === 'PATCH') {
      // Update per-tier pricing
      if (req.body.update_plans) {
        const { trial, basic, pro } = req.body.update_plans;
        for (const [tier, price] of [['trial', trial], ['basic', basic], ['pro', pro]]) {
          if (price === undefined) continue;
          const { error } = await supabaseAdmin.from('subscription_plans').update({ monthly_price: price }).eq('tier', tier);
          if (error) return res.status(500).json({ error: error.message });
        }
        return res.status(200).json({ ok: true });
      }

      // Extend a tenant's subscription by N days from whichever is later —
      // their current expiry (so paid time already on the books isn't
      // lost) or right now (if they'd already expired).
      if (req.body.extend_subscription) {
        const { tenant_id, days, payment_amount, note } = req.body.extend_subscription;
        const { data: current, error: fetchErr } = await supabaseAdmin.from('tenants').select('subscription_expires_at').eq('id', tenant_id).single();
        if (fetchErr) return res.status(500).json({ error: fetchErr.message });

        const now = new Date();
        const currentExpiry = current.subscription_expires_at ? new Date(current.subscription_expires_at) : now;
        const base = currentExpiry > now ? currentExpiry : now;
        const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

        const { data, error } = await supabaseAdmin.from('tenants').update({ subscription_expires_at: newExpiry.toISOString() }).eq('id', tenant_id).select().single();
        if (error) return res.status(500).json({ error: error.message });

        if (payment_amount) {
          const { error: payErr } = await supabaseAdmin.from('subscription_payments').insert({ tenant_id, amount: payment_amount, note: note || `+${days} days` });
          if (payErr) return res.status(500).json({ error: payErr.message });
        }
        return res.status(200).json({ tenant: data });
      }

      // Set an exact custom expiry date (e.g. a negotiated 1-year deal)
      if (req.body.set_custom_subscription) {
        const { tenant_id, expires_at, payment_amount, note } = req.body.set_custom_subscription;
        const { data, error } = await supabaseAdmin.from('tenants').update({ subscription_expires_at: expires_at }).eq('id', tenant_id).select().single();
        if (error) return res.status(500).json({ error: error.message });

        if (payment_amount) {
          const { error: payErr } = await supabaseAdmin.from('subscription_payments').insert({ tenant_id, amount: payment_amount, note: note || 'Custom subscription' });
          if (payErr) return res.status(500).json({ error: payErr.message });
        }
        return res.status(200).json({ tenant: data });
      }

      // Deactivating resets the tier to trial — a deactivated tenant
      // shouldn't sit there looking like a paying "pro" account.
      if (req.body.deactivate_tenant) {
        const { tenant_id, note } = req.body.deactivate_tenant;
        const { data, error } = await supabaseAdmin.from('tenants').update({ active: false, subscription_tier: 'trial' }).eq('id', tenant_id).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await supabaseAdmin.from('tenant_subscription_history').insert({ tenant_id, event_type: 'deactivated', tier: 'trial', note: note || null });
        return res.status(200).json({ tenant: data });
      }

      // Reactivating requires picking a tier explicitly rather than
      // silently resuming whatever it happened to be before.
      if (req.body.reactivate_tenant) {
        const { tenant_id, tier, note } = req.body.reactivate_tenant;
        if (!tier) return res.status(400).json({ error: 'tier is required to reactivate' });
        const { data, error } = await supabaseAdmin.from('tenants').update({ active: true, subscription_tier: tier }).eq('id', tenant_id).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await supabaseAdmin.from('tenant_subscription_history').insert({ tenant_id, event_type: 'activated', tier, note: note || null });
        return res.status(200).json({ tenant: data });
      }

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