// v16 creative studio: asset library (versions, collections, rights, big resumable uploads), proofing rounds and
// approval certificates, one-tap approval links, content channels and post results. The API enforces every rule;
// the web only shows them.
import { z } from "zod";
import type { FileKind } from "./production.js";
import { DELIVER_CHANNELS, type DeliverChannel } from "./deliver-flows.js";

// ------------------------------------------------------------------------------------------------ asset library

/** Largest file the resumable uploader accepts (5 GB). */
export const ASSET_MAX_BYTES = 5 * 1024 ** 3;
/** Size of each upload piece. Small enough to pass any proxy, big enough to be quick. */
export const ASSET_CHUNK_BYTES = 4 * 1024 * 1024;

export const ASSET_SOURCES = ["upload", "deliverable", "brand"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];
export const assetSourceLabels: Record<AssetSource, string> = { upload: "Uploaded", deliverable: "Approved work", brand: "Brand file" };

export type AssetRightsState = "none" | "ok" | "expiring" | "expired";
export const assetRightsLabels: Record<AssetRightsState, string> = { none: "No limits noted", ok: "Rights OK", expiring: "Rights end soon", expired: "Rights ended" };

export type AssetFileView = {
  id: string;
  number: number;
  kind: FileKind;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Same-origin URL (served by the API with access checks) or the external link. */
  url: string;
  note: string | null;
  uploadedBy: string;
  at: string;
};

export type AssetRow = {
  id: string;
  title: string;
  kind: FileKind;
  client: { id: string; name: string } | null;
  collection: { id: string; name: string } | null;
  tags: string[];
  /** Tags the AI suggested from what is in the picture (only with an AI key). */
  aiTags: string[];
  source: AssetSource;
  clientVisible: boolean;
  versions: number;
  current: AssetFileView;
  rights: { note: string | null; expiresAt: string | null; creator: { id: string; name: string } | null; state: AssetRightsState };
  createdBy: string;
  updatedAt: string;
};

export type AssetDetail = AssetRow & {
  history: AssetFileView[];
  deliverable: { id: string; title: string } | null;
  fileId: string;
  archived: boolean;
  can: { edit: boolean; share: boolean; archive: boolean; newVersion: boolean };
};

export type AssetCollectionView = { id: string; name: string; description: string | null; client: { id: string; name: string } | null; count: number };

export type AssetList = {
  items: AssetRow[];
  total: number;
  collections: AssetCollectionView[];
  tags: { tag: string; count: number }[];
  clients: { id: string; name: string }[];
  creators: { id: string; name: string }[];
  rightsEnding: number;
  canUpload: boolean;
};

export type AssetQuery = { q?: string; clientId?: string; collectionId?: string; kind?: string; tag?: string; rights?: "expiring" | "expired"; archived?: "1" };

const tag = z.string().trim().toLowerCase().min(1).max(30);

export const assetUpdateSchema = z.object({
  title: z.string().trim().min(1, "Give the asset a name").max(160).optional(),
  tags: z.array(tag).max(20).optional(),
  collectionId: z.string().nullable().optional(),
  clientOrgId: z.string().nullable().optional(),
  clientVisible: z.boolean().optional(),
  rightsNote: z.string().trim().max(500).nullable().optional(),
  rightsExpireAt: z.string().date().nullable().optional(),
  creatorId: z.string().nullable().optional(),
});
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

export const assetCollectionInputSchema = z.object({
  name: z.string().trim().min(2, "Name the collection (e.g. Diwali 2026)").max(80),
  description: z.string().trim().max(300).optional(),
  clientOrgId: z.string().nullable().optional(),
});
export type AssetCollectionInput = z.infer<typeof assetCollectionInputSchema>;

export const assetLinkSchema = z.object({
  url: z.string().url("Paste a full link (https://…)"),
  title: z.string().trim().min(1).max(160).optional(),
  clientOrgId: z.string().nullable().optional(),
  collectionId: z.string().nullable().optional(),
  assetId: z.string().optional(),
  note: z.string().trim().max(500).optional(),
});
export type AssetLinkInput = z.infer<typeof assetLinkSchema>;

