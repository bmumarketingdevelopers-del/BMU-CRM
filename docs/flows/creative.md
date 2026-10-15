# v16 Creative studio

Fourth phase (v16) of `docs/spec/architecture-v2.json`. Runs inside the API with only PostgreSQL. Files are stored on
the local disk under `apps/api/storage/` (S3/R2 later). Video previews rely on the browser (no ffmpeg on the server).
Publishing to Instagram, Facebook and the rest is done by hand on each platform until integrations exist; results are
typed in from each platform's insights.

## Asset library (`apps/api/src/creative/assets.*`, `packages/shared/src/creative-types.ts`)

- `Asset` (title, kind, client, collection, tags, AI tags, source, `clientVisible`, rights) with `AssetVersion` rows
  pointing at `File`. `currentVersionId` picks the version shown; **Make current** switches back to any version.
- Sources: `upload`, `brand`, `deliverable`. When the client approves work (portal, email link, or BMU where allowed)
  `fromApprovedDeliverable` adds the approved version to the deliverable's asset (one asset per deliverable) and
  shares it with the client.
- Who sees what: Founder, Admin, finance and department heads see every client; everyone else sees the clients they
  manage or have tasks for, plus BMU-wide assets (no client). Clients see only `clientVisible` assets of their own.
  Archive is for leadership and the client's CM. Share links reuse the v11 file share links (expiry, password, views).
- Rights: note, end date and creator. States `none / ok / expiring (≤30 days) / expired`. The timer warns the CM
  7 days before (once, `rightsWarnedAt`).
- AI tags (images only, needs `ANTHROPIC_API_KEY`): suggested on upload and on **Suggest tags**; search covers them.

### Resumable upload (`/assets/uploads`)

1. `POST /assets/uploads` `{ name, size, mimeType, assetId? | clientOrgId, collectionId, tags }` (max 5 GB).
2. `PUT /assets/uploads/:id?offset=N` with the raw bytes (`application/octet-stream`, at most 2 × 4 MB). The body is
   streamed to `storage/tmp/<id>.part`. A piece at the wrong offset is ignored and the current position returned.
3. `GET /assets/uploads/:id` returns `received` (the file size on disk is the truth, so a cut-off piece only counts
   what arrived). The web uploader remembers the session per file in the browser and resumes after a reload.
4. `POST /assets/uploads/:id/complete` moves the file to `storage/assets/YYYY-MM/`, records its SHA-256 and creates
   the asset or its next version. Unfinished sessions untouched for 2 days are cleaned up.

## Proofing (`proofing.service.ts`, `components/review-viewer.tsx`)

- Comment anchors (`reviewAnchorSchema`): `t` (seconds), `x`/`y` (percent of the frame), `page`, and `drawing`
  (up to 20 freehand strokes of percent points). On video a comment can carry a moment, a spot and a drawing.
- The viewer draws pins and drawings over images, and over video only while playback is within 0.5 s of the comment.
  The frame box hugs the video, so percent positions land on the same spot for everyone. Timeline markers sit under
  the video; clicking a time pauses and seeks there.
- Live: comments are `Comment` change events, so a team member's open deliverable page reloads quietly when the client
  comments (the page drops its own last result when live data arrives).
- New version: `carryOpenComments` copies unresolved comments to the new version with `carriedFromId` (shown as
  "Carried over from vN"). Resolve and reopen are the v10 craft endpoints.
- Rounds (`proofRounds`): per version, the internal QC result, when it went to the client and the client's decision
  (portal, email, WhatsApp or BMU). Clients see only "checked by BMU" for the internal step.

### One-tap approval links

`sendToClient` now calls `sendReviewLinks`: each client decider gets an email with a **Review and approve** button
(`/proof/<token>`) and, when they have a phone, a WhatsApp message in the queue. Tokens are random, stored as SHA-256,
valid 14 days and single use. `/proof/<token>` needs no sign-in; the decision runs through the same approval rules as
the portal (`via: email | whatsapp`, IP recorded). It fails once the work is no longer waiting for the client.

### Approval certificate

Issued when the final approval lands: deliverable, client, service, approved version (name, size, SHA-256 of the
file), internal check, every approver with time, method and IP, the approval rule, rounds and comment count. The
record is sealed with a SHA-256 of its canonical JSON. `valid` re-checks the seal and the file's checksum. Pages:
`/team/deliverables/<id>/certificate` and `/client/reviews/<id>/certificate` (print or save as PDF).

## Content calendar rules (`deliver-calendar.service.ts`, `creative.service.ts`)

- Only work with an approval on record (`approvedVersionId`) can be scheduled or marked published. "Ready to schedule"
  lists only such work.
- `ClientOrg.publishNeedsApproval` (default on). When a client switches it off (team: Content calendar → Channels and
  publishing rules, leadership or the client's CM), leadership or the CM can **Approve for publishing** a QC-passed
  social post themselves; this records an approval `via: bmu` and a certificate.
- Captions live on the deliverable. Channels per client (`ContentChannel`). Posts past their time and not published are
  listed under **Due to post now**; the CM is notified once (`publishDueNotifiedAt`, reset on reschedule).
- Results (`PostMetric`): reach, impressions, engagement, clicks and spend, typed in after publishing (newest wins).
  The results summary shows totals, by client and the best posts; clients see their own on their calendar.

## Brand kits

Colours, fonts, notes and files (v10) plus tone of voice, do's, don'ts and competitors. Team → **Brand kits** lists every
client with a completeness score; clients see theirs under **Brand kit** (read only). Agents' knowledge includes them.

## Creative reviewer agent

Fifth agent (`creative_reviewer`, switched off by default). It looks at the latest version of work waiting for QC
and adds an internal note on the version (`add_version_note`, automatic and undoable), notifying the maker when it
finds problems. Basic mode (no key) checks the file against the deliverable type (a video for a reel, a still for a
post), flags files over 250 MB and lists the brand kit's don'ts. With a key it also looks at the image itself.

## Tests

- API: `apps/api/test/creative.e2e-spec.ts` (uploads, versions, rights, visibility, the 0:12 pin with a drawing,
  carry-over, the email link, certificates, calendar rules, results, brand kits, the reviewer in basic mode).
- Browser: `apps/web/e2e/creative/creative.mjs` (the client pins at 0:12 and the CM sees it live on that frame,
  carry-over, one-tap approval from a phone, the certificate, schedule/publish/results, both asset libraries, BMU
  sign-off).
