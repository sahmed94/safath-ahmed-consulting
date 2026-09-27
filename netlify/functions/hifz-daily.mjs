// Scheduled hourly. For every student whose local time has reached their daily_hour (default 21:00),
// send the day's summary to BOTH the student and the teacher, once per local day.
// The summary text is written by the app into data.days[YYYY-MM-DD].digest every time something is saved,
// so the server never needs Quran metadata to describe the day.
//
// Test without waiting: Netlify → Functions → hifz-daily → "Run now" (published deploys only),
// or POST /.netlify/functions/hifz-daily-run with header x-hifz-secret (see hifz-daily-run.mjs).
import { runDaily } from "../lib/hifz-daily-core.mjs";
import { env } from "../lib/hifz-lib.mjs";

export default async () => {
  // This runs every hour from the moment it is deployed, but the Supabase settings are
  // added by hand afterwards. Without this it would throw on an unset URL sixty times a
  // day and fill the function log with failures for a feature that simply is not set up
  // yet. Say so once and do nothing.
  if (!env("HIFZ_SUPABASE_URL") || !env("HIFZ_SUPABASE_SERVICE_KEY")) {
    console.log("hifz-daily: HIFZ_SUPABASE_URL / HIFZ_SUPABASE_SERVICE_KEY not set, skipping.");
    return;
  }
  const results = await runDaily();
  console.log("hifz-daily", JSON.stringify(results).slice(0, 2000));
};

export const config = { schedule: "@hourly" };
