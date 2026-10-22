# Antigravity chat controls investigation

## Target and evidence

The installed `agy.exe` was inspected using the reverse-engineer-anything skill.
REA `inspect_go_binary` evidence
`ev_ebe2e9fa5d36eef20e329010af81601f54ae3704409c1474859a6855f90a1761`
identified a native AMD64 PE, SHA-256
`d191b2e423c8c5a96ffba84699dd5f52f4eec0e74bb457e8d5f755dc55528f9d`.
Its interactive banner reported Antigravity CLI 1.4.5. The REA record observes
embedded build metadata; it does not establish command behavior.

REA native disassembly was unavailable because Ghidra was not configured. REA's
Windows PTY scenario adapter also refused capture because it cannot verify
descendant cleanup on Windows. No REA or provider configuration was changed.
The remaining command behavior was checked directly in separately owned native
PTYs, rendering their output with headless xterm. No agent prompts were submitted.
The original model and effort were restored before terminating these probes.

## Observations used by the implementation

- `agy models` returns tab-separated model IDs and labels. Effort variants are
  separate reported IDs. The picker derives choices from this catalog and maps
  effort changes only to variants present in that catalog.
- `/model` opens a native Switch Model dialog, with up/down model selection and
  left/right effort selection.
- `/model <reported-model-id>` immediately changes the running session and emits
  `Model set to <reported label>`.
- `/effort <reported-effort>` immediately changes the running session and emits
  `Effort set to <effort>`. A module-level live probe changed medium to low and
  restored medium, observing the corresponding model variant each time.
- The native footer reports execution mode, model family and effort. This footer
  supplies exact owned-session settings before the first public conversation turn.
- The startup composer can contain an undimmed execution-mode hint while its cursor
  remains before that hint. Typed drafts are tracked independently by the owned
  terminal input path and block settings changes.
- No speed toggle was established for this CLI. The Antigravity picker exposes
  its observed model and effort capabilities.

The implementation serializes controls with terminal/message input, checks live
session identity on every write, validates catalog values and waits for native
acknowledgement. An uncertain write is never retried automatically. These
observations establish behavior for the inspected version; later incompatible
CLI interfaces may require updating the adapter.

## Codex and Claude reference

The other adapters use the same native discovery methods as the
[Orca repository](https://github.com/stablyai/orca): Codex `model/list` and Claude
`list_models`. Catalog descriptions, efforts, resolved model aliases and speed
support come from those provider responses. Codex native menu selection and
`/fast` were checked in an owned PTY. Claude catalog discovery was checked, while
its native trust prompt was preserved and interactive mutation remains unverified.
