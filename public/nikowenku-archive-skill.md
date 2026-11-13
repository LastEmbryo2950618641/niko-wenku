---
name: nikowenku-archive
description: "Use for Chinese light novel library searches, book details, metadata lookup, and full-text exports with the cross-platform nikowenku-archive CLI."
---

# Niko Wenku Archive

The Wenku Archive focuses mainly on light novels and may also contain other works. Use the `nikowenku-archive` command for archive searches, book details, and full-text exports. This Skill is also the command reference. When the user asks to perform an operation, run the command and report its actual result; when they ask how it works, answer from this reference without running it.

## Website and Library

- **Main homepage:** `https://111.229.32.85/` is the site's website-card collection and navigation portal. The light novel library is the first default card; the homepage itself is not the book catalog.
- **Light novel library:** `https://111.229.32.85/nikowenku-archive/` opens the Wenku website for browsing, searching, viewing book details, reading online, and downloading archived text.
- **CLI base URL:** `http://111.229.32.85/nikowenku-archive/` remains the command's default. When setting `--site` or `ARCHIVE_SITE_URL`, include `/nikowenku-archive/`; for example, `--site https://111.229.32.85/nikowenku-archive/`.

For a request to open the main site, provide the homepage URL. For a request to find or open a book in the website, use the library URL; for search results, metadata, or a local text export, use the CLI commands below. Public read requests use the primary library backend by default and can automatically fail over to its read-only standby; clients keep the same public URL.

## Install

Requires Node.js 22 or newer and npm. The package has no third-party runtime dependencies. For npm installation use `npm install -g nikowenku-archive`; the downloaded `.tgz` can also be installed from disk offline.

Windows PowerShell:

```powershell
  npm install -g --offline .\nikowenku-archive-0.1.3.tgz
```

Linux or macOS:

```sh
npm install -g --offline ./nikowenku-archive-0.1.3.tgz
```

To install this Skill in the current project, place the downloaded `nikowenku-archive-skill.md` at `.agents/skills/nikowenku-archive/SKILL.md`. PowerShell:

For Codex, Claude Code, Cursor, and other compatible agents, it can also be installed directly from GitHub with the Agent Skills CLI:

```sh
npx skills add LastEmbryo2950618641/nico-cli --skill nikowenku-archive
```

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

The CLI connects to the public archive at `http://111.229.32.85/nikowenku-archive/` by default. Use the book ID returned by `search` with `info` or `download`.

```sh
nikowenku-archive search "西游记" --limit 10
nikowenku-archive info xiyouji
nikowenku-archive info xiyouji --json
nikowenku-archive download xiyouji --output "./西游记.txt"
```

To use another server, pass its base URL, including a path prefix, with `--site https://example.org/nikowenku-archive/` or set `ARCHIVE_SITE_URL`.

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
