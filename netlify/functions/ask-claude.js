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

// Verify the caller holds a real Supabase session.
//
// This endpoint spends money on every call and accepts images, so left open it is
// a free Claude proxy on someone else's bill for anyone who finds the URL -- and
// the URL is guessable and this repo is public. Asking Supabase to resolve the
// token is one round trip and needs no JWT library and no extra secret; both
// values below are the same ones already in log/index.html.
//
// Fails closed. If the environment variables are missing the function refuses
// every request rather than quietly serving an unprotected one.
async function callerIsSignedIn(event) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return { ok: false, status: 503, msg: "Auth not configured" };

  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { ok: false, status: 401, msg: "Sign in required" };

  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/auth/v1/user", {
      headers: { apikey: anon, Authorization: "Bearer " + token }
    });
    if (!res.ok) return { ok: false, status: 401, msg: "Sign in required" };
    const user = await res.json();
    if (!user || !user.id) return { ok: false, status: 401, msg: "Sign in required" };
    return { ok: true };
  } catch (e) {
    // Supabase unreachable. Refuse rather than assume the caller is legitimate.
    return { ok: false, status: 503, msg: "Could not verify session" };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const auth = await callerIsSignedIn(event);
  if (!auth.ok) {
    return { statusCode: auth.status, body: JSON.stringify({ error: auth.msg }) };
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
      // Logged for us, not returned: the upstream body can echo request content.
      console.error("Anthropic API error:", anthropicRes.status, errBody);
      return { statusCode: 502, body: JSON.stringify({ error: "Upstream error" }) };
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
    console.error("ask-claude failed:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Request failed" }) };
  }
};
