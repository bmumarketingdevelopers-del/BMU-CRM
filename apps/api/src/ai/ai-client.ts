// Thin wrapper around the official Anthropic TypeScript SDK. Everything that talks to Claude goes through
// AiClient.run(), so tests can swap in a fake (provider token AI_CLIENT) and never call the real API.
import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';

export const AI_CLIENT = Symbol('AI_CLIENT');

/** Defaults follow the claude-api skill: Claude Opus 5.5 for real work, Claude Haiku 4.5 for cheap, short tasks. */
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';
export const DEFAULT_AI_FAST_MODEL = 'claude-haiku-4-5';

export const aiModel = () => process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
export const aiFastModel = () => process.env.AI_FAST_MODEL?.trim() || DEFAULT_AI_FAST_MODEL;

/** List prices in US$ per million tokens (input, output, cache read), used only for the cost estimate. */
const PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-1': [10, 50, 1],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-4-5': [1, 5, 0.1],
};
/** Fixed conversion for the estimate (₹ per US$). The bill from Anthropic is the source of truth. */
export const INR_PER_USD = 88;

export function estimateCostPaise(model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): number {
  const [inp, out, read] = PRICES[model] ?? PRICES[DEFAULT_AI_MODEL];
  const usd = (inputTokens * inp + cacheWriteTokens * inp * 1.25 + outputTokens * out + cacheReadTokens * read) / 1_000_000;
  return Math.round(usd * INR_PER_USD * 100);
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
/** Haiku 4.5 rejects the effort parameter. */
const supportsEffort = (model: string) => !model.startsWith('claude-haiku') && !model.includes('sonnet-4-5');

export type AiRunParams = {
  model: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools?: Anthropic.Beta.BetaToolUnion[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** JSON schema for structured output. */
  schema?: Record<string, unknown>;
  onText?: (delta: string) => void;
};

export interface AiClient {
  /** True when an API key (or other credential) is configured. */
  available(): boolean;
  run(params: AiRunParams): Promise<Anthropic.Beta.BetaMessage>;
}

@Injectable()
export class AnthropicAiClient implements AiClient {
  private client: Anthropic | null = null;

  available() {
    return !!process.env.ANTHROPIC_API_KEY?.trim();
  }

  private sdk() {
    // Created lazily so the API boots fine without a key (basic mode).
    this.client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim(), maxRetries: 2, timeout: 120_000 });
    return this.client;
  }

  async run(p: AiRunParams): Promise<Anthropic.Beta.BetaMessage> {
    const fallback = FALLBACK_MODELS.includes(p.model);
    const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
    if (supportsEffort(p.model)) outputConfig.effort = p.effort ?? 'low';
    if (p.schema) outputConfig.format = { type: 'json_schema', schema: p.schema };
    const stream = this.sdk().beta.messages.stream({
      model: p.model,
      max_tokens: p.maxTokens ?? 16_000,
      // The system prompt is frozen per feature (no dates or ids inside), so it caches together with the tools.
      system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } }],
      messages: p.messages,
      ...(p.tools?.length ? { tools: p.tools } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (p.onText) stream.on('text', (delta) => p.onText!(delta));
    return stream.finalMessage();
  }
}
