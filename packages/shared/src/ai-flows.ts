// v10 AI Copilot: shared types, feature list, request schemas and the deterministic tone check used in
// basic mode (no API key) and by the automation condition "Tone of the request".
import { z } from "zod";
import type { PlanContent } from "./delivery.js";
import type { SettingsValue } from "./settings.js";

export const AI_BASIC_NOTICE = "Basic suggestions — connect AI in Command Centre → AI Copilot for smarter results";

export const AI_FEATURE_GROUPS = ["copilot", "sales", "delivery", "clientService", "management", "automations", "clientPortal", "agents"] as const;
export type AiFeatureGroup = (typeof AI_FEATURE_GROUPS)[number];
export const aiGroupLabels: Record<AiFeatureGroup, string> = {
  copilot: "Ask BMU (copilot panel, Ctrl/Cmd + J)",
  sales: "Sales: lead brief, follow-up drafts, proposal intro, meeting notes",
  delivery: "Delivery: creative briefs, captions, scripts, plan drafts, QC pre-check, feedback summary",
  clientService: "Client service: suggested replies, request triage, tone flags",
  management: "Management: weekly digest and notes on analytics pages",
  automations: "Automations: the “AI draft” action",
  clientPortal: "Client app: clients can ask about their own account",
  agents: "AI agents: Sales assistant, Request triage, Producer and Analyst (each also has its own switch on the Agents page)",
};

export const AI_FEATURE_KEYS = [
  "copilot",
  "client_ask",
  "lead_brief",
  "lead_followup",
  "proposal_intro",
  "meeting_notes",
  "creative_brief",
  "social_captions",
  "video_script",
  "plan_draft",
  "qc_precheck",
  "feedback_summary",
  "reply_suggest",
  "request_triage",
  "sentiment",
  "weekly_digest",
  "anomaly_notes",
  "automation_draft",
  "agent_run",
  "agent_ask",
  "asset_tags",
  "invoice_lines",
] as const;
export type AiFeature = (typeof AI_FEATURE_KEYS)[number];

export const aiFeatureInfo: Record<AiFeature, { label: string; group: AiFeatureGroup; fast?: boolean }> = {
  copilot: { label: "Ask BMU", group: "copilot" },
  client_ask: { label: "Client: ask about my account", group: "clientPortal" },
  lead_brief: { label: "Lead brief & next best action", group: "sales" },
  lead_followup: { label: "Follow-up draft", group: "sales", fast: true },
  proposal_intro: { label: "Proposal intro & scope", group: "sales" },
  meeting_notes: { label: "Meeting notes → actions", group: "sales", fast: true },
  creative_brief: { label: "Creative brief", group: "delivery" },
  social_captions: { label: "Captions, hashtags & hooks", group: "delivery", fast: true },
  video_script: { label: "Video script outline", group: "delivery" },
  plan_draft: { label: "Monthly plan draft", group: "delivery" },
  qc_precheck: { label: "QC pre-check", group: "delivery", fast: true },
  feedback_summary: { label: "Feedback → change list", group: "delivery", fast: true },
  reply_suggest: { label: "Suggested reply", group: "clientService", fast: true },
  request_triage: { label: "Request triage", group: "clientService", fast: true },
  sentiment: { label: "Tone flag", group: "clientService", fast: true },
  weekly_digest: { label: "Weekly digest", group: "management" },
  anomaly_notes: { label: "Notes on the numbers", group: "management", fast: true },
  automation_draft: { label: "Automation: AI draft", group: "automations", fast: true },
  agent_run: { label: "AI agent run", group: "agents" },
  agent_ask: { label: "Ask the Analyst", group: "agents" },
  asset_tags: { label: "Asset library: tags from the picture", group: "delivery", fast: true },
  invoice_lines: { label: "Invoice line descriptions", group: "management", fast: true },
};

