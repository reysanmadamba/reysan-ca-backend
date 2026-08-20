export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://reysan.ca');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!req.body || !req.body.message || req.body.message.length > 500) {
    return res.status(400).json({ error: 'Invalid or missing message' });
  }

    const FAQ_CONTEXT = `
Q: Who is Rey San Madamba?
A: A full-stack developer based in Edmonton, AB, and a NAIT Computer Software Development grad. Background in digital marketing and social media management before switching to development.

Q: What technologies does he work with?
A: Languages: C#, JavaScript, HTML, CSS, Java, SQL, Dart. Frameworks: Blazor Server, MudBlazor, React, Node.js, Flutter, Jakarta EE, EF Core. Cloud/tools: Azure, Firebase, Git, GitHub, SQL Server, PostgreSQL, MongoDB.

Q: Is he available for hire?
A: Yes — open to full-stack developer roles in Edmonton and remote. Best reached via email at madambareysan@gmail.com, LinkedIn, or GitHub (linked in the contact section).

Q: What's his biggest project?
A: The OOKs Substitution Solution — a NAIT capstone project with a 10-person team, built with C#, Blazor Server, MudBlazor, EF Core, SQL Server, and Azure. It replaced NAIT's manual instructor substitution process. He owned the Super Admin and Chair Override modules.

Q: Where is he currently working?
A: He currently works full-time as a Junior Software Developer at Planetcom.ca in Sherwood Park, Alberta, Canada.

Q: What client projects has he done?
A: Cerkal Group Lending Inc. (loan calculator landing page), Yours Handyworks (renovation business site), RhoCreates (crochet brand site), Highlevel Diner (restaurant site), and a Fleet & Dispatch Management System UI/UX prototype for a trucking company.

Q: What is the name of Rey's kids?
A: Khal Alessi and Khalee Aeisha.

Q: Who is his spouse?
A: Elyza Arboleda, a content creator from the Philippines with 1.8M Facebook followers and 60K Instagram followers.

Q: What are his and his family's hobbies?
A: Snowboarding in winter, and camping and hiking around Alberta in summer.

Q: How do I contact him?
A: Email madambareysan@gmail.com, or find him on LinkedIn (linkedin.com/in/reysanmadamba) and GitHub (github.com/reysanmadamba).

Q: What is ReputationExpert.ca?
A: A business Rey founded and runs himself — a digital reputation and access-resolution service. It's proof he can ship and operate a real product end to end, not just school projects. It operates as a consulting intermediary: the client sends a URL or describes the situation, and the team connects them with the right specialists to handle removal, recovery, or placement. Most cases get a free initial assessment before any commitment.

Q: What services does ReputationExpert.ca offer?
A: Four main areas: (1) Content deindexing and removal — negative articles, reviews, mugshots, forum posts, deindexed from Google, Bing, and Yandex or fully removed. (2) Social media account recovery — Facebook, Instagram, TikTok, X, and Snapchat: disabled/suspended/hacked account reinstatement, 2FA recovery, verification badge consulting. (3) Media and PR placement — getting featured in outlets like Forbes, Business Insider, Yahoo Finance, USA Today, and more. (4) Web, app, and software development — business sites, e-commerce, mobile apps, custom software.

Q: What's the best-selling / most requested service?
A: Instagram account recovery and Google review removal are the two most requested services.

Q: How much does Google review removal cost?
A: Typically 700 CAD to 1,000 CAD, depending on the case. Pricing is assessed per situation — reach out for an exact quote.

Q: Does he offer Google Knowledge Panel setup?
A: Yes, Rey personally handles Google Knowledge Panel creation for 500 CAD — it's the info card that appears when someone searches your name on Google, helping you look established and notable in search results.

Q: How long does content removal take?
A: Varies by case. Simple deindexing (news articles, blogs) can take 24-48 hours, with complex cases up to 15 days. Reviews and social posts typically take 1-14 days. Account recovery is usually 1-7 days.

Q: Can you share an example / case study of content removal?
A: A senior executive had a negative news article ranking #2 on their name search. It was deindexed within 90 days, and six positive authority pages now occupy the top six search positions.

Q: Can you share an example of mugshot removal?
A: A client had a years-old mugshot and arrest record appearing at the top of their Google search results. It was deindexed from Google, Bing, and Yandex within 10 days — no trace of the record remains.

Q: Can you share an example of review removal?
A: A home services business was hit with 14 fake negative reviews, dropping their rating from 4.7 to 3.2. 11 of the 14 reviews were removed, and the rating was restored to 4.5 within 60 days.

Q: Can you share an example of social media account recovery / defamation removal?
A: A business owner was targeted by a fake Facebook account posting false, defamatory content that Facebook had ignored for weeks. The defamatory content was removed within 7 days, and the responsible account was taken down shortly after.

Q: Is ReputationExpert.ca affiliated with Google, Facebook, or other platforms?
A: No — it's an independent consulting intermediary, not affiliated with, endorsed by, or partnered with Meta, Google, TikTok, Snapchat, X, YouTube, Yelp, Glassdoor, Airbnb, or any other platform. Results are not guaranteed and are subject to each platform's own review process.
`;

const SYSTEM_PROMPT = `You are a helpful assistant on Rey San Madamba's developer portfolio site (reysan.ca). Follow these rules:
1. Only answer using the info below. Do not make up information about Rey, his work, or his business.
2. If asked something not covered here — especially pricing not explicitly listed below — say: "I don't have that info — feel free to reach out directly at madambareysan@gmail.com."
3. Keep answers short and friendly, 1-3 sentences.
4. Speak about Rey and his business in the third person, as his portfolio assistant. Only state pricing when it's explicitly given below — never estimate, guess, or infer a price for anything not listed.
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