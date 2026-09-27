// Shared by hifz-daily (scheduled) and hifz-daily-run (manual trigger).
import { cfg, sb, sendTo, dailyMessage, localParts, digits } from "./hifz-lib.mjs";

export async function runDaily({ force = false, studentId = null } = {}) {
  const c = cfg();
  const students = await sb(`hifz_students?select=id,full_name,phone,teacher_name,teacher_phone,timezone,notify_daily,daily_hour,data${studentId ? `&id=eq.${studentId}` : ""}`);
  const results = [];
  for (const st of students || []) {
    if (!st.notify_daily && !force) continue;
    const { date, hour } = localParts(st.timezone);
    if (!force && hour < (st.daily_hour ?? 21)) continue;
    const sent = await sb(`hifz_daily_sent?student_id=eq.${st.id}&local_date=eq.${date}&select=student_id`);
    if (sent?.length && !force) continue;

    const day = st.data?.days?.[date];
    const digest = day?.digest || "No hifz was logged today.";
    const dateLabel = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
    const out = {};
    for (const who of ["student", "teacher"]) {
      const phone = who === "student" ? st.phone : st.teacher_phone;
      if (!digits(phone)) { out[who] = { ok: false, error: "no phone" }; continue; }
      const msg = dailyMessage({ recipientName: who === "student" ? st.full_name : st.teacher_name, studentName: st.full_name, dateLabel, digest, appUrl: c.appUrl });
      out[who] = { ...(await sendTo(phone, msg)), text: msg.text };
    }
    await sb(`hifz_daily_sent`, { method: "POST", body: { student_id: st.id, local_date: date, detail: out }, prefer: "resolution=merge-duplicates" });
    results.push({ student: st.full_name, date, out });
  }
  return results;
}

