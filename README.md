# mend

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Node 22](https://img.shields.io/badge/node-22-green)](https://nodejs.org)

mend is one patch tool for every AI edit format: it applies an edit a model
wrote to a tree of text files, in four formats — unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool
calls as JSON — and writes every change or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or `-` / absent for standard input. The working
directory is the root of the tree. `--format` is one of `auto` (the default),
`unified`, `search-replace`, `v4a` or `json`. `--check` does everything but
write. `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one line per changed file and `ok: n files`; `1` with
one `error: <code> <path>` line per failed edit and `failed: k of n edits`
(nothing is written); `2` with a single `error: ...` line for usage, missing
patch, undetected format or parse errors.

## How it matches

Old lines are found at the first of three tiers where they occur: tier 0
(exact), tier 1 (trailing whitespace ignored), tier 2 (leading and trailing
whitespace ignored, with the new lines re-indented to the file's own indent).
Unified hunks take the occurrence nearest their stated line number;
SEARCH/REPLACE blocks fail as ambiguous when the old lines occur more than
once; V4A chunks walk a cursor past anchors and can be pinned to the end of
the file. Files keep their own line break (LF or CRLF) and their final line
break, except where the patch's `\ No newline at end of file` says otherwise.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as it is.
- `LICENSE` — MIT.

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
Local practice score: 100/100 (1000).