/** Features started from a screen with POST /ai/generate (Ask BMU and the client panel use /ai/ask). */
export const AI_GENERATE_FEATURES = AI_FEATURE_KEYS.filter((f) => !["copilot", "client_ask", "automation_draft", "weekly_digest", "agent_run", "agent_ask", "asset_tags", "invoice_lines"].includes(f)) as Exclude<
  AiFeature,
  "copilot" | "client_ask" | "automation_draft" | "weekly_digest" | "agent_run" | "agent_ask" | "asset_tags" | "invoice_lines"
>[];
export type AiGenerateFeature = (typeof AI_GENERATE_FEATURES)[number];

export const AI_ANOMALY_PAGES = ["scorecard", "weekly"] as const;
export type AiAnomalyPage = (typeof AI_ANOMALY_PAGES)[number];

export const aiGenerateSchema = z.object({
  feature: z.enum(AI_GENERATE_FEATURES as [AiGenerateFeature, ...AiGenerateFeature[]]),
  targetId: z.string().trim().max(100).optional(),
  input: z.string().max(20_000).optional(),
  options: z
    .object({
      channel: z.enum(["email", "whatsapp"]).optional(),
      kind: z.enum(["thread", "request"]).optional(),
      page: z.enum(AI_ANOMALY_PAGES).optional(),
      serviceKeys: z.array(z.string().max(60)).max(20).optional(),
      leadId: z.string().max(100).optional(),
      need: z.string().max(4000).optional(),
      clientName: z.string().max(200).optional(),
    })
    .default({}),
});
export type AiGenerateInput = z.input<typeof aiGenerateSchema>;

export const aiAskSchema = z.object({
  question: z.string().trim().min(2, "Type a question").max(2000, "Keep the question under 2,000 characters"),
  conversationId: z.string().max(100).optional(),
});
export type AiAskInput = z.infer<typeof aiAskSchema>;

export type AiCitation = { label: string; href: string };
export type AiMode = "ai" | "basic";

export type AiMeetingNotes = { summary: string; actions: string[]; followUpDate: string | null };
export type AiTriage = {
  type: "change" | "new_scope" | "urgent" | "question" | "billing";
  urgency: "low" | "normal" | "high";
  scope: "in_scope" | "out_of_scope" | "unclear";
  reasoning: string;
  addOn: { id: string; name: string; pricePaise: number | null } | null;
  suggestedQuotePaise: number | null;
};
export type AiTone = "negative" | "urgent" | "positive" | "neutral";
export type AiToneResult = { tone: AiTone; reason: string };
export type AiQcIssue = { kind: "spelling" | "brand" | "claim" | "style"; text: string; suggestion: string };

/** Structured part of a result, when a feature has one (the text is always filled too). */
export type AiStructured =
  | { kind: "meeting_notes"; value: AiMeetingNotes }
  | { kind: "triage"; value: AiTriage }
  | { kind: "plan"; value: PlanContent }
  | { kind: "tone"; value: AiToneResult & { items?: { id: string; tone: AiTone }[] } }
  | { kind: "qc"; value: AiQcIssue[] }
  | { kind: "invoice_lines"; value: { lines: { title: string; details: string }[] } };

export type AiResult = {
  feature: AiFeature;
  mode: AiMode;
  text: string;
  data: AiStructured | null;
  citations: AiCitation[];
  /** Plain-English line shown above the result (basic mode label, budget reached, etc). */
  notice: string | null;
  logId: string | null;
  conversationId?: string;
};

export type AiStreamEvent = { t: "delta"; text: string } | { t: "status"; text: string } | { t: "done"; result: AiResult } | { t: "error"; message: string };

export type AiSettings = SettingsValue<"ai">;

export type AiStatus = {
  enabled: boolean;
  /** An Anthropic API key is configured on the server. */
  connected: boolean;
  mode: AiMode | "off";
  model: string;
  fastModel: string;
  features: Record<AiFeatureGroup, boolean>;
  canManage: boolean;
  notice: string | null;
};

