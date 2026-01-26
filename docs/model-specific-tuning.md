# Model-Specific Tuning

Different LLM providers and models have different characteristics. This guide covers how to adapt your agent to work well across models using the pi-ai library.

## The pi-ai Unified Interface

pi-ai provides a unified interface across 20+ providers:

```typescript
import { getModel, getProviders, getModels, streamSimple } from "@mariozechner/pi-ai";

// Get available providers
const providers = getProviders();
// ["anthropic", "openai", "google", "openrouter", ...]

// Get models for a provider
const models = getModels("anthropic");
// ["claude-opus-4-20250514", "claude-sonnet-4-20250514", ...]

// Get a specific model
const model = getModel("anthropic", "claude-sonnet-4");

// Stream with unified interface
for await (const event of streamSimple(model, context, options)) {
  // Same event types across all providers
}
```

## Model Capabilities

Each model has defined capabilities:

```typescript
interface Model {
  id: string;              // e.g., "claude-sonnet-4-20250514"
  name: string;            // Display name
  api: Api;                // API protocol
  provider: Provider;      // Provider identifier
  reasoning: boolean;      // Supports extended thinking?
  input: ("text" | "image")[];  // Input modalities
  contextWindow: number;   // Max input tokens
  maxTokens: number;       // Max output tokens
  cost: {
    input: number;         // Cost per 1M input tokens
    output: number;        // Cost per 1M output tokens
  };
}
```

### Checking Capabilities

```typescript
function selectModelForTask(provider: string, task: TaskType): Model {
  const models = getModels(provider);

  if (task === "complex_reasoning") {
    // Prefer models with reasoning capability
    const reasoningModel = models.find(m =>
      getModel(provider, m).reasoning
    );
    if (reasoningModel) {
      return getModel(provider, reasoningModel);
    }
  }

  if (task === "image_analysis") {
    // Require image input capability
    const imageModel = models.find(m =>
      getModel(provider, m).input.includes("image")
    );
    if (!imageModel) {
      throw new Error(`No image-capable model for ${provider}`);
    }
    return getModel(provider, imageModel);
  }

  // Default to first available
  return getModel(provider, models[0]);
}
```

## Provider-Specific Quirks

### Anthropic (Claude)

**Strengths**: Consistent tool use, good at following complex instructions

**Configuration**:
```typescript
const model = getModel("anthropic", "claude-sonnet-4");

// Anthropic supports extended thinking
const options = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  reasoning: "medium",  // minimal | low | medium | high | xhigh
};

for await (const event of streamSimple(model, context, options)) {
  if (event.type === "thinking") {
    // Extended thinking content
    console.log("Thinking:", event.text);
  }
}
```

### OpenAI (GPT)

**Strengths**: Fast, good at structured output

**Configuration**:
```typescript
const model = getModel("openai", "gpt-4o");

const options = {
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.7,
};
```

### Google (Gemini)

**Strengths**: Large context window, web search grounding

**Quirks**: Gemini 3 models require temperature=1.0 to avoid looping

**Configuration**:
```typescript
const model = getModel("google", "gemini-2.5-pro");

// Gemini supports web search grounding
const options = {
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 1.0,  // Required for Gemini 3
  reasoning: "high",
};
```

### OpenRouter

**Strengths**: Access to many models through single API

**Configuration**:
```typescript
const model = getModel("openrouter", "anthropic/claude-sonnet-4");

const options = {
  apiKey: process.env.OPENROUTER_API_KEY,
};
```

## Detecting and Adapting to Models

### Model Detection Pattern

```typescript
function isGemini3(modelId: string): boolean {
  return /gemini[- ]?3/i.test(modelId);
}

function isClaudeOpus(modelId: string): boolean {
  return /claude.*opus/i.test(modelId);
}

function getModelFamily(model: Model): string {
  if (model.provider === "anthropic") return "claude";
  if (model.provider === "openai") return "gpt";
  if (model.provider === "google") return "gemini";
  return "unknown";
}
```

### Adaptive Configuration

```typescript
interface AgentConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  reasoning?: ThinkingLevel;
  temperature?: number;
}

function buildStreamOptions(config: AgentConfig): StreamOptions {
  const options: StreamOptions = {
    apiKey: config.apiKey,
  };

  // Model-specific temperature adjustments
  if (isGemini3(config.modelId)) {
    // Gemini 3 requires temperature=1.0
    if (config.temperature !== undefined && config.temperature < 1.0) {
      console.warn(
        `Gemini 3 requires temperature=1.0, got ${config.temperature}. Overriding.`
      );
    }
    options.temperature = 1.0;
  } else if (config.temperature !== undefined) {
    options.temperature = config.temperature;
  }

  // Model-specific reasoning adjustments
  if (config.reasoning && config.reasoning !== "off") {
    if (isGemini3(config.modelId)) {
      // Gemini 3 only supports low/high
      options.reasoning = mapToGemini3ThinkingLevel(config.reasoning);
    } else {
      options.reasoning = config.reasoning;
    }
  }

  return options;
}

function mapToGemini3ThinkingLevel(level: ThinkingLevel): "low" | "high" {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "high":
    case "xhigh":
      return "high";
    default:
      return "low";
  }
}
```

## Reasoning/Thinking Levels

Extended thinking allows models to reason before responding:

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// Configure thinking level
const agent = new Agent({
  initialState: {
    thinkingLevel: "medium",
    // ...
  },
});

