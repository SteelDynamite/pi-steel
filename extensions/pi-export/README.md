# pi-export

Ask the agent “Export this session as HTML” or “Save the current branch as JSONL.” `export_session` takes one required `format` (`html` or `jsonl`) and returns an absolute path under a fresh `pi-export-*/` directory in the session working directory. It does not accept paths or execute slash commands.

- **HTML** uses the hosting Pi CLI’s standalone viewer (`--export`). It reads the saved tree, including abandoned branches. It doesn’t add the live system prompt, active tool definitions, or custom tool rendering. HTML requires a persisted session and the hosting CLI.
- **JSONL** writes a fresh Pi session header and the raw entries on the current branch in order, with parent links intact. It also works for in-memory sessions.

Both are snapshots taken during the call: neither includes the tool’s own result or the assistant’s subsequent reply. Nothing is uploaded or redacted. Review exports before sharing or committing them: they can contain prompts, tool inputs and outputs, images, and content omitted from the model’s current context.
