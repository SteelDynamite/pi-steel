# pi-doc-manifests

Pi extension for trusted, declarative documentation manifests. Before every agent-model request, it scans `<cwd>/.agents/docs/` and each category's declared project-local creator skill, then injects the current index into the system prompt. Requires Pi 1.4.0 or newer.

Each generated manifest begins with [src/AGENTDOCS.md](src/AGENTDOCS.md), read from the installed package when the extension loads. This runtime prompt asset is not an initialization template and is never copied into projects. Edit it to change the preamble; paragraph breaks are preserved and surrounding whitespace is trimmed. Reload an updated package to load a changed preamble. Project-file changes appear on the next model turn without a reload; historical display entries are never the source of prompt guidance.

The package also supplies generic `doc-manifests-designer`, `doc-manifests-maintainer`, and `doc-manifests-session-reviewer` skills. The designer guides category selection and structural changes. The maintainer updates initialized projects to current intentions without overwriting project-specific choices. Documentation workflows are autonomous by default; project instructions may require approval. Missing intent or rationale must be clarified, not invented. The session reviewer distills durable knowledge from completed work into manifest-managed documentation.

Install:

```sh
pi install https://github.com/SteelDynamite/pi-doc-manifests.git
```

## Initialize a project

Run this only in a trusted project:

```text
/doc-manifests init
```

It creates an optional example layout with paired guides and folders for `features`, `glossary`, `goals`, `lessons`, `runbooks`, `standards`, and `techdebt`, plus matching project-local `doc-*-creator` skills under `.agents/skills/`. These categories are examples, not a required taxonomy; projects may remove them or use different categories. Reload Pi resources after initialization to discover the generated project skills. Initialization refuses an existing docs root, any target skill, or unsafe/symlinked target ancestor; it never merges or overwrites. Category-specific templates are copied only by this command; the generic manifest skills are package-global.

## Maintain an initialized project

Run the explicit package skill in the project:

```text
/skill:doc-manifests-maintainer
```

It audits creator-skill associations, declarations, descriptions, source-reference stability and unnecessary metadata. It removes source summaries and historical residue while preserving useful current knowledge. It distinguishes mechanical, semantic and structural work, respects project-specific approval gates, and asks about uncertain intent. Structural work routes through `doc-manifests-designer`; updating the package itself never rewrites project files.

### Optional migration to Standards

New projects use **Standards** for consequential design guidance and conventions, with unnumbered filenames and three ordered H2 sections: **Standard**, **Scope and exceptions**, and **Rationale and tradeoffs**. Short sections are valid; topic-specific subheadings carry detail. Requirements and preferences remain distinct, and unknown rationale requires clarification. The declaration checks heading presence; the creator skill governs order and meaning. Existing Decisions/Policies categories and numbered documents remain valid; updating the package does not migrate project files.

After updating the package and reloading its skills, request the opt-in migration:

```text
/skill:doc-manifests-maintainer Merge Decisions and Policies into Standards with unnumbered filenames.
```

The maintainer prepares a path map, checks naming conflicts, preserves intentional custom guidance and follows project-specific approval rules. It reconciles document bodies and declarations, keeps useful current meaning rather than history, updates references, and removes replaced declarations and unused creator skills after verification. Existing session data is not rewritten. Reload resources to discover changed skills; the manifest refreshes automatically. `/doc-manifests init` is not an upgrade command.

## Review a completed session

```text
/skill:doc-manifests-session-reviewer
```

It reviews the session transcript, working changes, todos, source, and existing manifest-managed documentation for durable knowledge that future sessions need but cannot derive from source. It loads category creator skills only after identifying a candidate, applies useful changes under project instructions, and reports the affected paths. It does not require approval unless the project does.

## Layout

Categories are derived from project context and responsibilities. Existing categories are neither predefined nor exhaustive. Agents may create and maintain documents and categories autonomously under project instructions. Before changing scope or validation, inspect affected material and reconcile it rather than silently invalidating documents. Ask when project intent is unclear or project-specific approval gates apply.

Each direct, real, non-hidden folder must have an exact uppercase sibling manifest description. Its body defines routing responsibility; it is not an index. Nested folders belong to the direct-child manifest. Every category must declare a project-local creator skill at the exact path `.agents/skills/<creator-skill>/SKILL.md`; its frontmatter needs the matching `name` and a non-empty `description`.

