---
name: doc-manifests-session-reviewer
description: "Review completed session work for durable project knowledge to capture in manifest-managed documentation. Use at session end, for reflection, distillation, or documentation follow-up."
---

# Session Documentation Review

1. Review the session transcript, using `$PI_SESSION_FILE` when available; current Git status and diff; current todos when available; the injected manifest; project instructions; and relevant project source.
2. Identify useful current knowledge that is neither explicit nor reasonably derivable from source. Preserve non-obvious facts, constraints, rationale, tradeoffs, dependency pitfalls, procedures and intentional deficiencies. Exclude source summaries, logs, dated evidence, session history and knowledge already captured accurately.
3. Use manifest descriptions to identify likely destinations. Do not preload category creator skills. As soon as a candidate document change is identified, load that category's declared creator skill and read the affected documents before editing.
4. Create, revise, distill, delete or relocate as needed. For structural work or when no category fits, load `doc-manifests-designer`. Follow project-specific approval requirements; otherwise act without asking. Ask only when intent or necessary rationale is unclear.
5. Apply the smallest useful changes. Make descriptions carry primary guidance where practical, with bodies supplying supporting detail. Keep references to project source optional and stable; do not duplicate routing elsewhere.
6. Validate documents against their declarations, check links, and run `git diff --check` when Git is available. Confirm the next generated manifest has no unexpected diagnostics. Report changed paths and remaining questions, or `No documentation changes needed.`
