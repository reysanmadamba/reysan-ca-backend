// api/menu.js
//
// GET    -> list menu items for the tenant
// POST   -> add a new item
// PATCH  -> edit an existing item
// DELETE -> remove an item (hard delete — remove/soft-delete tradeoff is a
//           later decision; fine for a demo/early stage)

import { supabaseAdmin, verifyAuth, resolveTenantId } from '../lib/auth-check.js';
import { runClaudeLoop, runOpenAiLoop } from '../lib/llm.js';

const ALLOWED_ORIGINS = ['https://reysan.ca'];

const AI_SYSTEM_PROMPT = `You are a menu management assistant for restaurant staff using an internal dashboard — not a customer-facing assistant, so you can be direct and brief.

Always call find_menu_items first to locate what the staff member means, by name or category keyword. If more than one item plausibly matches, list them briefly and ask which one before changing anything — never guess between similar items. If there's exactly one match, or they've already clarified which one they mean, go ahead and call update_menu_item.

IMPORTANT: always call find_menu_items again for every new question or command, even if you already looked up something similar earlier in this conversation. The menu can change between messages — staff may update items through the regular dashboard UI too, not just through you — so a result from a few messages ago may already be stale. Never answer a question about current availability, price, or status from memory of an earlier tool result; always check fresh.

After making a change, confirm briefly in plain language (e.g. "Marked 10pc Chicken Bucket as unavailable."). If nothing needed changing, just say so.`;

const AI_TOOLS = [
  {
    name: 'find_menu_items',
    description: 'Search current menu items by name or category keyword. Always returns live, current data — call this fresh every time, even if you searched something similar earlier in this conversation, since the menu can change between messages.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'update_menu_item',
    description: 'Update a menu item. Only include the fields actually being changed.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        active: { type: 'boolean', description: 'false = mark unavailable, true = mark available again' },
        price: { type: 'number' },
        name: { type: 'string' },
        description: { type: 'string' },
        popular: { type: 'boolean' },
        spicy: { type: 'boolean' },
        veg: { type: 'boolean' }
      },
      required: ['item_id']
    }
  }
];

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

    let query = supabaseAdmin.from('menu_items').select('*').eq('tenant_id', resolved.tenantId);
    if (req.query.include_inactive !== 'true') query = query.eq('active', true);

    const { data, error } = await query.order('category').order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ items: data });
  }

  if (req.method === 'POST' && req.body.ai_command) {
    const { ai_command, tenant_id, history: clientHistory = [] } = req.body;
    const resolved = resolveTenantId(auth, tenant_id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const { data: tenantRow } = await supabaseAdmin.from('tenants').select('ai_provider').eq('id', resolved.tenantId).single();
    const provider = tenantRow?.ai_provider || 'claude';
    const openaiTools = AI_TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

    async function runTool(name, input) {
      if (name === 'find_menu_items') {
        // Strip characters that would break PostgREST's .or() filter syntax —
        // this is a staff-only tool, but sanitizing cheaply avoids a
        // malformed query if a weird phrase makes it through.
        const safeQuery = (input.query || '').replace(/[,()]/g, '').trim();
        if (!safeQuery) return { items: [] };
        const { data, error } = await supabaseAdmin
          .from('menu_items')
          .select('id, name, category, price, active')
          .eq('tenant_id', resolved.tenantId)
          .or(`name.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`)
          .limit(200);
        if (error) return { error: error.message };
        return { items: data };
      }
      if (name === 'update_menu_item') {
        const { item_id, ...fields } = input;
        const { data, error } = await supabaseAdmin
          .from('menu_items')
          .update(fields)
          .eq('id', item_id)
          .eq('tenant_id', resolved.tenantId) // can't touch another tenant's item even by guessing an id
          .select()
          .single();
        if (error) return { error: error.message };
        return { updated: data };
      }
      return { error: 'Unknown tool' };
    }

    const messages = [...clientHistory, { role: 'user', content: ai_command }];
    try {
      const result =
        provider === 'openai'
          ? await runOpenAiLoop(messages, runTool, { model: 'gpt-4o-mini', systemPrompt: AI_SYSTEM_PROMPT, tools: openaiTools })
          : await runClaudeLoop(messages, runTool, { model: 'claude-haiku-4-5-20251001', systemPrompt: AI_SYSTEM_PROMPT, tools: AI_TOOLS });
      return res.status(200).json({ reply: result.text, history: messages });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { tenant_id, category, name, description, price, popular, spicy, allergens, veg, attributes } = req.body;
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
        veg: !!veg,
        attributes: attributes || {}
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

    // Soft delete — deactivate rather than erase, so order history that
    // references this item by id stays intact.
    const { error } = await supabaseAdmin
      .from('menu_items')
      .update({ active: false })
      .eq('id', id)
      .eq('tenant_id', resolved.tenantId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}