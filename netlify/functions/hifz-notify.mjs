// POST /.netlify/functions/hifz-notify
// Sends the "other person" a message for one hifz event:
//   student acted → message the teacher;  teacher acted → message the student.
//
// Two ways in (both are idempotent — the first caller claims the event, the second is skipped):
//   1. Supabase Database Webhook on INSERT into hifz_events, header  x-hifz-secret: <HIFZ_WEBHOOK_SECRET>
//      body: { type:"INSERT", table:"hifz_events", record:{...} }
//   2. The app itself right after it writes an event:  Authorization: Bearer <user access token>
//      body: { event_id: 123 }
import { cfg, sb, json, userFromToken, sendTo, updateMessage, digits } from "../lib/hifz-lib.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const c = cfg();
  if (!c.sbUrl || !c.sbService) return json({ error: "server not configured (HIFZ_SUPABASE_URL / HIFZ_SUPABASE_SERVICE_KEY)" }, 500);

  let body = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // --- authenticate the caller
  const viaWebhook = c.secret && req.headers.get("x-hifz-secret") === c.secret;
  let caller = null;
  if (!viaWebhook) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    caller = await userFromToken(token);
    if (!caller) return json({ error: "unauthorized" }, 401);
  }
  const eventId = body.event_id ?? body.record?.id;
  if (!eventId) return json({ error: "event_id missing" }, 400);

  // --- load event + student
  const rows = await sb(`hifz_events?id=eq.${encodeURIComponent(eventId)}&select=*,student:hifz_students(id,full_name,student_email,phone,teacher_name,teacher_email,teacher_phone,notify_every_update)`);
  const ev = rows?.[0];
  if (!ev) return json({ error: "event not found" }, 404);
  const st = ev.student;
  if (caller && caller.email !== st.student_email && caller.email !== st.teacher_email) return json({ error: "forbidden" }, 403);

  // --- claim it (only one caller sends)
  const claimed = await sb(`hifz_events?id=eq.${ev.id}&notify_status=eq.pending`, { method: "PATCH", body: { notify_status: "sending" }, prefer: "return=representation" });
  if (!claimed?.length) return json({ ok: true, skipped: "already handled" });

  const finish = (status, detail) => sb(`hifz_events?id=eq.${ev.id}`, { method: "PATCH", body: { notify_status: status, notify_detail: detail, notified_at: new Date().toISOString() } });

  if (!st.notify_every_update) { await finish("skipped", { reason: "notify_every_update is off" }); return json({ ok: true, skipped: "off" }); }

  const toTeacher = ev.actor_role === "student";
  const recipient = toTeacher ? { name: st.teacher_name, phone: st.teacher_phone } : { name: st.full_name, phone: st.phone };
  if (!digits(recipient.phone)) { await finish("skipped", { reason: `no ${toTeacher ? "teacher" : "student"} phone` }); return json({ ok: true, skipped: "no phone" }); }

  const msg = updateMessage({ recipientName: recipient.name, studentName: st.full_name, actorName: ev.actor_name, actorRole: ev.actor_role, summary: ev.summary, appUrl: c.appUrl });
  const res = await sendTo(recipient.phone, msg);
  await finish(res.dryRun ? "dry_run" : res.ok ? "sent" : "failed", { to: toTeacher ? "teacher" : "student", ...res, text: msg.text });
  return json({ ok: res.ok, status: res.dryRun ? "dry_run" : res.ok ? "sent" : "failed", detail: res });
};
