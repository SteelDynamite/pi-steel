# Changelog

## Unreleased

- Loads the suggestion system prompt from `prompts/suggestion-system-prompt.md`.
- Adds global/project config files for `enabled`, `acceptTab`, `display`, `model`, `maxTokens`, and `maxChars`.
- Supports Enter on an empty editor to submit the visible suggestion immediately.
- Adds `display` config with default `ghost` mode and `belowEditor` fallback.
- Adds opt-in `acceptTab` config for accepting visible suggestions with Tab.
- Removes test-only startup suggestion and command from packaged extension code.
- Adds stricter output filtering for meta text, labels, error text, markdown formatting, word count, assistant voice, and evaluative replies.
- Adds README disclaimer.

## 0.1.1 - 2026-05-23

- Moved the suggestion system prompt into a packaged markdown file.

## 0.1.0 - 2026-05-23

Initial release.

- Suggests short next prompts after agent responses.
- Displays suggestions below the editor.
- Accepts suggestions with Right Arrow when the editor is empty.
- Preserves Tab/autocomplete behavior.
- Includes a local `test/` harness and automated helper tests.
