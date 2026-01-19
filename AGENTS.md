# Agent Principles

This project experiments with a "tools-first" review philosophy for frontier models.

Guiding idea:
- Give the model richer context and more precise tools, then let it decide how to behave.
- Prefer explicit choices over hard-coded heuristics. If ambiguity exists, expose it and require the model to choose (e.g., pick a review thread, choose LEFT/RIGHT side, or request a new thread).
- Use model reasoning to avoid repetition and focus on new or unresolved issues rather than suppressing output with brittle dedupe rules.

Notes:
- This is experimental and may change. The current approach may not be optimal; it is an intentional exploration of model-led behavior.
- When adding new functionality, prefer adding tools + instructions over fixed rules, unless the rule is required for safety or correctness.
