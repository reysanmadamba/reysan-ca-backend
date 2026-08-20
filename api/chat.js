export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://reysan.ca');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!req.body || !req.body.message || req.body.message.length > 500) {
    return res.status(400).json({ error: 'Invalid or missing message' });
  }

  const FAQ_CONTEXT = `
Q: Who is Rey San Madamba?
A: A full-stack developer based in Edmonton, AB, and a NAIT Computer Software Development grad. Background in digital marketing before switching to development.

Q: What technologies does he work with?
A: Languages: C#, JavaScript, HTML, CSS, Java, SQL, Dart. Frameworks: Blazor Server, MudBlazor, React, Node.js, Flutter, Jakarta EE, EF Core. Cloud/tools: Azure, Firebase, Git, GitHub, SQL Server, PostgreSQL, MongoDB.

Q: Is he available for hire?
A: Yes — open to full-stack developer roles in Edmonton and remote. Best reached via email at madambareysan@gmail.com, LinkedIn, or GitHub (linked in the contact section).

Q: What's his biggest project?
A: The OOKs Substitution Solution — a NAIT capstone project with a 10-person team, built with C#, Blazor Server, MudBlazor, EF Core, SQL Server, and Azure. It replaced NAIT's manual instructor substitution process. He owned the Super Admin and Chair Override modules.

Q: What is ReputationExpert.ca?
A: A business Rey founded and runs himself — a digital reputation and access-resolution service. It's proof he can ship and operate a real product end to end, not just school projects.

Q: What client projects has he done?
A: Cerkal Group Lending Inc. (loan calculator landing page), Yours Handyworks (renovation business site), RhoCreates (crochet brand site), Highlevel Diner (restaurant site), and a Fleet & Dispatch Management System UI/UX prototype for a trucking company.

Q: How do I contact him?
A: Email madambareysan@gmail.com, or find him on LinkedIn (linkedin.com/in/reysanmadamba) and GitHub (github.com/reysanmadamba).
`;

  const SYSTEM_PROMPT = `You are a helpful assistant on Rey San Madamba's developer portfolio site (reysan.ca). Follow these rules:
1. Only answer using the info below. Do not make up information about Rey or his work.
2. If asked something not covered here, say: "I don't have that info — feel free to reach out directly at madambareysan@gmail.com."
3. Keep answers short and friendly, 1-3 sentences.
4. Speak about Rey in the third person, as his portfolio assistant.
5. If the user's message is offensive, abusive, sexual, hateful, or otherwise inappropriate, respond with EXACTLY this and nothing else: [FLAGGED]

Info:
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
    var answer = data.content[0].text;

    if (answer.trim() === '[FLAGGED]') {
      return res.status(200).json({ answer: null, flagged: true });
    }

    res.status(200).json({ answer: answer });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
}