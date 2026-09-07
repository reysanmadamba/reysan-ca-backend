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
const MAX_OFF_TOPIC = 3; // after this many, the chat disables itself

const AI_SYSTEM_PROMPT = `You are a menu management assistant for restaurant staff using an internal dashboard — not a customer-facing assistant, so you can be direct and brief.

Reply in plain text only — no markdown (no **, no #, no numbered-list dots run into a paragraph). When listing multiple items, put each one on its own line with an actual line break, not "1. X 2. Y" crammed together.

If the staff member asks something unrelated to menu management, say so briefly and call flag_off_topic in the same turn. If the tool result comes back with limit_reached: true, say a brief goodbye and don't continue.

Always call find_menu_items first to locate what the staff member means, by name or category keyword. If more than one item plausibly matches, list them briefly and ask which one before changing anything — never guess between similar items. If there's exactly one match, or they've already clarified which one they mean, go ahead and call update_menu_item.

For anything involving "all", "everything", or a long list of items — e.g. "mark everything unavailable", "activate the whole menu", "make everything available except the 10pc bucket" — use bulk_set_availability instead of calling update_menu_item many times. It's one reliable operation regardless of how many items there are.

To create a brand new item that doesn't exist yet, use create_menu_item — check with find_menu_items first that nothing similar already exists under a slightly different name. To edit an existing item's description, price, name, or flags, use update_menu_item, same as changing availability.

IMPORTANT: always call find_menu_items again for every new question or command, even if you already looked up something similar earlier in this conversation. The menu can change between messages — staff may update items through the regular dashboard UI too, not just through you — so a result from a few messages ago may already be stale. Never answer a question about current availability, price, or status from memory of an earlier tool result; always check fresh.

After making a change, confirm briefly in plain language (e.g. "Marked 10pc Chicken Bucket as unavailable."). If nothing needed changing, just say so.`;

const AI_TOOLS = [
  {
    name: 'find_menu_items',
    description: 'Search current menu items by name or category keyword. Pass an empty string for query to list the entire menu — do NOT pass words like "all" or "everything" as the query itself, since those get searched for literally as text and won\'t match real item names. Always returns live, current data — call this fresh every time, even if you searched something similar earlier in this conversation, since the menu can change between messages.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'update_menu_item',
    description: 'Update a single menu item. Only include the fields actually being changed.',
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
  },
  {
    name: 'bulk_set_availability',
    description: 'Set availability for the WHOLE menu at once. Use this instead of calling update_menu_item once per item for anything involving "all", "everything", or a long list — it\'s one operation regardless of menu size, so it can\'t get cut off partway through like many individual calls could. Example: "make everything available except the 10pc Chicken Bucket" -> default_active: true, exceptions: [{item_id: "<10pc bucket id>", active: false}].',
    input_schema: {
      type: 'object',
      properties: {
        default_active: { type: 'boolean', description: 'What to set every item to, unless listed in exceptions.' },
        exceptions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { item_id: { type: 'string' }, active: { type: 'boolean' } },
            required: ['item_id', 'active']
          },
          description: 'Items that should get a different value than default_active.'
        }
      },
      required: ['default_active']
    }
  },
  {
    name: 'create_menu_item',
    description: 'Create a brand new menu item that doesn\'t exist yet. Use find_menu_items first to confirm it doesn\'t already exist under a similar name before creating a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number' },
        popular: { type: 'boolean' },
        spicy: { type: 'boolean' },
        veg: { type: 'boolean' }
      },
      required: ['category', 'name', 'price']
    }
  },
  {
    name: 'flag_off_topic',
    description: 'Call this every time the staff member asks something unrelated to managing the menu (general chit-chat, unrelated topics). Call it in the same turn as your reply. After a few of these, the system disables the chat automatically.',
    input_schema: { type: 'object', properties: {} }
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
    const { ai_command, tenant_id, history: clientHistory = [], off_topic_count } = req.body;
    let offTopicCount = off_topic_count || 0;

    if (offTopicCount >= MAX_OFF_TOPIC) {
      return res.status(200).json({
        reply: "This chat's been disabled since it moved away from menu management — refresh the page to start a new one.",
        conversationEnded: true,
        off_topic_count: offTopicCount
      });
    }

    const resolved = resolveTenantId(auth, tenant_id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const { data: tenantRow } = await supabaseAdmin.from('tenants').select('ai_provider').eq('id', resolved.tenantId).single();
    const provider = tenantRow?.ai_provider || 'claude';
    const openaiTools = AI_TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

    async function runTool(name, input) {
      if (name === 'flag_off_topic') {
        offTopicCount += 1;
        return { count: offTopicCount, limit_reached: offTopicCount >= MAX_OFF_TOPIC };
      }
      if (name === 'find_menu_items') {
        // Strip characters that would break PostgREST's .or() filter syntax —
        // this is a staff-only tool, but sanitizing cheaply avoids a
        // malformed query if a weird phrase makes it through.
        const safeQuery = (input.query || '').replace(/[,()]/g, '').trim();

        let query = supabaseAdmin
          .from('menu_items')
          .select('id, name, category, price, active')
          .eq('tenant_id', resolved.tenantId);

        // An empty/generic query means "show everything" — it should never
        // silently return zero results and get reported as "no items exist".
        if (safeQuery) query = query.or(`name.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`);

        const { data, error } = await query.limit(200);
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
      if (name === 'bulk_set_availability') {
        const { default_active, exceptions = [] } = input;
        const { error: bulkErr } = await supabaseAdmin
          .from('menu_items')
          .update({ active: default_active })
          .eq('tenant_id', resolved.tenantId);
        if (bulkErr) return { error: bulkErr.message };

        for (const ex of exceptions) {
          const { error: exErr } = await supabaseAdmin
            .from('menu_items')
            .update({ active: ex.active })
            .eq('id', ex.item_id)
            .eq('tenant_id', resolved.tenantId);
          if (exErr) return { error: exErr.message };
        }
        return { ok: true, default_active, exceptions_applied: exceptions.length };
      }
      if (name === 'create_menu_item') {
        const { category, name: itemName, description, price, popular, spicy, veg } = input;
        if (!category || !itemName || price === undefined) {
          return { error: 'category, name, and price are required to create an item.' };
        }
        const { data, error } = await supabaseAdmin
          .from('menu_items')
          .insert({
            tenant_id: resolved.tenantId,
            category,
            name: itemName,
            description: description || null,
            price,
            popular: !!popular,
            spicy: !!spicy,
            veg: !!veg,
            active: true,
            allergens: [],
            attributes: {}
          })
          .select()
          .single();
        if (error) return { error: error.message };
        return { created: data };
      }
      return { error: 'Unknown tool' };
    }

    const messages = [...clientHistory, { role: 'user', content: ai_command }];
    try {
      const result =
        provider === 'openai'
          ? await runOpenAiLoop(messages, runTool, { model: 'gpt-4o-mini', systemPrompt: AI_SYSTEM_PROMPT, tools: openaiTools, maxTokens: 4096 })
          : await runClaudeLoop(messages, runTool, { model: 'claude-haiku-4-5-20251001', systemPrompt: AI_SYSTEM_PROMPT, tools: AI_TOOLS, maxTokens: 4096 });
      return res.status(200).json({
        reply: result.text,
        history: messages,
        off_topic_count: offTopicCount,
        conversationEnded: offTopicCount >= MAX_OFF_TOPIC
      });
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