export type AiLogRow = {
  id: string;
  at: string;
  user: string | null;
  feature: string;
  featureLabel: string;
  mode: string;
  status: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costPaise: number;
  latencyMs: number;
  error: string | null;
};

export type AiUsageView = {
  settings: AiSettings;
  connected: boolean;
  model: string;
  fastModel: string;
  canEdit: boolean;
  month: {
    label: string;
    calls: number;
    aiCalls: number;
    basicCalls: number;
    blocked: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    costPaise: number;
    budgetPct: number | null;
    tokenPct: number | null;
    avgLatencyMs: number | null;
  };
  byFeature: { feature: string; label: string; calls: number; costPaise: number; avgLatencyMs: number }[];
  byUser: { userId: string; name: string; calls: number; costPaise: number }[];
  daily: { labels: string[]; calls: number[] };
  recent: AiLogRow[];
};

export type AiChatMessage = { role: "user" | "assistant"; text: string; citations: AiCitation[]; mode?: AiMode; notice?: string | null; at: string };
export type AiConversationSummary = { id: string; title: string; updatedAt: string };
export type AiConversationView = AiConversationSummary & { messages: AiChatMessage[] };

export type AiDigestView = { id: string; text: string; mode: AiMode; createdAt: string; weekStart: string; notice: string | null; citations: AiCitation[] };

// ---------------------------------------------------------------------------
// Deterministic tone check (basic mode, automations). Cheap and predictable on purpose.

const URGENT = ["urgent", "asap", "immediately", "right away", "right now", "emergency", "critical", "today itself", "by today", "by eod", "end of day", "at the earliest", "tomorrow morning", "launch tomorrow", "time sensitive", "top priority"];
const NEGATIVE = [
  "disappointed",
  "unhappy",
  "not happy",
  "frustrated",
  "angry",
  "upset",
  "poor quality",
  "worst",
  "terrible",
  "horrible",
  "pathetic",
  "unacceptable",
  "delayed",
  "delay again",
  "late again",
  "still waiting",
  "no response",
  "no reply",
  "not satisfied",
  "dissatisfied",
  "cancel",
  "refund",
  "complaint",
  "complain",
  "wrong",
  "mistake",
  "waste",
  "not acceptable",
  "not good",
  "not up to the mark",
  "very bad",
  "fed up",
  "escalate",
];
const POSITIVE = ["thank", "great", "love", "excellent", "awesome", "happy with", "perfect", "amazing", "good job", "well done", "appreciate", "fantastic", "superb", "looks good", "nice work"];

const hits = (text: string, words: string[]) => words.filter((w) => text.includes(w));

export function aiToneOf(raw: string): AiToneResult {
  const text = ` ${raw.toLowerCase().replace(/\s+/g, " ")} `;
  const neg = hits(text, NEGATIVE);
  const urgent = hits(text, URGENT);
  const pos = hits(text, POSITIVE).filter((p) => !text.includes(`not ${p}`));
  const shouting = (raw.match(/!/g)?.length ?? 0) >= 3 || (raw.length > 12 && raw === raw.toUpperCase() && /[A-Z]/.test(raw));
  if (neg.length > pos.length || (neg.length && shouting)) return { tone: "negative", reason: `Words like “${neg.slice(0, 3).join("”, “")}”${shouting ? " and strong punctuation" : ""}` };
  if (urgent.length) return { tone: "urgent", reason: `Asks for speed: “${urgent.slice(0, 3).join("”, “")}”` };
  if (pos.length) return { tone: "positive", reason: `Words like “${pos.slice(0, 3).join("”, “")}”` };
  return { tone: "neutral", reason: "No strong words either way" };
}

export const aiToneLabels: Record<AiTone, string> = { negative: "Unhappy", urgent: "Urgent", positive: "Happy", neutral: "Neutral" };