```text
.agents/
├── docs/
│   ├── FEATURES.md
│   ├── features/
│   │   └── search.md
│   ├── STANDARDS.md
│   └── standards/
└── skills/
    ├── doc-feature-creator/SKILL.md
    └── doc-standard-creator/SKILL.md
```

Only paired folders are rendered. Discovery is recursive for case-insensitive `.md` files, excludes hidden paths and symlinks, and sorts normalized paths bytewise. Because runtime scanning is gated by Pi project trust, creator skills may have linked directory ancestors, including a junctioned `.agents`; each `SKILL.md` itself must remain a regular, non-linked file. Loose root Markdown, orphan descriptions, unpaired folders, missing or invalid creator skills, malformed/unreadable files, and validation failures appear in `## Diagnostics`.

A category declaration's YAML frontmatter is stripped; its remaining body is injected in full. Document bodies are not injected. Every document needs non-empty `description` frontmatter that states applicability and conveys primary guidance where practical. For simple documents, the description can do all necessary steering; the body supplies supporting detail when needed or questioned. Require a full read only when necessary. References to project source are optional and should favor stable concepts, boundaries and paths over line numbers or incidental details. Project source can be code, writing, a wiki or other material; it must not reference agent documentation or skills. Missing descriptions remain listed as `"missing description"`.

## Declarations

Every category declaration requires `doc-manifest.creator-skill`. Basic mode may omit all other settings.

```yaml
---
doc-manifest:
  creator-skill: doc-feature-creator
  priorities: true
  display-fields: [status]
  validation:
    frontmatter:
      status:
        type: enum
        values: [draft, ready, in-progress]
      parent:
        type: string
    required-sections: [Goal, Acceptance Criteria]
    filename-pattern: "plans/*.md"
---
```

Declarations use one live schema. `creator-skill` must be a valid Pi skill name. Legacy `version` fields are ignored and may be removed by `doc-manifests-maintainer`. Invalid independent settings are diagnosed and skipped while valid rules apply. Supported frontmatter rules are required non-empty `string`, `string[]`, and `enum`; unknown keys and malformed declarations are diagnosed. `display-fields` is an optional string array of declared frontmatter-rule names. Its values render after priority and before the path, in declaration order: scalars as `(value)` and string arrays as one `(first, second)` label. Missing values are omitted; invalid displayed values render `(error)`. Required sections are exact case-sensitive H2 headings. Filename patterns use case-insensitive minimatch against folder-relative paths. Example templates omit redundant filename filters and keyword metadata; projects may keep custom validation when it has a concrete purpose.

## Priorities and output

Priorities are off unless `priorities: true`. Enabled folders render invalid values as `(error)`, valid `p<ASCII digits>` values numerically ascending, then missing values as `(np)`; ties sort by path. Disabled folders omit markers and ignore `priority`. Leading zeros are valid. Display labels escape authored Markdown safely.

Diagnostics use `(error)` severity and stable kebab-case issue codes, sort by project-relative path then code, are emitted once, and escape authored details.

## Session behavior

The `context_with_system` hook rebuilds the manifest before each agent-model request, including tool-loop turns and the first request after compaction. It replaces only the `pi_doc_manifests` system section, preserving unrelated prompt content, tools and metadata. It removes superseded values from later system patches so stale guidance cannot reappear. Untrusted projects and absent docs trees remove the section. Unexpected scan failures produce a request-local diagnostic rather than reusing old guidance.

The prompt copy uses `<docs-manifest>` tags and escapes authored wrapper-like tags. On trusted session startup, reload, resume, tree navigation and successful initialization, a scan appends a `{ content }` custom entry only when it differs from the branch's latest display record. These entries render unwrapped Markdown in the TUI and are never authoritative for model requests. Per-turn refreshes add no entries, messages or model turns. Legacy entries with string `content` still render; old session data is not rewritten.

Compaction summarizes conversation messages, not this request-local index. The next request receives the current manifest from disk. Previously read document bodies may be summarized away and can be read again when needed. The extension does not inject into separate summarization calls or rewrite compaction summaries.

Pi applies whole-prompt `systemPrompt`/`forceSystemPrompt` overrides after request-local transformations. Such overrides from other extensions can discard the refreshed section; cooperating extensions must contribute named prompt sections instead. Steel's subagent and system-reminders use that approach. Automatic refresh incurs filesystem reads each model turn, but no watchers, timers or background model calls.
