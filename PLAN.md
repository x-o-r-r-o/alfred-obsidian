# Obsidian — Plan

**Bundle ID:** `io.github.x-o-r-r-o.obsidian` · **Category:** Productivity · **Keywords:** `obs` `obn` `obd` `obm` `obb` `obv`

## Why build it
The Raycast Obsidian extension (marcjulian/KevinBatdorf) is one of the most installed Raycast extensions. In Alfred the Gallery has Shimmering Obsidian (chrisgrieser), which is powerful but:

- needs two Obsidian plugins (Advanced URI and Metadata Extractor) and a manual vault path;
- searches metadata the plugin writes every 30 minutes by default, so new or renamed notes and tag changes are missing until then;
- works with one vault at a time (the vault switcher changes the configured vault);
- has no search of the text of notes, and its keywords are 1–2 characters (`o`, `on`, `oo`…), below the Gallery’s 3-character minimum.

The Raycast extension reads the vault directly but searches contents only when turned on (slowly, in memory), needs Advanced URI for the daily note and Append to Daily Note, and shows one vault per command.

## Design
- **No plugin needed.** Vaults come from `~/Library/Application Support/obsidian/obsidian.json`; each vault’s `.obsidian/*.json` gives daily notes (`daily-notes.json`, or Periodic Notes when enabled), templates (`templates.json`, Templater’s folder), links (`app.json` useMarkdownLinks/newLinkFormat), new-note location, Excluded files (`userIgnoreFilters`), recent files (`workspace.json` lastOpenFiles) and bookmarks (`bookmarks.json`, `starred.json` before 1.2). Advanced URI is used only when installed, to open a heading in a pane.
- **Index in `$alfred_workflow_cache`**, per vault: `index-<key>.json` (path, mtime, size, words, aliases, tags, headings; attachments) and `content-<key>.txt` (one folded line per note). A background job (`obsidian.js index`, detached with `set -m; nohup`, mkdir lock with PID check) walks the vault with `getattrlistbulk` and re-reads only notes whose mtime or size changed. A Script Filter run starts it when the index is older than 10 s; results come from the current index at once. A first index of a big vault publishes file names before contents. After creating or appending, the action refreshes the index.
- **Search** scores title (prefix, word start, whole word), aliases, folder path, tags and a letters-in-order match on the title; headings get their own rows; contents are searched with `grep -F` per word (longest first) on the folded content files and checked by `awk` against the text part only. Words reach grep/awk as argv and environment, never in the script text. Fold = NFD without combining marks + lowercase.
- **Writes** never replace a note: create uses `createFileAtPath` (no overwrite, unique “Title 1” names), plain appends go through `NSFileHandle` at the end of the file, heading inserts rewrite in place (non-atomic, so the inode and creation date stay). Paths are checked to stay inside the vault.
- **Dates** use a moment.js-compatible formatter (all tokens Obsidian users put in daily-note formats, including `[literal]`, ISO `GGGG`/`WW` and locale `gggg`/`ww` weeks), English names like Obsidian’s default locale.

