#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters and actions the way Alfred does and validate the JSON.

Every test builds its own fixture vaults and Obsidian configuration in a temporary folder
(OB_TEST_APPSUPPORT replaces ~/Library/Application Support/obsidian), so the real vaults are never
read or written. Opening URLs and revealing files are dry runs (OB_TEST_DRYRUN) that print what
would happen, and the clipboard is a private named pasteboard.
"""
import json, os, plistlib, random, shutil, subprocess, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
PASTEBOARD = "io.github.x-o-r-r-o.obsidian.test"
CONFIG_VARS = ("vaults", "default_vault", "open_in", "link_format", "search_content", "excluded_folders",
               "append_format", "append_custom", "daily_heading", "open_after_append", "new_note_folder",
               "new_note_template")
NOW = "2026-09-27T10:30:00"


def write(path, text="", mtime=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(text, bytes) else "w"
    with open(path, mode, **({} if mode == "wb" else {"encoding": "utf-8", "newline": ""})) as f:
        f.write(text)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def enc(s):
    """encodeURIComponent, as the workflow encodes obsidian:// parameters"""
    from urllib.parse import quote
    return quote(s, safe="-_.~")


def read_pasteboard():
    script = """
ObjC.import('AppKit');
function run(argv) {
  const s = $.NSPasteboard.pasteboardWithName(argv[0]).stringForType($.NSPasteboardTypeString);
  return s.isNil() ? '' : s.js;
}"""
    return subprocess.run(["osascript", "-l", "JavaScript", "-e", script, PASTEBOARD],
                          capture_output=True, text=True).stdout.rstrip("\n")


def set_pasteboard(text):
    script = """
ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  pb.clearContents;
  pb.setStringForType($(argv[1]), $.NSPasteboardTypeString);
}"""
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, PASTEBOARD, text], capture_output=True)


def validate(data):
    assert isinstance(data.get("items"), list) and data["items"], data
    assert data.get("skipknowledge") is True, data
    uids = set()
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        for k in ("title", "subtitle"):
            assert "\n" not in it.get(k, "") and "\u202e" not in it.get(k, ""), it
        icon = it.get("icon")
        if icon and icon.get("type") != "fileicon":
            assert os.path.exists(os.path.join(SRC, icon["path"])), icon
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m
        assert it["uid"] not in uids, it
        uids.add(it["uid"])


