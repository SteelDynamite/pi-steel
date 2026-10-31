---
name: doc-manifests-session-reviewer
description: "Review completed session work for durable project knowledge that should be captured in manifest-managed documentation. Use at session end, for session reflection, documentation distillation, or documentation follow-up."
---

# Session Documentation Review

1. Review the session transcript, using `$PI_SESSION_FILE` when available; current Git status and diff; current todos when available; the injected manifest; and relevant source.
2. Identify knowledge valuable to future sessions that is neither explicit nor reasonably derivable from source. Preserve current facts, constraints, rationale, tradeoffs, recurring fixes, reusable procedures, and intentional deficiencies. Exclude chronology, transient status, implementation detail, source-obvious behavior, and knowledge already captured accurately.
3. Use the injected manifest alone to identify a likely category. Do not preload category creator skills. As soon as a candidate document change is identified, load that category's declared creator skill before evaluating or proposing it, then inspect relevant documents for duplication or needed revision.
4. Consider creation, revision, distillation, deletion, and relocation. If no category fits or the category structure must change, load `doc-manifests-designer` and retain its approval gates.
5. Before editing, present a numbered, file-specific plan. For each item state the action, path, knowledge to preserve, and why it is durable and not source-derivable. Ask the user to approve or revise the plan. If nothing qualifies, report `No documentation changes needed.`
6. Apply only approved changes, following each loaded creator skill. Validate changed documents against their declarations, run `git diff --check` when Git is available, and use a fresh Pi session to confirm the manifest has no unexpected diagnostics.
