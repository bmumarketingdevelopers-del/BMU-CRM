# Load test results

Run 2026-10-07T06:46:57.240Z · 10 people · 30 API requests/s and 10 searches/s at the same time for 30s · 33 task edits during the run (each clears cached screens) · API http://localhost:4000 · website http://localhost:3000.

| Test | Requests | Per second | p50 | p95 | p99 | Errors | Target p95 | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| API (lists, records, dashboards) | 900 | 30 | 27 ms | 123 ms | 285 ms | 0 | 300 ms | met |
| Search | 300 | 10 | 33 ms | 99 ms | 174 ms | 0 | 200 ms | met |

Flat out (20 users, no pause, mixed calls): one API process answered 66 requests a second, p50 286 ms, p95 660 ms, 0 errors. Past this rate requests queue; run more API processes behind a load balancer to go higher.

| Page | First load (median of 3, warm) | Target | Result |
| --- | --- | --- | --- |
| / | 258 ms | 1500 ms | met |
| /services | 248 ms | 1500 ms | met |
| /admin | 327 ms | 1500 ms | met |
| /team | 348 ms | 1500 ms | met |
| /team/tasks | 334 ms | 1500 ms | met |
| /admin/pipeline | 473 ms | 1500 ms | met |
| /admin/intelligence | 357 ms | 1500 ms | met |
| /team/leads | 582 ms | 1500 ms | met |