## Features (v1.0)
- [x] `obs` search across all vaults: titles, aliases, headings (own rows, open at the heading), contents with a snippet; recent notes when empty
- [x] Filters: `#tag` (nested, prefix), `/folder`, `@vault`; tag suggestions with counts and ⇥ autocomplete
- [x] Note actions: open (current tab / new tab / split / window), ⌘ paste link, ⌥ reveal, ⌃ other pane, ⇧ append clipboard, fn default app, ⌘⌥ copy URI, ⌘⇧ copy Markdown link to URI, ⌘C link, ⌘Y Quick Look, Alfred file actions (→)
- [x] Links follow the vault’s wikilink/Markdown and shortest-path settings (overridable)
- [x] `obs note > text` appends to a note or under a heading; formats bullet / task / time / paragraph / custom on ↩ ⌥ ⌃ fn, ⇧ appends and opens
- [x] No results → create a note with that name
- [x] `obd` daily note: today / yesterday / tomorrow / a date, created from the vault’s template (`{{date}}`, `{{title}}`, `{{date:FMT}}`, `{{time}}`, offsets), append with an optional heading (created when missing), `@vault`
- [x] `obn` new note: `Folder/Title`, `#tags` into properties, `> content`, `@vault`, one row per template, default template and folder settings, clipboard as content, create without opening
- [x] `obm` attachments: search by name, `image`/`pdf`/`audio`/`video`/`.ext`/`/folder` filters, ⌘ paste embed, copy file
- [x] `obb` bookmarks: files, headings, blocks, folders, searches, URLs, groups
- [x] `obv` vaults: open, reveal, random note, rebuild index, daily note; random note from any vault
- [x] Universal Actions: Search in Obsidian, Append to Daily Note, New Obsidian Note (first line = title)
- [x] Hotkeys: search, open today’s daily note, append the selection to the daily note without Alfred
- [x] Respects Obsidian’s Excluded files plus a workflow list; hidden folders (`.obsidian`, `.trash`, `.git`) never indexed
- [x] Performance: 6,000 notes (25 MB) index in ~2.5 s once, refresh ~0.2 s, searches 80–250 ms including osascript start-up

## Known limitations
- Templater syntax (`<% %>`) isn’t evaluated; Templater processes it when you open the note if “Trigger Templater on new file creation” is on. Core template variables and the extras listed in the README are filled in.
- Month and day names in date formats are English (Obsidian’s default locale), even if Obsidian runs in another language.
- Tags in the frontmatter are read from common YAML forms (inline list, block list, comma or space separated); unusual YAML (anchors, multi-line flow lists) is not parsed.
- `>` in a search always starts append mode, so a search for text containing “>” needs the note’s own search in Obsidian.
- Content search matches words anywhere in the text, not phrases; results are ordered by modification date. Notes are searched up to 200,000 characters.
- The index is refreshed while you search, so a note created in Obsidian shows up on the next keystroke after ~10 s at most (immediately after creating or appending through the workflow).
- Symbolic links inside a vault aren’t followed.
- A vault Obsidian doesn’t know (a folder only listed in the Workflow’s Configuration, not in `obsidian.json`, compared by real path) can’t be reached with `obsidian://` URLs: its notes open in the default app for the file type (with a notification explaining how to open the vault in Obsidian), its folder is revealed in Finder, and bookmarked searches can’t run.
- Copied Obsidian URIs (⌘⌥↩, ⌘⇧↩) use the vault name, like Obsidian’s own “Copy Obsidian URL”, so they are shareable; opening from Alfred uses the file path instead.
- Vaults whose configuration folder was renamed (Settings › Files and links › Override config folder) use default settings.

