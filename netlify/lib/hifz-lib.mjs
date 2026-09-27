// Shared helpers for the AAS Hifz Netlify functions.
// No npm dependencies: talks to Supabase (PostgREST) and Twilio with fetch.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   HIFZ_SUPABASE_URL            https://<project>.supabase.co
//   HIFZ_SUPABASE_SERVICE_KEY    service_role key — SECRET, functions only, never in a page
//   HIFZ_SUPABASE_ANON_KEY       anon key (used only to check a caller's login)
//   HIFZ_WEBHOOK_SECRET          any long random string; the Supabase webhook sends it in x-hifz-secret
//   HIFZ_APP_URL                 https://accountabilityaas.com/hifz/
//   HIFZ_DRY_RUN                 "1" = build and log messages but do not send (safe for testing in prod)
//   HIFZ_CHANNELS                "whatsapp,sms" (order = preference; first that succeeds wins)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_WHATSAPP_FROM         e.g. +14155238886 (sandbox) or your approved WhatsApp sender
//   TWILIO_WA_TEMPLATE_UPDATE    HX… Content SID for the "update" template (optional; without it free-form Body is used,
//                                which WhatsApp only delivers inside a 24-hour customer-service window / sandbox)
//   TWILIO_WA_TEMPLATE_DAILY     HX… Content SID for the "daily summary" template (optional, same rule)
//   TWILIO_SMS_FROM              e.g. +12405550100  (or use TWILIO_MESSAGING_SERVICE_SID instead)
//   TWILIO_MESSAGING_SERVICE_SID MG… (optional; preferred for US A2P 10DLC)

export const env = (k, d = "") => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? d);

export const cfg = () => ({
  sbUrl: env("HIFZ_SUPABASE_URL").replace(/\/$/, ""),
  sbService: env("HIFZ_SUPABASE_SERVICE_KEY"),
  sbAnon: env("HIFZ_SUPABASE_ANON_KEY"),
  secret: env("HIFZ_WEBHOOK_SECRET"),
  appUrl: env("HIFZ_APP_URL", "https://accountabilityaas.com/hifz/"),
  dryRun: env("HIFZ_DRY_RUN", "1") === "1",
  channels: env("HIFZ_CHANNELS", "whatsapp,sms").split(",").map(s => s.trim()).filter(Boolean),
  tw: {
    sid: env("TWILIO_ACCOUNT_SID"), token: env("TWILIO_AUTH_TOKEN"),
    waFrom: env("TWILIO_WHATSAPP_FROM"), tplUpdate: env("TWILIO_WA_TEMPLATE_UPDATE"), tplDaily: env("TWILIO_WA_TEMPLATE_DAILY"),
    smsFrom: env("TWILIO_SMS_FROM"), msid: env("TWILIO_MESSAGING_SERVICE_SID"),
  },
});

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------- Supabase (service role, bypasses RLS) ----------
export async function sb(path, { method = "GET", body, prefer } = {}) {
  const c = cfg();
  const headers = { apikey: c.sbService, Authorization: `Bearer ${c.sbService}`, "content-type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${c.sbUrl}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Who is calling? Validates a user's access token with Supabase Auth and returns { id, email }.
export async function userFromToken(token) {
  const c = cfg();
  if (!token) return null;
  const r = await fetch(`${c.sbUrl}/auth/v1/user`, { headers: { apikey: c.sbAnon || c.sbService, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return { id: u.id, email: String(u.email || "").toLowerCase(), phone: digits(u.phone) };
}

export const digits = p => String(p || "").replace(/\D/g, "");
export const e164 = p => (digits(p) ? "+" + digits(p) : "");
export const firstName = n => { const w = String(n || "").trim().split(/\s+/); return /^(ustadh|ustadha|ustaz|ustaza|shaykh|sheikh|shaikh|hafiz|hafiza|hafidh|qari|imam|maulana|moulana|mawlana|mufti|apa|mr|mrs|ms|dr|br|sr|brother|sister)\.?$/i.test(w[0]) && w[1] ? `${w[0]} ${w[1]}` : (w[0] || ""); };
export const oneLine = (s, max = 900) => String(s || "").replace(/\s*\n+\s*/g, " · ").replace(/\s{2,}/g, " ").trim().slice(0, max);

// ---------- Twilio ----------
async function twilioSend(params) {
  const { tw } = cfg();
  const body = new URLSearchParams(params);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${tw.sid}:${tw.token}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio ${r.status} ${out.code || ""} ${out.message || ""}`.trim());
  return { sid: out.sid, status: out.status };
}

/**
 * Send one message to one phone, trying channels in order.
 * msg = { text, template: "update"|"daily", vars: {1:…,2:…} }
 * Returns { ok, channel, sid, error, dryRun, preview }.
 */
export async function sendTo(phone, msg) {
  const c = cfg(), to = e164(phone);
  if (!to) return { ok: false, error: "no phone number" };
  if (c.dryRun) return { ok: true, dryRun: true, to, preview: msg.text };
  if (!c.tw.sid || !c.tw.token) return { ok: false, error: "Twilio credentials missing" };
  const errors = [];
  for (const ch of c.channels) {
    try {
      if (ch === "whatsapp" && c.tw.waFrom) {
        const tpl = msg.template === "daily" ? c.tw.tplDaily : c.tw.tplUpdate;
        const p = { To: `whatsapp:${to}`, From: `whatsapp:${e164(c.tw.waFrom)}` };
        if (tpl) { p.ContentSid = tpl; p.ContentVariables = JSON.stringify(msg.vars || {}); }
        else p.Body = msg.text;
        const r = await twilioSend(p);
        return { ok: true, channel: "whatsapp", to, ...r };
      }
      if (ch === "sms" && (c.tw.smsFrom || c.tw.msid)) {
        const p = { To: to, Body: msg.text.slice(0, 1500) };
        if (c.tw.msid) p.MessagingServiceSid = c.tw.msid; else p.From = e164(c.tw.smsFrom);
        const r = await twilioSend(p);
        return { ok: true, channel: "sms", to, ...r };
      }
    } catch (e) { errors.push(`${ch}: ${e.message}`); }
  }
  return { ok: false, to, error: errors.join(" | ") || "no channel configured" };
}

// ---------- message wording ----------
// Template body to create in Twilio Content Template Builder (category: Utility), name "hifz_update":
//   Assalamu alaikum {{1}}. Hifz update for {{2}}: {{3}} Open the app: {{4}}
export function updateMessage({ recipientName, studentName, actorName, actorRole, summary, appUrl }) {
  const who = actorRole === "teacher" ? `${actorName || "Teacher"} (teacher)` : (actorName || studentName);
  const line = oneLine(`${who}: ${summary}`);
  const text = `Assalamu alaikum ${firstName(recipientName)}. Hifz update for ${studentName}:\n${line}\n${appUrl}`;
  return { text, template: "update", vars: { 1: firstName(recipientName) || "there", 2: studentName, 3: line, 4: appUrl } };
}
// Template "hifz_daily" (Utility):
//   Assalamu alaikum {{1}}. {{2}}'s hifz for {{3}}: {{4}} Open the app: {{5}}
export function dailyMessage({ recipientName, studentName, dateLabel, digest, appUrl }) {
  const line = oneLine(digest, 900);
  const text = `Assalamu alaikum ${firstName(recipientName)}. ${studentName}'s hifz for ${dateLabel}:\n${digest}\n${appUrl}`;
  return { text, template: "daily", vars: { 1: firstName(recipientName) || "there", 2: studentName, 3: dateLabel, 4: line, 5: appUrl } };
}

export function localParts(tz, d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
}
