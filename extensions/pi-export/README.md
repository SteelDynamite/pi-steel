# pi-export

In OpenMausBot, ask **“Export this chat.”** `export_session` creates `session-html.zip`, containing a single `session.html` you can unzip and open in your browser. No preview, format selection, or shell ZIP utility is needed. The extension registers the tool only when `OMB_MCP_CONFIG` is nonblank at initialization; it does not read the configuration file. Generic RPC mode and Codync alone do not enable it. Pi's `/export` command is unaffected.

- **HTML (default):** Captures the complete raw session tree in memory, including alternative branches and recorded system messages with skill and tool declarations. Uses the hosting Pi CLI's standalone viewer (`--export`), not the live TUI's theme or custom renderers. It does not invent declarations missing from older sessions. The standalone viewer initially selects the last recorded entry.
- **JSONL (explicit `format: "jsonl"`):** Creates `session-jsonl.zip` with a fresh Pi header and the current branch's raw entries in order. Both formats support in-memory and persisted sessions.

On an export request the tool saves the ZIP in a fresh `pi-export-*/` directory under the session working directory, then calls OpenMausBot's `agents_attach_file` for the current chat. It returns the ZIP path even if the attachment is unavailable or rejected. If the host exposes attachments only to the agent directly, the agent can attach that same file without repeating the export. Generation errors do not fall back to another format.

Exports are unredacted. They can contain prompts, tool inputs and outputs, images, and entries omitted from the model's current context. The snapshot does not include the export's own result or subsequent replies. Review it before forwarding or committing it.