## Verify in real Alfred
- [ ] `obs` rows keep their selection while “Updating the index…” reruns (uids), and the first search of a new vault shows “Indexing…” and then results.
- [x] Real-Alfred test of 1.0.0 (Alfred 5.8.1, Obsidian 1.13.7): search, #tag, recents, `obd` append and `obn` create work. Opening a note of a vault Obsidian doesn't know failed with “Vault not found” (fixed in 1.0.1).
- [x] Creating from the “no matches → Create” row works (the note goes to the vault root, or the new-note folder, as designed).
- [x] Real-Alfred check of 1.0.1: `obsidian://open?path=` does **not** open or register a vault Obsidian doesn’t know (“Vault not found”); it is kept for registered vaults. Fixed in 1.0.2 (below).
- [ ] 1.0.2: a vault listed only in the Workflow’s Configuration shows “not open in Obsidian yet” on its rows; ↩ opens the note in the default app with the notification “… isn’t open in Obsidian yet: open it once via Open folder as vault, then notes open there.”; `obv` ↩ reveals its folder. After “Open folder as vault” in Obsidian, the tag disappears and notes open in Obsidian.
- [ ] `open?path=<absolute path>` with `&paneType=tab|split|window` for a registered vault.
- [ ] Headings: `obsidian://open?vault=<vault ID>&file=Note.md%23Heading` scrolls to the heading; with Advanced URI, `adv-uri?vault=<ID>… &heading=` and `openmode=tab`.
- [ ] Creating a note or a daily note and opening it right away (0.4 s delay) opens the new file rather than an empty “not found” note, with Obsidian running and with it closed.
- [ ] Appending to a note that is open in Obsidian: Obsidian reloads it and shows the new line; nothing is lost when Obsidian saves.
- [ ] ⌘↩ pastes the link into the frontmost app (Alfred’s clipboard object with auto-paste); ⌘C copies it.
- [ ] Quick Look (⌘Y / ⇧) shows the note; → shows Alfred’s file actions for notes and attachments.
- [ ] Universal Actions: “Append to Daily Note” with multi-line selected text shows one append row and writes all lines; “New Obsidian Note” turns the first line into the title; “Search in Obsidian” searches the selection.
- [ ] Hotkeys: append the selection (argument “selection”) posts “Added to …” with nothing selected → “Nothing to append”; open today’s daily note.
- [ ] Notification shows messages (“Added to 2026-09-27”, “Copied …”) and nothing after silent successes (open).
- [ ] Workflow Configuration: every keyword, vaults list (names and paths), default vault, open in, link format, search contents, excluded folders, append format + custom format, daily heading, open after appending, new note folder and template.
- [ ] Tag suggestion rows: ⇥ autocompletes `#tag ` and keeps the keyword.
- [ ] A vault on iCloud Drive: notes not downloaded (dataless) are indexed by name; reading them for content search doesn’t hang.
- [ ] Screenshots for every `images/*.png` referenced in the README.

## Release checklist (Alfred forum + Gallery)
- [x] README starts with `## Usage`; each paragraph ends “via the `kw` keyword” / “via the Universal Action”
- [ ] A clean screenshot after each paragraph in `images/` (placeholders are in place)
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look as `<kbd>⌘</kbd><kbd>Y</kbd>`
- [x] No `## Setup` section (nothing to set up; vaults are found automatically)
- [x] Every keyword ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the About readme is generated from README.md
- [x] Main icon ≥ 256 px (no Obsidian logo: a generic SF Symbol)
- [x] No self-updater, no network access, no downloads or installs, no compiled binaries
- [x] No hard-coded paths; `prefs.plist` git-ignored; nothing secret stored
- [x] AI assistance disclosed
- [x] Version 1.0.2; `python3 tools/build.py --package` builds `dist/alfred-obsidian-1.0.2.alfredworkflow`
- [ ] GitHub release with the `.alfredworkflow` attached (by the author)
- [ ] Forum post in “Share your Workflows” (by the author)

## Changes
- **1.0.2** Vaults not registered in Obsidian (compared by real path, so symlinked paths still count as registered) never get an `obsidian://` URL: notes open in the default app with a clear notification, “open vault” reveals the folder, and every row of such a vault says “not open in Obsidian yet”.
- **1.0.1** Notes, daily notes, new notes, bookmarks and random notes open with `obsidian://open?path=`, so a vault whose name Obsidian doesn’t match (or doesn’t know yet) no longer shows “Vault not found”; headings, vault search and opening a vault use the vault’s ID. The background refresh deletes the index of every vault no longer listed (removed from Obsidian or left out in the Workflow’s Configuration), unless `obsidian.json` can’t be read.

## Ideas for v1.1
1. Backlinks and outgoing links of a note (Shimmering’s ⇧↩ link browser) from the index (parse `[[links]]` while indexing).
2. Phrase search (`"exact words"`) and ranking content hits by the number of matches.
3. Custom append targets (Raycast’s Custom Actions): named notes with their own heading and format, each as a keyword or hotkey.
4. Workspaces (`workspaces.json`) and opening a workspace via Advanced URI.
5. Weekly / monthly periodic notes.
6. Delete or rename a note from Alfred (with confirmation, moving to the vault’s `.trash`).
