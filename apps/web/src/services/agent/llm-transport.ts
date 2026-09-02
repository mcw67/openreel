import {
  withRetry,
  makeClientFromSend,
  llmHttpError,
  parseRetryAfterMs,
} from "@openreel/agent";
import type { LLMClient } from "@openreel/agent";
import { apiFetch } from "../api-proxy";
import type { LlmProvider } from "../../stores/settings-store";

const PATHS: Record<LlmProvider, string> = {
  anthropic: "/messages",
  "openai-compatible": "/chat/completions",
  "anthropic-compatible": "/messages",
};

function makeSend(
  provider: LlmProvider,
  apiKey: string,
  baseUrl?: string,
  signal?: AbortSignal,
  workspaceId?: string,
) {
  return async (body: unknown): Promise<unknown> => {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    let res: Response;
    try {
      res = await apiFetch(provider, PATHS[provider], apiKey, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider === "anthropic" && workspaceId
            ? { "x-proxy-workspace-id": workspaceId }
            : {}),
        },
        body: JSON.stringify(body),
        baseUrl,
        signal,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(
          provider === "anthropic"
            ? "Could not reach Claude. The nugit proxy may be unreachable — try again shortly."
            : "Could not reach the compatible endpoint. Check its URL, availability, and browser CORS settings.",
        );
      }
      throw error;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw llmHttpError(
        provider,
        res.status,
        text,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res.json();
  };
}

export interface BYOKClientOptions {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  /** Required only for identity-linked Anthropic keys (SSO/Console workspaces). */
  readonly workspaceId?: string;
}

/**
 * Builds an @openreel/agent LLMClient whose transport routes through the
 * existing BYOK apiFetch (same-origin Pages proxy for built-ins, direct browser
 * requests for custom endpoints, and keychain-backed native requests on desktop).
 */
export function makeBYOKClient(opts: BYOKClientOptions): LLMClient {
  const send = withRetry(
    makeSend(opts.provider, opts.apiKey, opts.baseUrl, opts.signal, opts.workspaceId),
    { signal: opts.signal },
  );
  return makeClientFromSend({
    provider:
      opts.provider === "anthropic-compatible" || opts.provider === "anthropic"
        ? "anthropic"
        : "openai",
    model: opts.model,
    maxTokens: opts.maxTokens,
    omitMaxTokens: opts.provider === "openai-compatible" && opts.maxTokens === undefined,
    send,
  });
}