class Base(unittest.TestCase):
    """Two vaults: "Personal" (the default) and "Work Ünï" (Markdown links)."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="ob-test-"))
        self.app = os.path.join(self.tmp, "app")
        self.cache = os.path.join(self.tmp, "cache")
        os.makedirs(self.cache)
        self.personal = os.path.join(self.tmp, "vaults", "Personal")
        self.work = os.path.join(self.tmp, "vaults", "Work Ünï")
        self.vaults = {"p1": (self.personal, 2000, True), "w2": (self.work, 1000, False),
                       "gone": (os.path.join(self.tmp, "vaults", "Deleted"), 3000, False)}
        self.make_personal()
        self.make_work()
        self.save_vaults()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def save_vaults(self):
        write(os.path.join(self.app, "obsidian.json"), json.dumps(
            {"vaults": {k: {"path": p, "ts": ts, **({"open": True} if o else {})} for k, (p, ts, o) in self.vaults.items()}}))

    def P(self, *parts):
        return os.path.join(self.personal, *parts)

    def W(self, *parts):
        return os.path.join(self.work, *parts)

    def make_personal(self):
        old = time.time() - 86400 * 30
        write(self.P("Shopping List.md"), "---\naliases: [Groceries, \"Food list\"]\ntags:\n  - home\n  - shopping/weekly\n---\n"
              "# Shopping\n\n## Dairy\n- milk\n\n## Fruit\n- apples\n", mtime=old)
        write(self.P("Projects", "Plan.md"), "# Plan\nThe quick brown fox jumps over the café.\n#project/alpha\n", mtime=old + 10)
        write(self.P("Projects", "Zürich Trip.md"), "---\nalias: Zurich\ntags: travel, \"#summer\"\n---\nTrain tickets 🚆\n", mtime=old + 20)
        write(self.P("Journal", "Ideas.md"), "Some *ideas*\n```\n# not a heading #notatag\n```\n## Real Heading\n`#code` #real-tag #123\n", mtime=old + 30)
        write(self.P("Archive", "Old Plan.md"), "archived plan\n", mtime=old + 40)
        write(self.P("Canvas Board.canvas"), "{}", mtime=old + 50)
        write(self.P(".trash", "Deleted Note.md"), "plan\n")
        write(self.P(".obsidian", "workspace.json"), json.dumps({"lastOpenFiles": ["Journal/Ideas.md", "Missing.md", "Projects/Plan.md"]}))
        write(self.P(".obsidian", "app.json"), json.dumps({"userIgnoreFilters": ["Archive/"], "attachmentFolderPath": "Attachments"}))
        write(self.P(".obsidian", "daily-notes.json"), json.dumps({"folder": "Daily", "format": "YYYY-MM-DD", "template": "Templates/Daily"}))
        write(self.P(".obsidian", "templates.json"), json.dumps({"folder": "Templates", "dateFormat": "DD.MM.YYYY"}))
        write(self.P("Templates", "Daily.md"), "# {{date:dddd, MMMM Do YYYY}}\ntitle={{title}} date={{date}}\n\n## Log\n")
        write(self.P("Templates", "Meeting.md"), "---\ntype: meeting\n---\n# {{title}}\nDate: {{date}}\n\n{{content}}\n\n## Notes\n")
        write(self.P("Attachments", "photo.png"), b"\x89PNG")
        write(self.P("Attachments", "paper.pdf"), b"%PDF")
        write(self.P("Attachments", "song.mp3"), b"ID3")
        write(self.P("Archive", "old.png"), b"\x89PNG")

    def make_work(self):
        write(self.W("Plan.md"), "# Work plan\nQuarterly budget\n")
        write(self.W("Meetings", "Standup.md"), "## Blockers\nnone\n")
        write(self.W(".obsidian", "app.json"), json.dumps({"useMarkdownLinks": True, "newFileLocation": "folder", "newFileFolderPath": "Inbox"}))

    # ----- running the workflow -----

    def env(self, extra):
        e = {k: v for k, v in os.environ.items() if k not in CONFIG_VARS and not k.startswith(("ob_", "OB_"))}
        e.update(OB_TEST_APPSUPPORT=self.app, alfred_workflow_cache=self.cache, OB_TEST_NO_SPAWN="1",
                 OB_TEST_DRYRUN="1", OB_TEST_PASTEBOARD=PASTEBOARD, OB_TEST_NOW=NOW)
        e.update({k: str(v) for k, v in extra.items()})
        assert e["OB_TEST_APPSUPPORT"].startswith(self.tmp)  # never the real Obsidian configuration
        return e

    def js(self, args, **env):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./obsidian.js", *args], cwd=SRC, env=self.env(env),
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.rstrip("\n")

    def index(self, **env):
        self.js(["index-now"], **env)

    def sf(self, cmd, query="", index=True, **env):
        if index:
            self.index(**env)
        data = json.loads(self.js([cmd, query], **env))
        validate(data)
        return data

    def items(self, cmd, query="", **env):
        return self.sf(cmd, query, **env)["items"]

    def titles(self, cmd, query="", **env):
        return [i["title"] for i in self.items(cmd, query, **env)]

    def action(self, arg="", **env):
        return self.js(["action", arg], **env)

    def find(self, items, title):
        for i in items:
            if i["title"] == title:
                return i
        self.fail(f"{title!r} not in {[i['title'] for i in items]}")


# ---------- search ----------

class SearchTests(Base):
    def test_empty_query_lists_recent_notes_first(self):
        t = self.titles("search")
        self.assertEqual(t[:2], ["Ideas", "Plan"])  # workspace.json's lastOpenFiles, in order
        self.assertIn("Standup", t)
        self.assertNotIn("Old Plan", t)  # Obsidian's Excluded files
        self.assertNotIn("Deleted Note", t)  # hidden folders like .trash are never indexed

    def test_title_prefix_and_exact_ranking(self):
        t = self.titles("search", "plan")
        self.assertEqual(sorted(t[:2]), ["Plan", "Plan"])
        self.assertNotIn("Old Plan", t)

    def test_item_shape_and_mods(self):
        it = self.find(self.items("search", "shopping"), "Shopping List")
        path = self.P("Shopping List.md")
        self.assertEqual(it["arg"], path)
        self.assertEqual(it["type"], "file")
        self.assertEqual(it["quicklookurl"], path)
        self.assertEqual(it["text"]["copy"], "[[Shopping List]]")
        self.assertEqual(it["variables"]["ob_action"], "open")
        self.assertEqual(it["variables"]["ob_rel"], "Shopping List.md")
        m = it["mods"]
        self.assertEqual(m["cmd"]["arg"], "[[Shopping List]]")
        self.assertEqual(m["alt"]["variables"]["ob_action"], "reveal")
        self.assertEqual(m["ctrl"]["variables"]["ob_pane"], "tab")
        self.assertEqual(m["shift"]["variables"]["ob_action"], "append-clipboard")
        self.assertEqual(m["fn"]["variables"]["ob_action"], "default-app")
        self.assertEqual(m["cmd+alt"]["arg"], "obsidian://open?vault=Personal&file=Shopping%20List")
        self.assertEqual(m["cmd+shift"]["variables"]["ob_text"], "[Shopping List](obsidian://open?vault=Personal&file=Shopping%20List)")
        self.assertIn("Personal", it["subtitle"])  # two vaults: the vault is named

    def test_alias(self):
        it = self.items("search", "groceries")[0]
        self.assertEqual(it["title"], "Shopping List")
        self.assertIn("Alias “Groceries”", it["subtitle"])
        self.assertEqual(self.items("search", "zurich")[0]["title"], "Zürich Trip")

    def test_unicode_folding(self):
        self.assertEqual(self.titles("search", "zurich trip")[0], "Zürich Trip")
        self.assertEqual(self.titles("search", "ZÜRICH")[0], "Zürich Trip")
        self.assertEqual(self.titles("search", "cafe")[0], "Plan")

    def test_headings(self):
        items = self.items("search", "dairy")
        it = items[0]
        self.assertEqual(it["title"], "Dairy")
        self.assertIn("H2 in Shopping List", it["subtitle"])
        self.assertEqual(it["variables"]["ob_heading"], "Dairy")
        self.assertEqual(it["text"]["copy"], "[[Shopping List#Dairy]]")
        self.assertTrue(it["mods"]["cmd+alt"]["arg"].endswith("file=Shopping%20List%23Dairy"))
        self.assertEqual(len(items), 1)  # no extra content row for the same note
        # a fenced code block holds no headings
        self.assertEqual(self.titles("search", "not a heading"), ["Ideas"])
        self.assertEqual(self.items("search", "real heading")[0]["title"], "Real Heading")

    def test_content_search_with_snippet(self):
        it = self.find(self.items("search", "brown fox"), "Plan")
        self.assertIn("quick brown fox", it["subtitle"])
        self.assertEqual(it["icon"]["path"], "icons/content.png")
        self.assertEqual(self.titles("search", "quarterly budget"), ["Plan"])
        self.assertEqual(self.titles("search", "tickets 🚆"), ["Zürich Trip"])

    def test_content_search_can_be_turned_off(self):
        self.assertEqual(self.titles("search", "brown fox", search_content="0")[0], "Create “brown fox”")

    def test_tags(self):
        self.assertEqual(self.titles("search", "#home "), ["Shopping List"])
        self.assertEqual(self.titles("search", "#shopping "), ["Shopping List"])  # nested tag by its parent
        self.assertEqual(self.titles("search", "#summer "), ["Zürich Trip"])  # frontmatter "#summer"
        self.assertEqual(self.titles("search", "#real-tag "), ["Ideas"])
        self.assertEqual(self.titles("search", "#notatag "), ["No matching notes"])  # inside a code block
        self.assertEqual(self.titles("search", "#123 "), ["No matching notes"])  # numbers aren't tags
        self.assertEqual(self.titles("search", "#code "), ["No matching notes"])  # inline code
        self.assertEqual(self.titles("search", "#project fox"), ["Plan"])
        self.assertEqual(self.titles("search", "#shop "), ["No matching notes"])  # a finished tag matches exactly or nested
        self.assertEqual(self.titles("search", "#proj"), ["#project/alpha", "Plan"])  # while typing: by prefix

    def test_tag_suggestions(self):
        items = self.items("search", "#sh")
        self.assertEqual(items[0]["title"], "#shopping/weekly")
        self.assertEqual(items[0]["autocomplete"], "#shopping/weekly ")
        self.assertFalse(items[0]["valid"])
        self.assertEqual(items[1]["title"], "Shopping List")
        self.assertEqual(self.items("search", "#shopping/weekly ")[0]["title"], "Shopping List")  # a space ends the tag
        every = self.titles("search", "#")
        self.assertEqual(every[:3], ["#home", "#project/alpha", "#real-tag"])  # all tags, most used first, then by name
        self.assertIn("#travel", every)

    def test_folder_and_vault_filters(self):
        self.assertEqual(self.titles("search", "/projects"), ["Zürich Trip", "Plan"])
        self.assertEqual(self.titles("search", "/proj plan"), ["Plan"])
        t = self.titles("search", "@work plan")
        self.assertEqual(t, ["Plan"])
        self.assertEqual(self.items("search", "@work plan")[0]["arg"], self.W("Plan.md"))
        self.assertEqual(self.titles("search", "@wo"), ["Plan", "Standup"])

    def test_excluded_folders_setting(self):
        self.assertNotIn("Standup", self.titles("search", "standup", excluded_folders="Meetings, Nope"))
        self.assertNotIn("Plan", self.titles("search", "/projects", excluded_folders="/^Proj/"))

    def test_vaults_setting(self):
        self.assertEqual(self.titles("search", "plan", vaults="Work Ünï"), ["Plan"])
        self.assertEqual(self.titles("search", "plan", vaults="  work ünï  "), ["Plan"])  # names are compared loosely
        t = self.titles("search", "standup", vaults=self.work)
        self.assertEqual(t, ["Standup"])
        it = self.items("search", "", vaults="Nope")[0]
        self.assertEqual(it["title"], "Couldn’t find the vault “Nope”")
        # a folder that Obsidian doesn't know about still works
        extra = os.path.join(self.tmp, "Loose")
        write(os.path.join(extra, "Loose Note.md"), "x")
        self.assertEqual(self.titles("search", "loose", vaults=extra), ["Loose Note"])

    def test_no_results_offers_to_create(self):
        it = self.items("search", "brand new idea")[0]
        self.assertEqual(it["title"], "Create “brand new idea”")
        self.assertEqual(it["variables"]["ob_action"], "create")
        self.assertEqual(it["variables"]["ob_rel"], "brand new idea.md")
        self.assertEqual(it["variables"]["ob_vault"], self.personal)
        it = self.items("search", "Inbox/../../x #todo")[0]
        self.assertEqual(it["title"], "Create “x”")
        self.assertEqual(it["variables"]["ob_rel"], "Inbox/x.md")
        self.assertEqual(it["variables"]["ob_tags"], "todo")

    def test_append_mode(self):
        items = self.items("search", "shopping > oat milk")
        it = items[0]
        self.assertEqual(it["title"], "Shopping List")
        self.assertTrue(it["subtitle"].startswith("Append “oat milk” as a bullet"), it["subtitle"])
        self.assertEqual(it["variables"]["ob_action"], "append")
        self.assertEqual(it["variables"]["ob_text"], "oat milk")
        self.assertEqual(it["mods"]["alt"]["variables"]["ob_format"], "task")
        self.assertEqual(it["mods"]["ctrl"]["variables"]["ob_format"], "time")
        self.assertEqual(it["mods"]["fn"]["variables"]["ob_format"], "plain")
        self.assertEqual(it["mods"]["shift"]["variables"]["ob_open"], "1")
        self.assertEqual(it["mods"]["cmd"]["arg"], "[[Shopping List]]")  # ⌘ still pastes the link
        # headings are targets too
        h = self.find(self.items("search", "dairy > cheese"), "Dairy")
        self.assertEqual(h["variables"]["ob_heading"], "Dairy")
        # the canvas can't take text
        self.assertNotIn("Canvas Board", self.titles("search", "canvas > x"))
        waiting = self.items("search", "shopping >")[0]
        self.assertFalse(waiting["valid"])
        self.assertIn("Type the text to append", waiting["subtitle"])

    def test_link_formats(self):
        # "Plan" exists twice in Personal? No: Personal has Projects/Plan and Archive/Old Plan; unique
        self.assertEqual(self.find(self.items("search", "@pers plan"), "Plan")["text"]["copy"], "[[Plan]]")
        work = self.items("search", "@work standup")[0]
        self.assertEqual(work["text"]["copy"], "[Standup](Standup.md)")  # the vault uses Markdown links, shortest path
        self.assertEqual(self.items("search", "@work standup", link_format="wiki")[0]["text"]["copy"], "[[Standup]]")
        self.assertEqual(self.items("search", "@pers dairy", link_format="markdown")[0]["text"]["copy"],
                         "[Shopping List > Dairy](Shopping%20List.md#Dairy)")
        write(self.P("Other", "Plan.md"), "x")  # now "Plan" isn't unique in Personal
        links = sorted(i["text"]["copy"] for i in self.items("search", "@pers plan") if i["title"] == "Plan")
        self.assertEqual(links, ["[[Other/Plan]]", "[[Projects/Plan]]"])

    def test_duplicate_vault_names_use_the_id(self):
        twin = os.path.join(self.tmp, "elsewhere", "Personal")
        write(os.path.join(twin, "Twin.md"), "x")
        self.vaults["twin9"] = (twin, 10, False)
        self.save_vaults()
        it = self.items("search", "twin")[0]
        self.assertIn("vault=twin9", it["mods"]["cmd+alt"]["arg"])

    def test_canvas_notes(self):
        it = self.items("search", "canvas board")[0]
        self.assertEqual(it["icon"]["path"], "icons/canvas.png")
        self.assertEqual(it["text"]["copy"], "[[Canvas Board.canvas]]")
        self.assertFalse(it["mods"]["shift"]["valid"])

    def test_injection_and_odd_input(self):
        marker = os.path.join(self.tmp, "pwned")
        for q in [f'"; touch {marker}; "', f"$(touch {marker})", f"`touch {marker}`", "' OR 1=1 --", "\\", "a\nb", "\u202eevil", "__proto__", "constructor"]:
            self.assertTrue(self.sf("search", q)["items"])
            self.assertTrue(self.sf("new", q, index=False)["items"])
            self.assertTrue(self.sf("daily", q, index=False)["items"])
        self.assertFalse(os.path.exists(marker))
        for q in [f"-e {marker}", "--help", "-", "\t"]:
            self.sf("search", q)

    def test_odd_file_names(self):
        write(self.P("Quotes \"and\" 'apostrophes' & $dollar.md"), "odd one\n")
        write(self.P("Emoji 🚀 Note.md"), "rocket\n")
        write(self.P("\u202eevil.md"), "bidi\n")
        write(self.P("Latin1.md"), "caf\xe9 cr\xe8me".encode("latin-1"))
        self.assertEqual(self.titles("search", "apostrophes"), ["Quotes \"and\" 'apostrophes' & $dollar"])
        self.assertEqual(self.titles("search", "rocket"), ["Emoji 🚀 Note"])
        self.assertEqual(self.titles("search", "bidi"), ["evil"])
        self.assertEqual(self.titles("search", "creme"), ["Latin1"])

    def test_uids_are_stable(self):
        a = self.sf("search", "plan")
        b = self.sf("search", "plan")
        self.assertEqual([i["uid"] for i in a["items"]], [i["uid"] for i in b["items"]])

    def test_no_vaults(self):
        os.remove(os.path.join(self.app, "obsidian.json"))
        for cmd in ("search", "new", "daily", "media", "bookmarks", "vaults"):
            it = self.items(cmd, "x", index=False)[0]
            self.assertEqual(it["title"], "No Obsidian vaults found")
        write(os.path.join(self.app, "obsidian.json"), "{not json")
        self.assertEqual(self.titles("search", "", index=False), ["No Obsidian vaults found"])


class IndexTests(Base):
    def index_of(self, vault):
        name = [f for f in os.listdir(self.cache) if f.startswith("index-")]
        for f in name:
            with open(os.path.join(self.cache, f)) as fh:
                j = json.load(fh)
            if j["root"] == vault:
                return j
        self.fail("no index for " + vault)

    def note(self, vault, rel):
        for n in self.index_of(vault)["notes"]:
            if n["p"] == rel:
                return n
        self.fail(rel)

    def test_missing_index_shows_indexing_and_reruns(self):
        data = json.loads(self.js(["search", "plan"]))
        validate(data)
        self.assertEqual(data["items"][0]["title"], "Indexing your vaults…")
        self.assertEqual(data["rerun"], 0.5)

    def test_parsed_metadata(self):
        self.index()
        n = self.note(self.personal, "Shopping List.md")
        self.assertEqual(n["a"], ["Groceries", "Food list"])
        self.assertEqual(n["t"], ["home", "shopping/weekly"])
        self.assertEqual(n["h"], [[1, "Shopping"], [2, "Dairy"], [2, "Fruit"]])
        self.assertEqual(n["w"], 5)  # Markdown markers aren't words
        z = self.note(self.personal, "Projects/Zürich Trip.md")
        self.assertEqual(z["a"], ["Zurich"])
        self.assertEqual(z["t"], ["travel", "summer"])
        i = self.note(self.personal, "Journal/Ideas.md")
        self.assertEqual(i["t"], ["real-tag"])
        self.assertEqual(i["h"], [[2, "Real Heading"]])
        paths = {n["p"] for n in self.index_of(self.personal)["notes"]}
        self.assertNotIn(".trash/Deleted Note.md", paths)
        self.assertIn("Canvas Board.canvas", paths)
        media = {m["p"] for m in self.index_of(self.personal)["media"]}
        self.assertEqual(media, {"Attachments/photo.png", "Attachments/paper.pdf", "Attachments/song.mp3", "Archive/old.png"})

    def test_frontmatter_variants(self):
        write(self.P("FM1.md"), "---\naliases:\n  - \"One\"\n  - 'Two'\ntags: [a, \"b c\"]\n---\nx\n")
        write(self.P("FM2.md"), "---\nalias: Solo, Duo\ntags: x y\n---\n")
        write(self.P("FM3.md"), "---\r\ntags:\r\n- crlf\r\n---\r\n# Head\r\n")
        write(self.P("FM4.md"), "---\nnot closed\n# Heading\n")
        self.index()
        self.assertEqual(self.note(self.personal, "FM1.md")["a"], ["One", "Two"])
        self.assertEqual(self.note(self.personal, "FM1.md")["t"], ["a", "b c"])
        self.assertEqual(self.note(self.personal, "FM2.md")["a"], ["Solo", "Duo"])
        self.assertEqual(self.note(self.personal, "FM2.md")["t"], ["x", "y"])
        self.assertEqual(self.note(self.personal, "FM3.md")["t"], ["crlf"])
        self.assertEqual(self.note(self.personal, "FM3.md")["h"], [[1, "Head"]])
        self.assertEqual(self.note(self.personal, "FM4.md")["h"], [[1, "Heading"]])

    def test_incremental_update(self):
        self.index()
        before = self.index_of(self.personal)
        write(self.P("Projects", "Plan.md"), "# Plan v2\nnew words here\n")
        os.remove(self.P("Journal", "Ideas.md"))
        write(self.P("New One.md"), "fresh content xyzzy\n")
        self.index()
        after = self.index_of(self.personal)
        paths = {n["p"] for n in after["notes"]}
        self.assertIn("New One.md", paths)
        self.assertNotIn("Journal/Ideas.md", paths)
        self.assertEqual(self.note(self.personal, "Projects/Plan.md")["h"], [[1, "Plan v2"]])
        old = {n["p"]: n for n in before["notes"]}
        self.assertEqual(self.note(self.personal, "Shopping List.md"), old["Shopping List.md"])
        self.assertEqual(self.titles("search", "xyzzy"), ["New One"])
        self.assertEqual(self.titles("search", "brown fox", search_content="1")[0], "Create “brown fox”")
        # nothing changed: the index file isn't rewritten, only the stamp
        idx = [f for f in os.listdir(self.cache) if f.startswith("index-")][0]
        m1 = os.stat(os.path.join(self.cache, idx)).st_mtime_ns
        time.sleep(0.05)
        self.index()
        self.assertEqual(os.stat(os.path.join(self.cache, idx)).st_mtime_ns, m1)

    def test_background_indexer(self):
        data = json.loads(self.js(["search", "plan"], OB_TEST_NO_SPAWN=""))
        self.assertEqual(data["items"][0]["title"], "Indexing your vaults…")
        deadline = time.time() + 30
        while time.time() < deadline:
            data = json.loads(self.js(["search", "plan"], OB_TEST_NO_SPAWN=""))
            if data["items"][0]["title"] == "Plan":
                break
            time.sleep(0.3)
        self.assertEqual(data["items"][0]["title"], "Plan")
        while any(f.endswith(".lock") for f in os.listdir(self.cache)) and time.time() < deadline:
            time.sleep(0.2)  # let the indexer finish before the folder is removed

    def test_indexes_of_removed_vaults_are_deleted(self):
        self.index()
        self.assertEqual(len([f for f in os.listdir(self.cache) if f.startswith("index-")]), 2)
        del self.vaults["w2"]
        self.save_vaults()
        self.js(["index"])  # the background job, run in the foreground
        left = sorted(f.split("-")[0] for f in os.listdir(self.cache) if not f.endswith(".lock"))
        self.assertEqual(left, ["content", "index", "stamp"])
        self.assertEqual(self.index_of(self.personal)["root"], self.personal)
        # limiting the vaults in the Workflow's Configuration also drops the others' indexes
        self.index(vaults="Nope")
        self.assertEqual([f for f in os.listdir(self.cache) if f.startswith(("index-", "content-", "stamp-"))], [])
        # an unreadable obsidian.json (e.g. being written) keeps them
        self.index()
        write(os.path.join(self.app, "obsidian.json"), "{half")
        self.index()
        self.assertEqual(len([f for f in os.listdir(self.cache) if f.startswith("index-")]), 1)

    def test_big_first_index_publishes_names_first(self):
        for i in range(320):
            write(self.P("Bulk", f"Bulk {i}.md"), f"# Bulk {i}\nbody {i}\n")
        self.index()
        self.assertEqual(self.titles("search", "bulk 7")[0], "Bulk 7")
        self.assertFalse(any(n.get("x") for n in self.index_of(self.personal)["notes"]))

    def test_large_vault_performance(self):
        rnd = random.Random(7)
        words = "alpha beta gamma delta river ocean forest meeting project budget design review idea".split()
        big = os.path.join(self.tmp, "vaults", "Big")
        for i in range(3000):
            body = "\n".join(" ".join(rnd.choice(words) for _ in range(12)) for _ in range(20))
            write(os.path.join(big, f"f{i % 30}", f"Note {i} {rnd.choice(words)}.md"),
                  f"---\naliases: [a{i}]\ntags: [t{i % 40}]\n---\n# Note {i}\n{body}\n## Section {rnd.choice(words)}\n#tag{i % 25}\n")
        self.vaults["big"] = (big, 5000, True)
        self.save_vaults()
        t0 = time.time()
        self.index()
        build = time.time() - t0
        t0 = time.time()
        self.index()
        refresh = time.time() - t0
        timings = {}
        for q in ["", "note 1234", "river ocean", "#t7 budget", "zzqqxx"]:
            t0 = time.time()
            data = json.loads(self.js(["search", q]))
            timings[q] = time.time() - t0
            validate(data)
        print(f"\n    3000 notes: index {build:.2f}s, refresh {refresh:.2f}s, search " +
              ", ".join(f"{q or 'empty'!r} {t * 1000:.0f} ms" for q, t in timings.items()))
        self.assertLess(build, 60)
        self.assertLess(refresh, 5)
        self.assertLess(max(timings.values()), 2.0)  # typically 100-250 ms; generous for slow CI Macs
        self.assertEqual(json.loads(self.js(["search", "note 1234"]))["items"][0]["title"].split(" ")[:2], ["Note", "1234"])


# ---------- daily notes ----------

class DailyTests(Base):
    def test_rows(self):
        items = self.items("daily")
        self.assertEqual(items[0]["title"], "Today: 2026-09-27")
        self.assertEqual(items[0]["subtitle"], "Create Daily/2026-09-27.md · Personal")
        self.assertEqual(items[0]["variables"]["ob_action"], "daily-open")
        self.assertEqual(items[0]["variables"]["ob_date"], "2026-09-27")
        self.assertEqual(items[0]["mods"]["cmd"]["arg"], "[[2026-09-27]]")
        self.assertFalse(items[0]["mods"]["alt"]["valid"])  # nothing to reveal yet
        self.assertFalse(items[1]["valid"])
        self.assertEqual([i["title"] for i in items[2:]], ["Yesterday: 2026-09-26", "Tomorrow: 2026-09-28"])
        write(self.P("Daily", "2026-09-27.md"), "x")
        self.assertTrue(self.items("daily")[0]["subtitle"].startswith("Open Daily/2026-09-27.md"))

    def test_specific_days(self):
        self.assertEqual(self.titles("daily", "yesterday")[0], "Yesterday: 2026-09-26")
        items = self.items("daily", "2026-01-05")
        self.assertEqual(items[0]["title"], "Mon 5 Jan 2026: 2026-01-05")
        self.assertEqual(items[1]["title"], "Append to 2026-09-27")  # appending the text stays possible
        self.assertEqual(self.titles("daily", "2026-02-30")[0], "Append to 2026-09-27")

    def test_open_creates_from_template(self):
        out = self.action("x", ob_action="daily-open", ob_vault=self.personal, ob_date="2026-09-27")
        self.assertEqual(out, "open obsidian://open?path=" + enc(self.P("Daily", "2026-09-27.md")))
        text = read(self.P("Daily", "2026-09-27.md"))
        self.assertEqual(text, "# Sunday, September 27th 2026\ntitle=2026-09-27 date=2026-09-27\n\n## Log\n")
        write(self.P("Daily", "2026-09-27.md"), "mine")
        self.action("x", ob_action="daily-open", ob_vault=self.personal, ob_date="2026-09-27")
        self.assertEqual(read(self.P("Daily", "2026-09-27.md")), "mine")  # never overwritten

    def test_formats_and_week_tokens(self):
        cases = {
            "YYYY/MM/YYYY-MM-DD dddd": ("2026-09-27T10:00:00", "2026/09/2026-09-27 Sunday"),
            "GGGG-[W]WW": ("2021-01-01T10:00:00", "2020-W53"),
            "gggg-[w]ww": ("2021-01-01T10:00:00", "2021-w01"),
            "Do MMM YY, ddd [the] DDDo [day], Q": ("2024-12-31T10:00:00", "31st Dec 24, Tue the 366th day, 4"),
            "YYYYMMDDHHmm": ("2026-03-04T05:06:00", "202603040506"),
            "[Daily] D.M.YYYY": ("2026-03-04T05:06:00", "Daily 4.3.2026"),
        }
        for fmt, (now, want) in cases.items():
            write(self.P(".obsidian", "daily-notes.json"), json.dumps({"format": fmt}))
            it = self.items("daily", OB_TEST_NOW=now)[0]
            self.assertEqual(it["variables"]["ob_date"], now[:10])
            self.assertEqual(it["subtitle"], f"Create {want}.md · Personal", fmt)

    def test_defaults_without_settings(self):
        os.remove(self.P(".obsidian", "daily-notes.json"))
        self.action("", ob_action="daily-open", ob_vault=self.personal, ob_date="2026-09-27")
        self.assertEqual(read(self.P("2026-09-27.md")), "")

    def test_periodic_notes_plugin(self):
        write(self.P(".obsidian", "community-plugins.json"), json.dumps(["periodic-notes"]))
        write(self.P(".obsidian", "plugins", "periodic-notes", "data.json"),
              json.dumps({"daily": {"enabled": True, "folder": "Journal/Days", "format": "DD-MM-YYYY", "template": ""}}))
        self.assertEqual(self.items("daily")[0]["subtitle"], "Create Journal/Days/27-09-2026.md · Personal")

    def append(self, text, **env):
        env.setdefault("ob_vault", self.personal)
        env.setdefault("ob_date", "2026-09-27")
        return self.action(self.P("Daily", "2026-09-27.md"), ob_action="daily-append", ob_text=text, **env)

    def test_append_formats(self):
        self.assertEqual(self.append("first", ob_format="bullet"), "Added to 2026-09-27")
        self.append("a task", ob_format="task")
        self.append("plain words", ob_format="plain")
        self.append("custom", ob_format="custom", append_custom="* [{{date:DD.MM}}] {{text}} !")
        self.append("line one\nline two", ob_format="bullet")
        self.append("stamped", ob_format="time")
        text = read(self.P("Daily", "2026-09-27.md"))
        head = "# Sunday, September 27th 2026\ntitle=2026-09-27 date=2026-09-27\n\n## Log\n"
        self.assertTrue(text.startswith(head + "- first\n- [ ] a task\n\nplain words\n* [27.09] custom !\n- line one\n  line two\n- "), text)
        self.assertRegex(text, r"- \d\d:\d\d stamped\n$")

    def test_append_under_heading(self):
        write(self.P("Daily", "2026-09-27.md"), "# Day\n\n## Log\n- one\n\n\n## Later\ntext\n")
        self.append("two", ob_heading="## Log")
        self.append("three", ob_heading="log")  # any level, case-insensitive
        self.append("inbox item", ob_heading="Inbox")  # created at the end
        self.append("more later", ob_heading="later")
        text = read(self.P("Daily", "2026-09-27.md"))
        self.assertIn("## Log\n- one\n- two\n- three\n\n\n## Later\ntext\n- more later\n", text)
        self.assertTrue(text.endswith("## Inbox\n- inbox item\n"), text)

    def test_heading_setting_and_crlf(self):
        write(self.P("Daily", "2026-09-27.md"), "# Day\r\n## Tasks\r\n- a\r\n## End\r\n")
        self.append("b", ob_heading="Tasks")
        self.assertEqual(read(self.P("Daily", "2026-09-27.md")), "# Day\r\n## Tasks\r\n- a\r\n- b\r\n\r\n## End\r\n")
        rows = self.items("daily", "note", daily_heading="## Tasks")
        self.assertEqual(rows[0]["variables"]["ob_heading"], "## Tasks")
        self.assertIn("Under “## Tasks”", rows[0]["subtitle"])

    def test_hotkey_append_uses_default_vault(self):
        out = self.action("from the hotkey", ob_action="daily-append")
        self.assertEqual(out, "Added to 2026-09-27")
        self.assertTrue(read(self.P("Daily", "2026-09-27.md")).endswith("## Log\n- from the hotkey\n"))
        self.action("work entry", ob_action="daily-append", default_vault="work ünï")
        self.assertEqual(read(self.W("2026-09-27.md")), "- work entry\n")

    def test_vault_token_and_open_after(self):
        rows = self.items("daily", "@work fix bug")
        self.assertEqual(rows[0]["variables"]["ob_vault"], self.work)
        self.assertEqual(rows[0]["variables"]["ob_text"], "fix bug")
        out = self.append("x", open_after_append="1")
        self.assertEqual(out, "open obsidian://open?path=" + enc(self.P("Daily", "2026-09-27.md")))
        self.assertEqual(self.append("  "), "Nothing to append")

    def test_append_rows(self):
        rows = self.items("daily", "call “Bob” 'now' $HOME")
        it = rows[0]
        self.assertEqual(it["title"], "Append to 2026-09-27")
        self.assertEqual(it["variables"]["ob_text"], "call “Bob” 'now' $HOME")
        self.assertEqual(it["variables"]["ob_action"], "daily-append")
        self.assertEqual(it["mods"]["alt"]["variables"]["ob_action"], "daily-append")
        self.assertEqual(it["mods"]["alt"]["variables"]["ob_format"], "task")
        self.assertEqual(self.items("daily", "x", append_format="task")[0]["mods"]["alt"]["variables"]["ob_format"], "bullet")
        multi = self.items("daily", "one\ntwo")[0]
        self.assertNotIn("\n", multi["subtitle"])


# ---------- new notes ----------

class NewNoteTests(Base):
    def test_rows(self):
        items = self.items("new", "Weekly Review")
        self.assertEqual([i["title"] for i in items], ["Create “Weekly Review”", "Create “Weekly Review” from Daily", "Create “Weekly Review” from Meeting"])
        it = items[0]
        self.assertEqual(it["variables"]["ob_rel"], "Weekly Review.md")
        self.assertEqual(it["variables"]["ob_template"], "")
        self.assertEqual(items[2]["variables"]["ob_template"], "Templates/Meeting.md")
        self.assertEqual(it["mods"]["shift"]["variables"]["ob_open"], "0")
        self.assertEqual(it["mods"]["alt"]["variables"]["ob_clipboard"], "1")
        self.assertFalse(it["mods"]["cmd"]["valid"])
        # modifiers a row has no use for do nothing, instead of running ↩
        for k in ("fn", "cmd+alt", "cmd+shift"):
            self.assertFalse(it["mods"][k]["valid"], k)

    def test_default_template_and_folder_settings(self):
        items = self.items("new", "Sync", new_note_template="meeting", new_note_folder="Inbox/Sub")
        self.assertEqual(items[0]["title"], "Create “Sync” from Meeting")
        self.assertEqual(items[0]["variables"]["ob_rel"], "Inbox/Sub/Sync.md")
        self.assertEqual(items[1]["title"], "Create “Sync” as a blank note")
        # the Work vault's own "Default location for new notes"
        self.assertEqual(self.items("new", "@work Idea")[0]["variables"]["ob_rel"], "Inbox/Idea.md")

    def test_parsing(self):
        it = self.items("new", "Projects/Deep/My: Idea? #idea #x/y > first line")[0]
        v = it["variables"]
        self.assertEqual(v["ob_rel"], "Projects/Deep/My Idea.md")
        self.assertEqual(v["ob_tags"], "idea\nx/y")
        self.assertEqual(v["ob_content"], "first line")
        self.assertEqual(self.items("new", "../../etc/passwd")[0]["variables"]["ob_rel"], "etc/passwd.md")
        self.assertEqual(self.items("new", ".hidden")[0]["variables"]["ob_rel"], "hidden.md")
        empty = self.items("new", "")
        self.assertFalse(empty[0]["valid"])

    def test_existing_note(self):
        items = self.items("new", "Shopping List")
        self.assertEqual(items[0]["title"], "Shopping List")
        self.assertTrue(items[0]["subtitle"].startswith("Already exists"))
        self.assertEqual(items[1]["title"], "Create “Shopping List 1”")

    def test_from_selection(self):
        it = self.items("new", "> # Big Title\nsecond line")[0]
        self.assertEqual(it["variables"]["ob_rel"], "Big Title.md")
        self.assertEqual(it["variables"]["ob_content"], "# Big Title\nsecond line")

    def create(self, rel, **env):
        env.setdefault("ob_vault", self.personal)
        return self.action(rel, ob_action="create", ob_rel=rel, **env)

    def test_create_blank_and_open(self):
        out = self.create("New/Deep/Idea.md", ob_content="hello")
        self.assertEqual(out, "open obsidian://open?path=" + enc(self.P("New", "Deep", "Idea.md")))
        self.assertEqual(read(self.P("New", "Deep", "Idea.md")), "hello\n")
        self.assertEqual(self.create("Quiet.md", ob_open="0"), "Created Quiet")
        self.assertEqual(read(self.P("Quiet.md")), "")

    def test_create_from_template(self):
        self.create("Sync.md", ob_template="Templates/Meeting.md", ob_content="agenda", ob_tags="work\nq3", ob_open="0")
        self.assertEqual(read(self.P("Sync.md")), "---\ntype: meeting\ntags:\n  - work\n  - q3\n---\n# Sync\nDate: 27.09.2026\n\nagenda\n\n## Notes\n")
        # content goes to the end when the template has no {{content}}
        self.create("Day.md", ob_template="Templates/Daily.md", ob_content="extra", ob_open="0")
        self.assertTrue(read(self.P("Day.md")).endswith("## Log\n\nextra\n"))

    def test_tags_frontmatter(self):
        write(self.P("Templates", "T1.md"), "---\ntags: [a]\n---\nbody\n")
        write(self.P("Templates", "T2.md"), "---\ntags: a, b\n---\n")
        write(self.P("Templates", "T3.md"), "---\ntags:\n  - a\n---\n")
        self.create("N0.md", ob_tags="x", ob_open="0")
        self.create("N1.md", ob_template="Templates/T1.md", ob_tags="x", ob_open="0")
        self.create("N2.md", ob_template="Templates/T2.md", ob_tags="x", ob_open="0")
        self.create("N3.md", ob_template="Templates/T3.md", ob_tags="x", ob_open="0")
        self.assertEqual(read(self.P("N0.md")), "---\ntags:\n  - x\n---\n")
        self.assertEqual(read(self.P("N1.md")), '---\ntags: [a, "x"]\n---\nbody\n')
        self.assertEqual(read(self.P("N2.md")), "---\ntags:\n  - a\n  - b\n  - x\n---\n")
        self.assertEqual(read(self.P("N3.md")), "---\ntags:\n  - x\n  - a\n---\n")

    def test_create_never_overwrites(self):
        write(self.P("Taken.md"), "original")
        self.create("Taken.md", ob_open="0", ob_content="new")
        self.assertEqual(read(self.P("Taken.md")), "original")
        self.assertEqual(read(self.P("Taken 1.md")), "new\n")

    def test_create_refuses_bad_paths(self):
        for rel in ["../escape.md", "/abs.md", ".hidden.md", "x/.git/y.md", "note.txt", ""]:
            self.assertEqual(self.create(rel), "Couldn’t create the note: invalid name", rel)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "vaults", "escape.md")))

    def test_create_with_clipboard(self):
        set_pasteboard("from the clipboard ✓")
        self.create("Clip.md", ob_clipboard="1", ob_open="0")
        self.assertEqual(read(self.P("Clip.md")), "from the clipboard ✓\n")


# ---------- appending to notes ----------

class AppendTests(Base):
    def test_append_to_end_keeps_file(self):
        write(self.P("NoNewline.md"), "last line")
        out = self.action(self.P("NoNewline.md"), ob_action="append", ob_vault=self.personal, ob_rel="NoNewline.md", ob_text="added", ob_format="bullet")
        self.assertEqual(out, "Added to NoNewline")
        self.assertEqual(read(self.P("NoNewline.md")), "last line\n- added\n")

    def test_append_under_heading_row(self):
        self.action("", ob_action="append", ob_vault=self.personal, ob_rel="Shopping List.md", ob_text="cheese", ob_heading="Dairy", ob_format="bullet")
        self.assertIn("## Dairy\n- milk\n- cheese\n\n## Fruit", read(self.P("Shopping List.md")))

    def test_append_clipboard(self):
        set_pasteboard("pasted paragraph")
        self.action("", ob_action="append-clipboard", ob_vault=self.personal, ob_rel="Journal/Ideas.md")
        self.assertTrue(read(self.P("Journal", "Ideas.md")).endswith("#real-tag #123\n\npasted paragraph\n"))
        set_pasteboard("")
        self.assertEqual(self.action("", ob_action="append-clipboard", ob_vault=self.personal, ob_rel="Journal/Ideas.md"),
                         "The clipboard has no text to append")

    def test_append_to_missing_note(self):
        self.assertEqual(self.action("", ob_action="append", ob_vault=self.personal, ob_rel="Gone.md", ob_text="x"), "“Gone.md” no longer exists")
        self.assertEqual(self.action("", ob_action="append", ob_vault=self.personal, ob_rel="../Work Ünï/Plan.md", ob_text="x"),
                         "“Plan.md” no longer exists")


# ---------- media, bookmarks, vaults ----------

class MediaTests(Base):
    def test_list_and_filters(self):
        t = self.titles("media")
        self.assertEqual(sorted(t), ["paper.pdf", "photo.png", "song.mp3"])  # Archive is excluded
        self.assertEqual(self.titles("media", ".png"), ["photo.png"])
        self.assertEqual(self.titles("media", "pdf"), ["paper.pdf"])
        self.assertEqual(self.titles("media", "audio"), ["song.mp3"])
        self.assertEqual(self.titles("media", "phot"), ["photo.png"])
        self.assertEqual(self.titles("media", "/attach so"), ["song.mp3"])
        self.assertEqual(self.titles("media", "nothing here"), ["No matching attachments"])

    def test_item(self):
        it = self.items("media", "photo")[0]
        self.assertEqual(it["arg"], self.P("Attachments", "photo.png"))
        self.assertEqual(it["icon"], {"type": "fileicon", "path": it["arg"]})
        self.assertEqual(it["mods"]["cmd"]["arg"], "![[photo.png]]")
        self.assertEqual(it["mods"]["ctrl"]["variables"]["ob_action"], "copy-file")
        self.assertEqual(it["variables"]["ob_rel"], "Attachments/photo.png")
        out = self.action(it["arg"], **it["variables"])
        self.assertEqual(out, "open obsidian://open?path=" + enc(self.P("Attachments", "photo.png")))


class BookmarkTests(Base):
    def setUp(self):
        super().setUp()
        write(self.P(".obsidian", "bookmarks.json"), json.dumps({"items": [
            {"type": "file", "path": "Shopping List.md", "ctime": 1},
            {"type": "file", "path": "Shopping List.md", "subpath": "#Dairy", "title": "Milk section"},
            {"type": "group", "title": "Work", "items": [
                {"type": "file", "path": "Projects/Plan.md", "subpath": "#^abc123"},
                {"type": "search", "query": "tag:#project"},
                {"type": "folder", "path": "Projects"},
                {"type": "url", "url": "https://obsidian.md/help", "title": "Help"},
                {"type": "url", "url": "javascript:alert(1)"},
                {"type": "graph"},
            ]},
        ]}))

    def test_rows(self):
        items = self.items("bookmarks", "@pers")
        self.assertEqual([i["title"] for i in items], ["Shopping List", "Milk section", "Plan", "tag:#project", "Projects", "Help"])
        self.assertEqual(items[1]["variables"]["ob_heading"], "Dairy")
        self.assertEqual(items[2]["variables"]["ob_heading"], "^abc123")
        self.assertEqual(items[2]["text"]["copy"], "[[Plan#^abc123]]")
        self.assertIn("Work", items[2]["subtitle"])
        self.assertEqual(items[3]["variables"]["ob_action"], "obsidian-search")
        self.assertEqual(items[4]["variables"]["ob_action"], "reveal")
        self.assertEqual(items[5]["variables"]["ob_action"], "open-url")
        self.assertEqual(self.titles("bookmarks", "milk"), ["Milk section"])
        self.assertEqual(self.titles("bookmarks", "work help"), ["Help"])

    def test_actions(self):
        items = self.items("bookmarks", "@pers")
        self.assertEqual(self.action(items[3]["arg"], **items[3]["variables"]), "open obsidian://search?vault=p1&query=tag%3A%23project")
        self.assertEqual(self.action(items[5]["arg"], **items[5]["variables"]), "open https://obsidian.md/help")
        self.assertEqual(self.action(items[1]["arg"], **items[1]["variables"]), "open obsidian://open?vault=p1&file=Shopping%20List.md%23Dairy")

    def test_starred_fallback_and_empty(self):
        os.remove(self.P(".obsidian", "bookmarks.json"))
        write(self.P(".obsidian", "starred.json"), json.dumps({"items": [{"type": "file", "title": "Plan", "path": "Projects/Plan.md"}]}))
        self.assertEqual(self.titles("bookmarks", "@pers"), ["Plan"])
        os.remove(self.P(".obsidian", "starred.json"))
        self.assertEqual(self.titles("bookmarks", "@pers"), ["No bookmarks yet"])
        write(self.P(".obsidian", "bookmarks.json"), "{broken")
        self.assertEqual(self.titles("bookmarks", "@pers"), ["No bookmarks yet"])


class VaultTests(Base):
    def test_rows(self):
        items = self.items("vaults")
        self.assertEqual([i["title"] for i in items], ["Random Note", "Personal", "Work Ünï", "Open Obsidian’s vault switcher"])
        self.assertIn("8 notes", items[1]["subtitle"])  # excluded files count; they are left out of searches only
        self.assertIn("default", items[1]["subtitle"])
        self.assertEqual(items[1]["variables"]["ob_action"], "open-vault")
        self.assertEqual(self.titles("vaults", "work"), ["Work Ünï"])
        self.assertEqual(self.items("vaults", "work", default_vault="Work Ünï")[0]["title"], "Work Ünï")

    def test_actions(self):
        self.index()
        self.assertEqual(self.action("", ob_action="open-vault", ob_vault=self.work), "open obsidian://open?vault=w2")
        out = self.action("", ob_action="random", ob_vault=self.work, OB_TEST_RANDOM="1")
        self.assertTrue(out.startswith("open obsidian://open?path=" + enc(self.work + "/")), out)
        out = self.action("", ob_action="random", ob_reveal="1", OB_TEST_RANDOM="0")
        self.assertTrue(out.startswith("reveal " + self.tmp), out)
        self.assertEqual(self.action("", ob_action="choose-vault"), "open obsidian://choose-vault")
        self.assertEqual(self.action("", ob_action="reindex", ob_vault=self.work), "Rebuilding the index of Work Ünï")
        self.assertEqual(len([f for f in os.listdir(self.cache) if f.startswith("index-")]), 1)


# ---------- actions ----------

class ActionTests(Base):
    def test_open_panes_and_headings(self):
        base = dict(ob_action="open", ob_vault=self.personal, ob_rel="Shopping List.md")
        path = "open obsidian://open?path=" + enc(self.P("Shopping List.md"))
        self.assertEqual(self.action("", **base), path)
        self.assertEqual(self.action("", ob_pane="tab", **base), path + "&paneType=tab")
        self.assertEqual(self.action("", open_in="window", **base), path + "&paneType=window")
        # a heading needs vault + file: the vault's ID from obsidian.json
        self.assertEqual(self.action("", ob_heading="Dairy", **base), "open obsidian://open?vault=p1&file=Shopping%20List.md%23Dairy")
        write(self.P(".obsidian", "community-plugins.json"), json.dumps(["obsidian-advanced-uri"]))
        self.assertEqual(self.action("", ob_heading="Dairy", ob_pane="tab", **base),
                         "open obsidian://adv-uri?vault=p1&filepath=Shopping%20List.md&heading=Dairy&openmode=tab")

    def test_vault_obsidian_does_not_know(self):
        # a vault folder only listed in the Workflow's Configuration: obsidian:// URLs can't reach it
        extra = os.path.join(self.tmp, "Second Brain")
        write(os.path.join(extra, "Meetings", "Design sync.md"), "# Agenda\nx\n")
        write(os.path.join(extra, ".obsidian", "bookmarks.json"), json.dumps({"items": [{"type": "search", "query": "x"}]}))
        write(os.path.join(extra, "pic.png"), b"x")
        msg = "“Second Brain” isn’t open in Obsidian yet: open it once via Open folder as vault, then notes open there."
        note = os.path.join(extra, "Meetings", "Design sync.md")
        base = dict(vaults=extra + ", Personal", ob_vault=extra)
        self.assertEqual(self.action("", ob_action="open", ob_rel="Meetings/Design sync.md", **base), f"default-app {note} · {msg}")
        self.assertEqual(self.action("", ob_action="open", ob_rel="Meetings/Design sync.md", ob_heading="Agenda", ob_pane="tab", **base),
                         f"default-app {note} · {msg}")
        self.assertEqual(self.action("", ob_action="create", ob_rel="Meetings/New.md", **base),
                         f"default-app {os.path.join(extra, 'Meetings', 'New.md')} · {msg}")
        self.assertEqual(self.action("", ob_action="daily-open", ob_date="2026-09-27", **base),
                         f"default-app {os.path.join(extra, '2026-09-27.md')} · {msg}")
        self.index(vaults=base["vaults"])
        self.assertEqual(self.action("", ob_action="random", OB_TEST_RANDOM="0", **base).split(" · ")[1], msg)
        self.assertEqual(self.action("", ob_action="open-vault", **base), f"reveal {extra} · {msg}")
        self.assertEqual(self.action("", ob_action="obsidian-search", ob_text="x", **base), msg)
        self.assertTrue(self.action("", ob_action="append", ob_rel="Meetings/Design sync.md", ob_text="y", ob_open="1", **base).endswith(msg))
        # rows say so before ↩, in every keyword
        env = dict(vaults=extra + ", Personal")
        self.assertIn("not open in Obsidian yet", self.items("search", "@second design", **env)[0]["subtitle"])
        self.assertIn("not open in Obsidian yet", self.items("search", "@second agenda", **env)[0]["subtitle"])
        self.assertIn("not open in Obsidian yet", self.items("daily", "@second", **env)[0]["subtitle"])
        self.assertIn("not open in Obsidian yet", self.items("new", "@second Idea", **env)[0]["subtitle"])
        self.assertIn("not open in Obsidian yet", self.items("media", "@second pic", **env)[0]["subtitle"])
        self.assertIn("not open in Obsidian yet", self.items("bookmarks", "@second", **env)[0]["subtitle"])
        rows = {i["title"]: i["subtitle"] for i in self.items("vaults", **env)}
        self.assertIn("not open in Obsidian yet", rows["Second Brain"])
        self.assertNotIn("not open in Obsidian yet", rows["Personal"])
        self.assertNotIn("not open in Obsidian yet", self.items("search", "@pers shopping", **env)[0]["subtitle"])

    def test_registered_vault_through_a_symlink(self):
        link = os.path.join(self.tmp, "link-to-personal")
        os.symlink(self.personal, link)
        out = self.action("", ob_action="open", ob_vault=link, ob_rel="Shopping List.md", vaults=link)
        self.assertEqual(out, "open obsidian://open?path=" + enc(os.path.join(link, "Shopping List.md")))
        self.assertNotIn("not open in Obsidian yet", self.items("search", "shopping", vaults=link)[0]["subtitle"])

    def test_row_to_action_round_trip(self):
        it = self.find(self.items("search", "zurich"), "Zürich Trip")
        self.assertEqual(self.action(it["arg"], **it["variables"]),
                         "open obsidian://open?path=" + enc(self.P("Projects", "Zürich Trip.md")))
        m = it["mods"]["alt"]
        self.assertEqual(self.action(m["arg"], **m["variables"]), "reveal " + self.P("Projects", "Zürich Trip.md"))
        m = it["mods"]["cmd+alt"]
        self.assertEqual(self.action(m["arg"], **m["variables"]), "Copied " + m["arg"])
        self.assertEqual(read_pasteboard(), m["arg"])
        m = it["mods"]["fn"]
        self.assertEqual(self.action(m["arg"], **m["variables"]), "default-app " + self.P("Projects", "Zürich Trip.md"))

    def test_messages(self):
        self.assertEqual(self.action("", ob_action="nope"), "Unknown action: nope")
        self.assertEqual(self.action("", ob_action="open", ob_vault="/nonexistent"), "Couldn’t find the vault")
        self.assertEqual(self.action("", ob_action="open-url", ob_text="not a url"), "Couldn’t open the link")
        self.assertEqual(self.action("", ob_action="reveal", ob_vault=self.personal, ob_rel="gone.md"),
                         "Couldn’t find it in Finder: it no longer exists")
        self.assertEqual(self.action("", ob_action="launch"), "open https://obsidian.md")


# ---------- the built workflow ----------

class WorkflowTests(unittest.TestCase):
    def test_info_plist(self):
        subprocess.run(["python3" if shutil.which("python3") else "/usr/bin/python3", os.path.join(ROOT, "tools", "build.py"), "--check"], check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            info = plistlib.load(f)
        self.assertEqual(info["bundleid"], "io.github.x-o-r-r-o.obsidian")
        cfg = {c["variable"]: c for c in info["userconfigurationconfig"]}
        filters = [o for o in info["objects"] if o["type"] == "alfred.workflow.input.scriptfilter"]
        self.assertEqual(len(filters), 6)
        for o in filters:
            kw = o["config"]["keyword"]
            var = kw[5:-1]
            self.assertTrue(kw.startswith("{var:keyword_"), kw)
            self.assertGreaterEqual(len(cfg[var]["config"]["default"]), 3)
            mods = sorted(c["modifiers"] for c in info["connections"][o["uid"]])
            self.assertEqual(len(mods), 8)  # ↩ and seven modifiers
        self.assertIn("## Usage", info["readme"])
        for name in ("Search in Obsidian", "Append to Daily Note", "New Obsidian Note"):
            self.assertTrue(any(o["config"].get("name") == name for o in info["objects"]), name)
        icons = {i for i in os.listdir(os.path.join(SRC, "icons"))}
        with open(os.path.join(SRC, "obsidian.js"), encoding="utf-8") as f:
            js = f.read()
        import re
        for name in set(re.findall(r'icons/([a-z]+)\.png', js)) | set(re.findall(r'icon: "([a-z]+)"', js)) | set(re.findall(r', "([a-z]+)"\)(?:,|\]|$)', js)):
            if name in ("note", "heading", "content", "tag", "new", "template", "daily", "append", "media", "bookmark", "search",
                        "url", "folder", "vault", "random", "refresh", "info", "ok", "empty", "error", "canvas"):
                self.assertIn(name + ".png", icons)


if __name__ == "__main__":
    unittest.main()
