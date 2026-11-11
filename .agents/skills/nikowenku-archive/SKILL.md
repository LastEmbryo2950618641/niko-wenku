---
name: nikowenku-archive
description: "Use when searching the Wenku Archive, a library focused mainly on light novels, inspecting metadata, exporting text, or looking up the cross-platform nikowenku-archive command."
---

# Niko Wenku Archive

The Wenku Archive focuses mainly on light novels and may also contain other works. Use the `nikowenku-archive` command for archive searches, book details, and full-text exports. This Skill is also the command reference. When the user asks to perform an operation, run the command and report its actual result; when they ask how it works, answer from this reference without running it.

## Install

Requires Node.js 22 or newer and npm. The downloaded `.tgz` has no third-party runtime dependencies and can be installed from disk offline.

Windows PowerShell:

```powershell
npm install -g --offline .\nikowenku-archive-0.1.1.tgz
```

Linux or macOS:

```sh
npm install -g --offline ./nikowenku-archive-0.1.1.tgz
```

To install this Skill in the current project, place the downloaded `nikowenku-archive-skill.md` at `.agents/skills/nikowenku-archive/SKILL.md`. PowerShell:

```powershell
New-Item -ItemType Directory -Force .agents\skills\nikowenku-archive | Out-Null
Copy-Item .\nikowenku-archive-skill.md .agents\skills\nikowenku-archive\SKILL.md
```

Linux or macOS:

```sh
mkdir -p .agents/skills/nikowenku-archive
cp ./nikowenku-archive-skill.md .agents/skills/nikowenku-archive/SKILL.md
```

When installed through npm, the same file is at `$(npm root -g)/nikowenku-archive/skill/SKILL.md` on POSIX shells. On PowerShell use `Join-Path (npm root -g) 'nikowenku-archive\skill\SKILL.md'` to locate it.

Windows, Linux, and macOS use the same Node.js CLI. To check that the command is on `PATH`, run `Get-Command nikowenku-archive` in PowerShell or `command -v nikowenku-archive` in a POSIX shell. From the source repository, run `node scripts/cli.mjs --help` instead.

## Commands

The CLI connects to the public archive at `http://111.229.32.85` by default. Use the book ID returned by `search` with `info` or `download`.

```sh
nikowenku-archive search "西游记" --limit 10
nikowenku-archive info xiyouji
nikowenku-archive info xiyouji --json
nikowenku-archive download xiyouji --output "./西游记.txt"
```

PowerShell paths can use backslashes, for example `--output .\西游记.txt`. Search supports titles, original titles, authors, descriptions, and tags. The default limit is 20; `--limit` accepts 1–100. `info --json` returns the complete metadata, chapter list, and file information.

## Options

| Option | Applies to | Behavior |
| --- | --- | --- |
| `--json` | All commands | Print structured JSON. |
| `--limit <1-100>` | `search` | Maximum number of displayed matches; default 20. |
| `--output <path>` | `download` | Output path; defaults to `<book-id>.<original-extension>` in the current directory. |
| `--force` | `download` | Replace an existing output file. Without it, existing files are preserved and the command fails. |
| `--site <url>` | Remote mode | Use another HTTP or HTTPS archive site. Also supports `ARCHIVE_SITE_URL`. |
| `--local` | Local mode | Read books from `./library` instead of the remote site. |
| `--library <path>` | Local mode | Select a local library and automatically enable local mode. Also supports `ARCHIVE_LIBRARY`. |
| `--state-dir <path>` | Local mode | Select the search index directory. Also supports `ARCHIVE_STATE_DIR`; default `./.state`. |
| `--help` | All commands | Print command usage. |

`--site` cannot be combined with `--local` or `--library`. `--library <path>` and `--local` use the same local book files; an existing `ARCHIVE_LIBRARY` also selects local mode.

## Local Mode

Local mode can search and export without network access, provided the requested book is already present in the local library.

PowerShell:

```powershell
nikowenku-archive search "西游记" --library "D:\Books"
nikowenku-archive info xiyouji --library "D:\Books"
nikowenku-archive download xiyouji --library "D:\Books" --output .\西游记.txt
```

Linux or macOS:

```sh
nikowenku-archive search "西游记" --library "$HOME/Books"
nikowenku-archive info xiyouji --library "$HOME/Books"
nikowenku-archive download xiyouji --library "$HOME/Books" --output ./西游记.txt
```

Set `ARCHIVE_LIBRARY` to reuse a local library path across commands. If no command is installed and the source repository is available, prefix commands with `node scripts/cli.mjs`.

## Safety and Limits

- Remote search, details, and downloads require network access. Installing the `.tgz` is offline; it does not make remote book requests offline.
- `download` exports text already published in the selected library. It does not start a source-site acquisition task.
- The original text bytes and encoding are preserved. Existing output files are never replaced unless `--force` is given. Local mode also refuses an output path that points to the source text itself.
- Use the archive only for content you are authorized to access and keep.
