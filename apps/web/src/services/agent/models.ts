import type { LlmProvider } from "../../stores/settings-store";

export interface LlmModelOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Compatible endpoints own their model catalogs — those two registries
 * intentionally stay empty so the app never invents a provider or model
 * selection for a user-supplied host. "anthropic" is different: it's a
 * genuine first-party integration (fixed endpoint, routed through our own
 * proxy), so a real, known model list is exactly what a user picking it
 * expects.
 */
export const LLM_MODELS: Record<LlmProvider, LlmModelOption[]> = {
  anthropic: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  "openai-compatible": [],
  "anthropic-compatible": [],
};

export function defaultModelFor(provider: LlmProvider): string {
  return modelsFor(provider)[0]?.id ?? "";
}

export function modelsFor(provider: LlmProvider): LlmModelOption[] {
  return LLM_MODELS[provider] ?? [];
}

export function isKnownModel(provider: LlmProvider, model: string): boolean {
  return modelsFor(provider).some((option) => option.id === model);
}

/** Accept a provider model id entered by the user, falling back only when blank. */
export function resolveModel(
  provider: LlmProvider,
  model: string | null | undefined,
): string {
  return model?.trim() || defaultModelFor(provider);
}
