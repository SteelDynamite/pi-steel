# pi-doc-manifests

Pi extension for trusted, declarative documentation manifests. It scans `<cwd>/.agents/docs/` and each category's declared project-local creator skill, persists one TUI-only snapshot per active session branch, and injects that snapshot into every agent system prompt.

Each generated manifest begins:

> These documents are active shared project memory. Use them to preserve cohesion across sessions, developers, and agents, and let project goals, accumulated knowledge, and current progress shape your reasoning and behavior. Documentation must preserve valuable current facts, constraints, and rationale that are not explicit in source. It must describe why the current design exists, not the chronology of how it changed. When the design changes, update, replace, or delete its documentation; rely on version control for superseded history. Proactively suggest creating, revising, distilling, or deleting documents when doing so would preserve implicit knowledge or improve future work. Categories are discovered project responsibilities, not a predefined or exhaustive taxonomy; reuse one only when its declared responsibility fits. Load the `doc-manifests-designer` skill before organizing `.agents/docs` or changing a category or manifest. Discuss and obtain explicit user approval before creating a category; materially expanding its responsibility; changing validation in a way that invalidates existing documents; or renaming, merging, or deleting a category. Each category is a direct-child folder paired with an exact uppercase sibling manifest description; manifests are routing declarations, not indexes. Every category declares a project-local creator skill; load it before creating or substantially revising documents in that category. Each document description is an active routing instruction, not merely a summary: state when the document is relevant, whether it must be read before acting, and what context, rule, or procedure it provides. Keep documents inside paired folders rather than loose under `.agents/docs`. This manifest is injected automatically; avoid duplicating its routing elsewhere.

The package also supplies generic `doc-manifests-designer`, `doc-manifests-maintainer`, and `doc-manifests-session-reviewer` skills. The designer guides category selection and approved structural changes. The maintainer collaboratively updates initialized projects to current intentions without overwriting project-specific choices. The session reviewer distills durable knowledge from completed work into manifest-managed documentation.

Install:

```sh
pi install https://github.com/SteelDynamite/pi-doc-manifests.git
```

## Initialize a project

Run this only in a trusted project:

```text
/doc-manifests init
```

It creates an optional example layout with paired guides and folders for `decisions`, `features`, `glossary`, `goals`, `lessons`, `policies`, `runbooks`, and `techdebt`, plus matching project-local `doc-*-creator` skills under `.agents/skills/`. These categories are examples, not a required taxonomy; projects may remove them or use different approved categories. Start a new Pi session after initialization to load the generated project skills; Pi discovers project-local skills only when it reloads resources. Initialization refuses an existing docs root, any target skill, or unsafe/symlinked target ancestor; it never merges or overwrites. Category-specific templates are copied only by this command; the generic manifest skills are package-global.

## Maintain an initialized project

Run the explicit package skill in the project:

```text
/skill:doc-manifests-maintainer
```

It audits required creator-skill associations and files, generated skills, declarations, document descriptions, and legacy metadata against current package intentions; discusses mechanical, semantic, and structural changes with the user; and applies only approved updates. It preserves project-specific choices and routes structural changes through `doc-manifests-designer`.

## Review a completed session

```text
/skill:doc-manifests-session-reviewer
```

It reviews the session transcript, working changes, todos, source, and existing manifest-managed documentation for durable knowledge that future sessions need but cannot derive from source. It loads category creator skills only after identifying a candidate, presents a file-specific plan, and applies only approved changes.

## Layout

Categories are derived from project context and responsibilities. Existing categories are neither predefined nor exhaustive. Agents may use a fitting category autonomously, but must discuss and obtain explicit user approval before creating, renaming, merging, or deleting a category; materially expanding its responsibility; or making validation changes that invalidate existing documents.

Each direct, real, non-hidden folder must have an exact uppercase sibling manifest description. Its body defines routing responsibility; it is not an index. Nested folders belong to the direct-child manifest. Every category must declare a project-local creator skill at the exact path `.agents/skills/<creator-skill>/SKILL.md`; its frontmatter needs the matching `name` and a non-empty `description`.

```text
.agents/
├── docs/
│   ├── FEATURES.md
│   ├── features/
│   │   └── search.md
│   ├── POLICIES.md
│   └── policies/
└── skills/
    ├── doc-feature-creator/SKILL.md
    └── doc-policy-creator/SKILL.md
```

Only paired folders are rendered. Discovery is recursive for case-insensitive `.md` files, excludes hidden paths and symlinks, and sorts normalized paths bytewise. Because runtime scanning is gated by Pi project trust, creator skills may have linked directory ancestors, including a junctioned `.agents`; each `SKILL.md` itself must remain a regular, non-linked file. Loose root Markdown, orphan descriptions, unpaired folders, missing or invalid creator skills, malformed/unreadable files, and validation failures appear in `## Diagnostics`.

A category declaration's YAML frontmatter is stripped; its remaining body is injected in full. Document bodies are not injected. Every document needs non-empty `description` frontmatter written as an active routing instruction: state when the document is relevant, whether it must be read before acting, and what it provides. Missing descriptions remain listed as `"missing description"`.

## Declarations

Every category declaration requires `doc-manifest.creator-skill`. Basic mode may omit all other settings.

```yaml
---
doc-manifest:
  creator-skill: doc-feature-creator
  priorities: true
  display-fields: [status, keywords]
  validation:
    frontmatter:
      status:
        type: enum
        values: [draft, ready, in-progress]
      parent:
        type: string
      keywords:
        type: string[]
    required-sections: [Goal, Acceptance Criteria]
    filename-pattern: "**/*.md"
---
```

Declarations use one live schema. `creator-skill` must be a valid Pi skill name. Legacy `version` fields are ignored and may be removed by `doc-manifests-maintainer`. Invalid independent settings are diagnosed and skipped while valid rules apply. Supported frontmatter rules are required non-empty `string`, `string[]`, and `enum`; unknown keys and malformed declarations are diagnosed. `display-fields` is an optional string array of declared frontmatter-rule names. Its values render after priority and before the path, in declaration order: scalars as `(value)` and string arrays as one `(first, second)` label. Missing values are omitted; invalid displayed values render `(error)`. Required sections are exact case-sensitive H2 headings. Filename patterns use case-insensitive minimatch against folder-relative paths; `**/*.md` includes root-level files.

## Priorities and output

Priorities are off unless `priorities: true`. Enabled folders render invalid values as `(error)`, valid `p<ASCII digits>` values numerically ascending, then missing values as `(np)`; ties sort by path. Disabled folders omit markers and ignore `priority`. Leading zeros are valid. Display labels escape authored Markdown safely.

Diagnostics use `(error)` severity and stable kebab-case issue codes, sort by project-relative path then code, are emitted once, and escape authored details.

## Session behavior

On trusted `session_start` and `session_tree`, the extension restores the latest `doc-manifests` custom entry with string `content` on the active branch or scans and appends one `{ content }` custom entry. Legacy version fields are ignored. Custom entries are visible through a Markdown TUI renderer but never become transcript messages. `before_agent_start` injects a copy of the stored snapshot inside `<docs-manifest>` tags, escaping authored wrapper-like tags so only the extension owns that prompt boundary. Stored snapshots and TUI Markdown remain unwrapped. The snapshot survives compaction without a duplicate `session_compact` entry. Untrusted projects and absent docs trees add neither snapshot nor prompt text.
