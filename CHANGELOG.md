# Changelog

## 0.1.1 - 2026-10-21

- Use the directory-compatible plugin ID `lean`; the display name remains Lean4.
- Manual installations of 0.1.0 must rename their plugin folder from `lean4-blocks` to `lean` and enable the new entry. Preserve data.json when migrating.

## 0.1.0 - 2026-10-21

- Independent Lean / Lean4 blocks and opt-in shared sessions within a note.
- Managed basic Lean environment and existing Lake project support.
- Proof goals, hypotheses, diagnostics, syntax highlighting and Unicode input.
- Compact check actions, semantic status colors and responsive goal panel.
- English and Simplified Chinese interfaces following Obsidian's language.

Initial preview release; desktop only. Completion, hover, go-to-definition and interactive Lean widgets are not included. See [validation scope](docs/validation.md).
