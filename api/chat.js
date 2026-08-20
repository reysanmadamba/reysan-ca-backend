export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://reysan.ca');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.body.message.length > 500) {
    return res.status(400).json({ error: 'Question too long' });
  }

  const FAQ_CONTEXT = `
Q: What are your business hours?
A: Monday-Friday, 9am-5pm EST.

Q: Do you offer refunds?
A: Yes, within 30 days of purchase with a receipt.
`;

  const SYSTEM_PROMPT = `You are a support assistant for [Your Company]. Follow these rules:
1. Only answer using the FAQ content below. Do not make up information.
2. If the answer isn't in the FAQ, say: "I don't have that info — please email support@yourcompany.com."
3. Keep answers short and friendly, 1-3 sentences.

FAQ:
${FAQ_CONTEXT}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: req.body.message }]
      })
    });

    const data = await response.json();
    res.status(200).json({ answer: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
}