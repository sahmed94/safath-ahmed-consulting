// POST /.netlify/functions/hifz-daily-run   (header x-hifz-secret: <HIFZ_WEBHOOK_SECRET>)
// body: { "student_id": "<uuid>" }  (optional)  — sends today's summary now, ignoring the hour and the once-a-day guard.
// Handy for testing in production with HIFZ_DRY_RUN=1: the response shows exactly what would be sent.
import { cfg, json } from "../lib/hifz-lib.mjs";
import { runDaily } from "../lib/hifz-daily-core.mjs";

export default async (req) => {
  const c = cfg();
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!c.secret || req.headers.get("x-hifz-secret") !== c.secret) return json({ error: "unauthorized" }, 401);
  let body = {};
  try { body = await req.json(); } catch {}
  const results = await runDaily({ force: true, studentId: body.student_id || null });
  return json({ ok: true, dryRun: c.dryRun, results });
};
