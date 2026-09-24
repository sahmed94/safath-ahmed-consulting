// netlify/functions/ask-claude.js
//
// Generic proxy to Claude's API. The frontend (prod-index.html) calls this
// for all three AI features: meal calorie/macro estimates, the encouragement
// toasts, and the daily score coach note.
//
// Setup:
// 1. Put this file at netlify/functions/ask-claude.js in your site's repo.
// 2. In Netlify: Site settings -> Environment variables -> add ANTHROPIC_API_KEY
//    (get a key at console.anthropic.com -> API Keys). Never put the key in
//    frontend code -- this function is the only place it should exist.
//
// Request body: { messages: [...], maxTokens?: number }
//   messages follow the same shape used throughout prod-index.html:
//   [{ role: "user", content: "plain text" }]
//   or
//   [{ role: "user", content: [ { type: "text", text: "..." }, { type: "image", url: "data:image/...;base64,..." } ] }]
//
// Response body: { text: "Claude's reply as plain text" }
// The frontend is responsible for JSON.parse()-ing that text itself when it
// asked for a structured (JSON) reply, e.g. the meal estimate.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { messages, maxTokens } = JSON.parse(event.body || "{}");
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing messages array" }) };
    }

    const apiMessages = messages.map((m) => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map((block) => {
            if (block.type === "image") {
              const match = block.url.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
              if (!match) throw new Error("Invalid image data URL");
              return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
            }
            return { type: "text", text: block.text };
          })
        : m.content
    }));

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        // Sonnet 5 is the current generation of the tier this was written for.
        // It is both cheaper than claude-sonnet-4-6 ($2/$10 per Mtok against
        // $3/$15) and more capable, so there is no tradeoff in the swap.
        // Meal photos go through this path, and it does vision.
        model: "claude-sonnet-5",
        max_tokens: maxTokens || 400,
        messages: apiMessages
      })
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: "Anthropic API error", detail: errBody }) };
    }

    const data = await anthropicRes.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      return { statusCode: 502, body: JSON.stringify({ error: "No text response from model" }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: textBlock.text.trim() })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
