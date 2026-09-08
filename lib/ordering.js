// lib/ordering.js
//
// Extracted from jollibee-chat.js so orders.js can also finalize an order
// (after a staff takeover) using the exact same price-verification and
// merge/split logic — never a second, possibly-inconsistent copy of the
// money-handling code.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
export const GST_RATE = 0.05; // Alberta: 5% federal GST, no provincial sales tax

// Never trust a price/name that came from an LLM's own memory of the
// conversation — always re-look-up the real, current price from menu_items.
export async function resolveAuthoritativePrices(items, tenantId) {
    const ids = items.map((i) => i.menu_item_id);
    const { data: menuRows, error } = await supabase
        .from('menu_items')
        .select('id, name, price, active')
        .eq('tenant_id', tenantId)
        .in('id', ids);
    if (error) throw new Error(error.message);

    const byId = new Map((menuRows || []).map((m) => [m.id, m]));
    return items.map((item) => {
        const menuItem = byId.get(item.menu_item_id);
        if (!menuItem || !menuItem.active) {
            throw new Error(`${item.name || 'One of those items'} isn't available right now.`);
        }
        return { menu_item_id: menuItem.id, name: menuItem.name, qty: item.qty, price: Number(menuItem.price) };
    });
}

// `items` is always the FULL order as currently wanted — not a delta.
// Idempotent: calling this twice with the same list gives the same result.
export async function confirmOrder({ items: rawItems, note }, tenantId, customerId, phoneVerified, existingOrderId, sessionId, staffSupervised = false) {
    if (!phoneVerified) return { error: 'Phone number must be verified before placing an order.' };

    let fullItems;
    try {
        fullItems = await resolveAuthoritativePrices(rawItems, tenantId);
    } catch (err) {
        return { error: err.message };
    }

    if (existingOrderId) {
        const { data: existing } = await supabase.from('orders').select('*').eq('id', existingOrderId).maybeSingle();

        if (existing && existing.status === 'new') {
            const subtotal = fullItems.reduce((sum, i) => sum + i.qty * i.price, 0);
            const tax = subtotal * GST_RATE;
            const total = subtotal + tax;

            const { data, error } = await supabase
                .from('orders')
                .update({ items: fullItems, subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: total.toFixed(2), note: note ?? existing.note })
                .eq('id', existingOrderId)
                .select()
                .single();
            if (error) return { error: error.message };
            return { order_id: data.id, order_number: data.order_number, subtotal: data.subtotal, tax: data.tax, total: data.total, status: data.status, updated: true };
        }

        if (existing && staffSupervised) {
            // A staff member has already directly confirmed this change with the
            // customer — the "can't touch an accepted order automatically" rule
            // exists to protect the unsupervised path, not conversations a human
            // is actively running. Replace directly; if that empties the order,
            // it means cancel it outright, not leave a zero-item order sitting
            // there in an accepted state.
            if (fullItems.length === 0) {
                const { data, error } = await supabase.from('orders').update({ status: 'cancelled' }).eq('id', existingOrderId).select().single();
                if (error) return { error: error.message };
                return { order_id: data.id, order_number: data.order_number, status: 'cancelled', cancelled: true };
            }

            const subtotal = fullItems.reduce((sum, i) => sum + i.qty * i.price, 0);
            const tax = subtotal * GST_RATE;
            const total = subtotal + tax;

            const { data, error } = await supabase
                .from('orders')
                .update({ items: fullItems, subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: total.toFixed(2), note: note ?? existing.note })
                .eq('id', existingOrderId)
                .select()
                .single();
            if (error) return { error: error.message };
            return { order_id: data.id, order_number: data.order_number, subtotal: data.subtotal, tax: data.tax, total: data.total, status: data.status, updated: true };
        }

        if (existing) {
            const diffItems = [];
            let hasReduction = false;

            for (const item of fullItems) {
                const already = existing.items.find((i) => i.menu_item_id === item.menu_item_id);
                const alreadyQty = already ? already.qty : 0;
                const newQty = item.qty - alreadyQty;
                if (newQty > 0) diffItems.push({ ...item, qty: newQty });
                if (newQty < 0) hasReduction = true;
            }
            // An existing item dropped entirely from the requested list is also a
            // reduction (a full removal), even though the loop above never sees it.
            for (const existingItem of existing.items) {
                if (!fullItems.find((i) => i.menu_item_id === existingItem.menu_item_id)) hasReduction = true;
            }

            // Exact match — the customer/AI is re-confirming something that's
            // already exactly the order's current state (e.g. staff already
            // applied this change). Nothing to do — and definitely not an
            // "unavailable" situation, which is what a confusing generic error
            // here previously got misread as.
            if (diffItems.length === 0 && !hasReduction) {
                return {
                    order_id: existing.id,
                    order_number: existing.order_number,
                    subtotal: existing.subtotal,
                    tax: existing.tax,
                    total: existing.total,
                    status: existing.status,
                    already_matches: true,
                    note_for_ai: "This order already has exactly this — nothing needs to change. Just confirm the current total to the customer. This is not an availability issue, don't say anything is unavailable."
                };
            }

            if (diffItems.length === 0 && hasReduction) {
                return {
                    error: "That order's already being prepared, so nothing can be added — this looks more like a request to reduce or remove something instead.",
                    reduction_requested: true,
                    note_for_ai: 'The customer is trying to reduce/remove from an order that\'s already accepted. Do not attempt this yourself. Tell them you\'ll flag it for staff to call and confirm, then call flag_order_for_staff_review with a clear description of what they want changed.'
                };
            }

            const subtotal = diffItems.reduce((sum, i) => sum + i.qty * i.price, 0);
            const tax = subtotal * GST_RATE;
            const total = subtotal + tax;

            const { data, error } = await supabase
                .from('orders')
                .insert({ tenant_id: tenantId, customer_id: customerId, items: diffItems, subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: total.toFixed(2), note: note || null, status: 'new', session_id: sessionId })
                .select()
                .single();
            if (error) return { error: error.message };
            return {
                order_id: data.id,
                order_number: data.order_number,
                subtotal: data.subtotal,
                tax: data.tax,
                total: data.total,
                status: data.status,
                new_separate_order: true,
                combined_total: (Number(existing.total || 0) + total).toFixed(2),
                note_for_ai: 'The previous order was already accepted and is being prepared, so only the newly added item(s) were placed as a new, separate order. Tell the customer this as one running tab — mention the new order number and combined_total, not two unrelated charges.'
            };
        }
    }

    // No existing order to attach to, and nothing was actually agreed on —
    // don't create a phantom $0 order. This can happen when the AI tries to
    // represent "nothing happened" as a cancellation instead of just saying so.
    if (fullItems.length === 0) {
        return { error: 'Nothing to place — no items were specified and there was no existing order to change.', no_op: true };
    }

    const subtotal = fullItems.reduce((sum, i) => sum + i.qty * i.price, 0);
    const tax = subtotal * GST_RATE;
    const total = subtotal + tax;

    const { data, error } = await supabase
        .from('orders')
        .insert({
            tenant_id: tenantId,
            customer_id: customerId,
            items: fullItems,
            subtotal: subtotal.toFixed(2),
            tax: tax.toFixed(2),
            total: total.toFixed(2),
            note: note || null,
            status: 'new',
            session_id: sessionId
        })
        .select()
        .single();
    if (error) return { error: error.message };
    return { order_id: data.id, order_number: data.order_number, subtotal: data.subtotal, tax: data.tax, total: data.total, status: data.status };
}

export function computeRemainingMinutes(order) {
    if (order.status !== 'accepted' || !order.accepted_at || !order.eta_minutes) return null;
    const targetMs = new Date(order.accepted_at).getTime() + order.eta_minutes * 60000;
    return Math.max(0, Math.round((targetMs - Date.now()) / 60000));
}