// Or set dynamically
agent.setThinkingLevel("high");
```

### When to Use Extended Thinking

| Task Type | Recommended Level |
|-----------|-------------------|
| Simple queries | off |
| Code review | low - medium |
| Complex debugging | medium - high |
| Architectural decisions | high - xhigh |
| Security analysis | high |

### Token Budget Mapping

Some providers use token budgets instead of named levels:

```typescript
const thinkingBudgets: ThinkingBudgets = {
  low: 1000,
  medium: 5000,
  high: 10000,
  xhigh: 20000,
};

const agent = new Agent({
  initialState: { /* ... */ },
  thinkingBudgets,
});
```

## Cost Management

### Tracking Costs

```typescript
let totalCost = 0;
let totalTokens = { input: 0, output: 0 };

agent.subscribe((event) => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    const usage = event.message.usage;
    totalTokens.input += usage.inputTokens;
    totalTokens.output += usage.outputTokens;

    // Calculate cost using model pricing
    const model = agent.state.model;
    const cost =
      (usage.inputTokens / 1_000_000) * model.cost.input +
      (usage.outputTokens / 1_000_000) * model.cost.output;
    totalCost += cost;
  }
});

// After completion
console.log(`Total: ${totalTokens.input + totalTokens.output} tokens, $${totalCost.toFixed(4)}`);
```

### Cost-Aware Model Selection

```typescript
function selectModelForBudget(
  provider: string,
  maxCostPerMToken: number,
): Model | null {
  const models = getModels(provider);

  for (const modelId of models) {
    const model = getModel(provider, modelId);
    const avgCost = (model.cost.input + model.cost.output) / 2;

    if (avgCost <= maxCostPerMToken) {
      return model;
    }
  }

  return null;
}
```

## Handling Provider Errors

### Rate Limits

```typescript
class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

async function runWithRateLimitHandling(
  agent: Agent,
  prompt: string,
): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await agent.prompt(prompt);
      return;
    } catch (error) {
      if (error instanceof RateLimitError) {
        const delay = error.retryAfter || Math.pow(2, attempt) * 1000;
        console.warn(`Rate limited, waiting ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}
```

### Provider-Specific Error Detection

```typescript
function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("quota exceeded") ||
    message.includes("too many requests")
  );
}

function isContextLengthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("context length") ||
    message.includes("maximum context") ||
    message.includes("too many tokens")
  );
}
```

## Provider Normalization

Normalize provider names from user input:

```typescript
function normalizeProvider(input: string): string {
  const lower = input.toLowerCase().trim();

  const aliases: Record<string, string> = {
    gemini: "google",
    vertex: "google-vertex",
    "vertex-ai": "google-vertex",
    claude: "anthropic",
    gpt: "openai",
    chatgpt: "openai",
  };

  return aliases[lower] || lower;
}

// Usage
const provider = normalizeProvider(config.provider); // "gemini" → "google"
const model = getModel(provider, config.modelId);
```

## Feature Detection

### Web Search Availability

```typescript
function supportsWebSearch(provider: string): boolean {
  return provider === "google";
}

function createTools(config: Config): AgentTool<any>[] {
  const tools = [
    ...createCoreTools(config),
  ];

  if (supportsWebSearch(config.provider)) {
    tools.push(createWebSearchTool(config.apiKey));
  }

  return tools;
}
```

### Image Input

```typescript
function supportsImageInput(model: Model): boolean {
  return model.input.includes("image");
}

async function reviewWithScreenshots(
  agent: Agent,
  screenshots: string[],
): Promise<void> {
  if (!supportsImageInput(agent.state.model)) {
    throw new Error("Model does not support image input");
  }

  await agent.prompt({
    role: "user",
    content: [
      { type: "text", text: "Review these UI screenshots:" },
      ...screenshots.map(path => ({
        type: "image" as const,
        source: { type: "base64" as const, data: readFileBase64(path) },
      })),
    ],
  });
}
```

## Iteration Limits by Model

Different models may need different iteration limits:

```typescript
function calculateMaxIterations(model: Model, fileCount: number): number {
  const baseIterations = 10;
  const perFileIterations = 5;

  let multiplier = 1.0;

  // Adjust based on model characteristics
  if (model.provider === "google" && isGemini3(model.id)) {
    // Gemini 3 may need more iterations due to temperature constraint
    multiplier = 1.2;
  }

  if (model.contextWindow < 100_000) {
    // Smaller context = more tool calls to gather info
    multiplier *= 1.1;
  }

  return Math.ceil((baseIterations + fileCount * perFileIterations) * multiplier);
}
```

## Dynamic API Key Resolution

Handle different authentication patterns:

```typescript
const agent = new Agent({
  initialState: { /* ... */ },
  getApiKey: async (provider) => {
    switch (provider) {
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;

      case "openai":
        return process.env.OPENAI_API_KEY;

      case "google":
        // Google can use ADC (Application Default Credentials)
        return process.env.GOOGLE_API_KEY || undefined;

      case "google-vertex":
        // Vertex uses ADC, no API key needed
        return undefined;

      case "openrouter":
        return process.env.OPENROUTER_API_KEY;

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  },
});
```

## Summary

1. **Use pi-ai's unified interface**: Same code works across providers
2. **Check model capabilities**: Not all models support all features
3. **Detect and adapt**: Use model detection to apply provider-specific settings
4. **Handle quirks**: Some models have specific requirements (e.g., Gemini 3 temperature)
5. **Track costs**: Monitor token usage and cost across providers
6. **Handle errors gracefully**: Retry rate limits, handle context length issues
7. **Normalize inputs**: Accept common aliases for providers and models
8. **Feature gate**: Only offer features (like web search) when the model supports them
