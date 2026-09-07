// lib/llm.js
//
// Generic Claude/OpenAI callers, parametrized by model/system prompt/tools
// so multiple endpoints can share this without duplicating fetch/timeout/
// error-handling logic. Lives in lib/, not api/, since it has no default
// export handler — Vercel treats every file in api/ as its own serverless
// function, and a shared helper with no valid handler shape breaks that
// (this exact mistake broke a deployment earlier in this project).

const FETCH_TIMEOUT_MS = 10000;

export const PRICING = {
    claude: { input: 1 / 1e6, output: 5 / 1e6 },     // Haiku 4.5: $1 / $5 per million tokens
    openai: { input: 0.15 / 1e6, output: 0.6 / 1e6 } // gpt-4o-mini: $0.15 / $0.60 per million tokens
};

export async function callClaude(messages, { model, systemPrompt, tools, maxTokens = 1024 }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, tools, messages }),
            signal: controller.signal
        });

        const data = await resp.json();
        if (!resp.ok) {
            console.error('Claude API error', resp.status, data.error);
            throw new Error(data.error?.message || 'Upstream API error');
        }
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

export async function callOpenAI(messages, { model, systemPrompt, tools, maxTokens }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'system', content: systemPrompt }, ...messages],
                tools,
                tool_choice: 'auto',
                ...(maxTokens ? { max_tokens: maxTokens } : {})
            }),
            signal: controller.signal
        });

        const data = await resp.json();
        if (!resp.ok) {
            console.error('OpenAI API error', resp.status, data.error);
            throw new Error(data.error?.message || 'Upstream API error');
        }
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

// Runs the Claude tool-calling loop to completion, returning the final
// text reply plus accumulated token usage across every round trip.
export async function runClaudeLoop(messages, runTool, { model, systemPrompt, tools, maxTokens }) {
    let response = await callClaude(messages, { model, systemPrompt, tools, maxTokens });
    let inputTokens = response.usage?.input_tokens || 0;
    let outputTokens = response.usage?.output_tokens || 0;

    while (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const toolResultBlocks = [];
        for (const block of toolUseBlocks) {
            const result = await runTool(block.name, block.input);
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResultBlocks });
        response = await callClaude(messages, { model, systemPrompt, tools, maxTokens });
        inputTokens += response.usage?.input_tokens || 0;
        outputTokens += response.usage?.output_tokens || 0;
    }

    messages.push({ role: 'assistant', content: response.content });
    const textBlock = response.content.find((b) => b.type === 'text');
    return { text: textBlock ? textBlock.text : '', inputTokens, outputTokens };
}

// Same, for OpenAI's flatter tool_calls shape. Tools passed in must already
// be OpenAI-formatted ({ type: 'function', function: {...} }).
export async function runOpenAiLoop(messages, runTool, { model, systemPrompt, tools, maxTokens }) {
    let data = await callOpenAI(messages, { model, systemPrompt, tools, maxTokens });
    let message = data.choices[0].message;
    let inputTokens = data.usage?.prompt_tokens || 0;
    let outputTokens = data.usage?.completion_tokens || 0;

    while (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);
        for (const call of message.tool_calls) {
            const input = JSON.parse(call.function.arguments || '{}');
            const result = await runTool(call.function.name, input);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        data = await callOpenAI(messages, { model, systemPrompt, tools, maxTokens });
        message = data.choices[0].message;
        inputTokens += data.usage?.prompt_tokens || 0;
        outputTokens += data.usage?.completion_tokens || 0;
    }

    messages.push(message);
    return { text: message.content || '', inputTokens, outputTokens };
}