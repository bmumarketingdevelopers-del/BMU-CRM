-- BMU Hub on Vercel: runs the background jobs (reminders, workflows, scheduled posts, webhooks, digests) once a
-- minute by calling the API's /cron/tick from Supabase itself. Works on every Vercel plan (Vercel's own Cron Jobs
-- only run once a day on the Hobby plan).
--
-- Run once in Supabase: dashboard > SQL Editor > New query, after replacing the two values below:
--   https://YOUR-API.vercel.app   the address of the API project on Vercel (not the website)
--   YOUR_CRON_SECRET              the same value as CRON_SECRET in the API project's environment variables
-- Running it again replaces the schedule. To stop it: select cron.unschedule('bmu-hub-tick');
-- To see recent calls: select * from net._http_response order by created desc limit 20;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'bmu-hub-tick';

select cron.schedule(
  'bmu-hub-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-API.vercel.app/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);