/** Starts a resumable upload. With assetId the file becomes that asset's next version. */
export const uploadStartSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1).max(ASSET_MAX_BYTES, "Files can be up to 5 GB"),
  mimeType: z.string().trim().max(120).default("application/octet-stream"),
  assetId: z.string().optional(),
  title: z.string().trim().max(160).optional(),
  clientOrgId: z.string().nullable().optional(),
  collectionId: z.string().nullable().optional(),
  tags: z.array(tag).max(20).optional(),
  note: z.string().trim().max(500).optional(),
});
export type UploadStart = z.infer<typeof uploadStartSchema>;

export type UploadSessionView = { id: string; name: string; size: number; received: number; chunkSize: number; done: boolean; assetId: string | null };

// ------------------------------------------------------------------------------------------------ proofing

export type ProofRoundView = {
  versionId: string;
  number: number;
  uploadedBy: string;
  uploadedAt: string;
  /** Internal step (QC). Hidden from clients except "checked". */
  internal: { result: "pass" | "fail"; by: string | null; at: string } | null;
  sentAt: string | null;
  client: { decision: "approved" | "changes_requested"; by: string; at: string; via: string | null } | null;
  comments: number;
  openComments: number;
  carriedOver: number;
};

export type ApprovalCertificateView = {
  id: string;
  code: string;
  deliverable: { id: string; title: string; type: string };
  client: string;
  service: string;
  version: { number: number; name: string | null; checksum: string | null; sizeBytes: number | null; uploadedAt: string };
  internal: { by: string; at: string } | null;
  approvals: { name: string; email: string | null; at: string; via: string; ip: string | null }[];
  rule: string;
  rounds: number;
  comments: number;
  /** SHA-256 of everything above, so any later change shows. */
  hash: string;
  valid: boolean;
  issuedAt: string;
};

/** The page behind a one-tap approval link from email or WhatsApp. */
export type ProofLinkView = {
  title: string;
  client: string;
  service: string;
  forName: string;
  version: { number: number; kind: FileKind; name: string | null; url: string; note: string | null };
  openComments: number;
  status: "waiting" | "approved" | "changes_requested" | "closed";
  message: string | null;
};

export const proofDecisionSchema = z.object({
  decision: z.enum(["approve", "changes"]),
  comment: z.string().trim().max(4000).optional(),
});
export type ProofDecision = z.infer<typeof proofDecisionSchema>;

// ------------------------------------------------------------------------------------------------ brand kits

export type BrandKitListItem = { clientId: string; client: string; colours: string[]; fonts: string[]; files: number; complete: number; updatedAt: string | null };

// ------------------------------------------------------------------------------------------------ content calendar

export type ContentChannelView = { id: string; clientId: string; client: string; platform: DeliverChannel; handle: string; url: string | null };

export const contentChannelInputSchema = z.object({
  clientOrgId: z.string(),
  platform: z.enum(DELIVER_CHANNELS),
  handle: z.string().trim().min(1, "Add the account name (e.g. @kavyabakery)").max(80),
  url: z.string().url().nullable().optional(),
});
export type ContentChannelInput = z.infer<typeof contentChannelInputSchema>;

export const postCaptionSchema = z.object({ caption: z.string().trim().max(2200).nullable() });

export const postMetricInputSchema = z.object({
  reach: z.number().int().min(0).max(1e9).default(0),
  impressions: z.number().int().min(0).max(1e9).default(0),
  engagement: z.number().int().min(0).max(1e9).default(0),
  clicks: z.number().int().min(0).max(1e9).default(0),
  spendRupees: z.number().min(0).max(1e8).default(0),
});
export type PostMetricInput = z.infer<typeof postMetricInputSchema>;

export type PostMetricView = { reach: number; impressions: number; engagement: number; clicks: number; spendPaise: number; recordedBy: string; at: string };

export const publishRuleSchema = z.object({ publishNeedsApproval: z.boolean() });

export type CreativeSettingsView = { channels: ContentChannelView[]; rules: { clientId: string; client: string; publishNeedsApproval: boolean }[]; canEdit: boolean };

export type PostResultsSummary = {
  from: string;
  to: string;
  posts: number;
  withResults: number;
  totals: { reach: number; impressions: number; engagement: number; clicks: number; spendPaise: number };
  byClient: { clientId: string; client: string; posts: number; reach: number; engagement: number; clicks: number; spendPaise: number }[];
  top: { deliverableId: string; title: string; client: string; channel: string | null; reach: number; engagement: number; liveUrl: string | null }[];
};
