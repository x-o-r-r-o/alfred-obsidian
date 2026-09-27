#!/usr/bin/osascript -l JavaScript
// Obsidian for Alfred: search, create and append to notes in every Obsidian vault.
// Usage: osascript -l JavaScript obsidian.js <command> [query]
//   search | new | daily | media | bookmarks | vaults   Script Filters
//   action <arg>                                        run $ob_action (open, append, create…)
//   index                                               (re)build the search index (background)
// No Obsidian plugin is needed: vaults, daily-note and template settings are read from Obsidian's
// own configuration files, and notes are read and written directly on disk.
ObjC.import("Foundation");
ObjC.import("AppKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
const FM = $.NSFileManager.defaultManager;
const HOME = $.NSHomeDirectory().js;
const BUNDLE = "io.github.x-o-r-r-o.obsidian";
const PID = $.NSProcessInfo.processInfo.processIdentifier;

const NOTE_EXT = new Set(["md", "canvas", "base"]);
const MAX_ROWS = 50;
const REFRESH_AFTER = 10; // seconds: an older index is refreshed in the background while you search
const INDEX_STALE = 1800; // seconds: lock backstop (the owner's PID is checked first)
const MAX_FILES = 200000; // per vault
const MAX_CONTENT = 200000; // characters of a note kept for content search
const INDEX_VERSION = 4;

// ---------- configuration ----------

function flag(name, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  return fallback;
}
function choice(name, allowed, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}
const PANES = ["current", "tab", "split", "window"];
const FORMATS = ["bullet", "task", "time", "plain", "custom"];
function config() {
  return {
    pane: choice("open_in", PANES, "current"),
    linkFormat: choice("link_format", ["vault", "wiki", "markdown"], "vault"),
    content: flag("search_content", true),
    excluded: splitList(env("excluded_folders", "")),
    format: choice("append_format", FORMATS, "bullet"),
    custom: String(env("append_custom", "")) || "- {{time}} {{text}}",
    heading: String(env("daily_heading", "")).trim(),
    openAfterAppend: flag("open_after_append", false),
    defaultVault: String(env("default_vault", "")).trim(),
    newFolder: String(env("new_note_folder", "")).trim(),
    newTemplate: String(env("new_note_template", "")).trim(),
  };
}
function splitList(s) {
  return String(s || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

// ---------- files ----------

function mkdirs(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}
function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", "") || `${$.NSTemporaryDirectory().js}${BUNDLE}`);
}
function readFile(path) {
  let s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  if (s.isNil()) {
    // not UTF-8: read it as Windows-1252 rather than skipping the note
    const d = $.NSData.dataWithContentsOfFile(path);
    if (d.isNil()) return null;
    s = $.NSString.alloc.initWithDataEncoding(d, $.NSWindowsCP1252StringEncoding);
    if (s.isNil()) return null;
  }
  return s.js;
}
function writeFile(path, text, atomic = true) {
  return $(text).writeToFileAtomicallyEncodingError(path, atomic, $.NSUTF8StringEncoding, $());
}
function readJSON(path) {
  const s = readFile(path);
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}
function exists(path) {
  return FM.fileExistsAtPath(path);
}
function isDir(path) {
  const d = Ref();
  return FM.fileExistsAtPathIsDirectory(path, d) && !!d[0];
}
function mtime(path) {
  const a = FM.attributesOfItemAtPathError(path, $());
  if (a.isNil()) return 0;
  const d = a.objectForKey($.NSFileModificationDate);
  return d.isNil() ? 0 : d.timeIntervalSince1970;
}
function removeFile(path) {
  FM.removeItemAtPathError(path, $());
}
function now() {
  return Date.now() / 1000;
}
// An absolute path as written (no symlink resolution, so it matches Obsidian's own paths):
// "~" expanded, "//", "." and ".." collapsed, no trailing slash
function expandPath(p) {
  p = String(p || "").trim();
  if (p === "~" || p.startsWith("~/")) p = HOME + p.slice(1);
  if (!p.startsWith("/")) return "";
  const out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}
function tilde(p) {
  return p === HOME || p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}
function basename(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
function dirname(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function extOf(name) {
  const m = /\.([^./]+)$/.exec(name);
  return m && m.index > 0 ? m[1].toLowerCase() : "";
}
function stripExt(name) {
  const e = extOf(name);
  return e ? name.slice(0, -(e.length + 1)) : name;
}

// ---------- processes and locks ----------

ObjC.bindFunction("kill", ["int", ["int", "int"]]);
ObjC.bindFunction("setsid", ["int", []]);

// Run a program with argv (never through a shell with interpolated data).
function runTask(path, args, extraEnv = null, cwd = null) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  if (cwd) task.currentDirectoryURL = $.NSURL.fileURLWithPath(cwd);
  if (extraEnv) {
    const e = $.NSMutableDictionary.dictionaryWithDictionary(ENV);
    for (const k of Object.keys(extraEnv)) e.setObjectForKey(extraEnv[k], k);
    task.environment = e;
  }
  const outP = $.NSPipe.pipe;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = outP;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError($())) return { status: -1, stdout: "" };
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const s = $.NSString.alloc.initWithDataEncoding(out, $.NSUTF8StringEncoding);
  return { status: task.terminationStatus, stdout: s.isNil() ? "" : s.js };
}

// Start `obsidian.js index` detached: `set -m` gives it its own process group, so it survives
// Alfred ending the Script Filter while you type.
function spawnIndexer() {
  if (env("OB_TEST_NO_SPAWN", "") === "1") return 0;
  const r = runTask("/bin/bash", ["-c", 'set -m; nohup /usr/bin/osascript -l JavaScript ./obsidian.js index </dev/null >/dev/null 2>&1 & echo $!']);
  const pid = parseInt(r.stdout.trim(), 10);
  return pid > 0 ? pid : 0;
}
function pidAlive(pid) {
  if (!(pid > 0) || $.kill(pid, 0) !== 0) return false;
  const r = runTask("/bin/ps", ["-o", "command=", "-p", String(pid)]);
  return r.status === -1 || /obsidian\.js/.test(r.stdout); // PIDs are reused
}
function lockPath(name) {
  return `${cacheDir()}/${name}.lock`;
}
function lockStale(dir, staleSec) {
  const age = now() - mtime(dir);
  if (age > staleSec) return true;
  const pid = parseInt(readFile(`${dir}/pid`) || "", 10);
  if (isNaN(pid)) return age > 5; // just created; the PID is written next
  return !pidAlive(pid);
}
function tryLock(name, staleSec) {
  const dir = lockPath(name);
  const take = () => {
    if (!FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $(), $())) return false;
    writeFile(`${dir}/pid`, String(PID));
    return true;
  };
  if (take()) return dir;
  if (exists(dir) && lockStale(dir, staleSec)) {
    removeFile(dir);
    if (take()) return dir;
  }
  return null;
}
function lockHeld(name, staleSec) {
  const dir = lockPath(name);
  return exists(dir) && !lockStale(dir, staleSec);
}

// ---------- text ----------

function fold(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
// Control characters and line breaks become spaces; bidi overrides are dropped.
function oneLine(s) {
  return String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
function shorten(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}
function quoted(s, max = 60) {
  return `“${shorten(oneLine(s).trim(), max)}”`;
}
function plural(n, one, many) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
// FNV-1a: a short, stable file-name-safe key for a vault path
function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
// Rows need a uid for Alfred to keep the selected row while the Script Filter reruns.
function stableUids(items) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return items;
}

// ---------- dates (moment.js format tokens, English names as in Obsidian's default locale) ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function today() {
  const t = env("OB_TEST_NOW", "");
  if (t) {
    const d = new Date(t);
    if (!isNaN(d)) return d;
  }
  return new Date();
}
function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
function ordinal(n) {
  const b = n % 10, h = n % 100;
  return n + (h >= 11 && h <= 13 ? "th" : b === 1 ? "st" : b === 2 ? "nd" : b === 3 ? "rd" : "th");
}
function dayOfYear(d) {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86400000) + 1;
}
// moment's week-of-year: dow = first day of week, doy = dow + 7 - (day that must be in week 1)
function firstWeekOffset(year, dow, doy) {
  const fwd = 7 + dow - doy;
  const fwdlw = (7 + new Date(Date.UTC(year, 0, fwd)).getUTCDay() - dow) % 7;
  return -fwdlw + fwd - 1;
}
function weeksInYear(year, dow, doy) {
  const days = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  return (days - firstWeekOffset(year, dow, doy) + firstWeekOffset(year + 1, dow, doy)) / 7;
}
function weekOfYear(d, dow, doy) {
  const y = d.getFullYear();
  const week = Math.floor((dayOfYear(d) - firstWeekOffset(y, dow, doy) - 1) / 7) + 1;
  if (week < 1) return { week: week + weeksInYear(y - 1, dow, doy), year: y - 1 };
  if (week > weeksInYear(y, dow, doy)) return { week: week - weeksInYear(y, dow, doy), year: y + 1 };
  return { week, year: y };
}
const TOKEN_RE = /\[([^\]]*)\]|YYYYYY|YYYY|YY|Qo|Q|MMMM|MMM|Mo|MM|M|DDDD|DDDo|DDD|Do|DD|D|dddd|ddd|do|dd|d|E|e|GGGG|GG|gggg|gg|Wo|WW|W|wo|ww|w|HH|H|hh|h|kk|k|mm|m|ss|s|SSS|SS|S|A|a|X|x|ZZ|Z/g;
function formatDate(d, fmt) {
  fmt = fmt || "YYYY-MM-DD";
  const iso = () => weekOfYear(d, 1, 4);
  const loc = () => weekOfYear(d, 0, 6);
  const tz = (sep) => {
    const o = -d.getTimezoneOffset();
    return (o >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(o) / 60)) + sep + pad(Math.abs(o) % 60);
  };
  const h12 = d.getHours() % 12 || 12;
  return fmt.replace(TOKEN_RE, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case "YYYYYY": return pad(d.getFullYear(), 6);
      case "YYYY": return pad(d.getFullYear(), 4);
      case "YY": return pad(d.getFullYear() % 100);
      case "Q": return String(Math.floor(d.getMonth() / 3) + 1);
      case "Qo": return ordinal(Math.floor(d.getMonth() / 3) + 1);
      case "MMMM": return MONTHS[d.getMonth()];
      case "MMM": return MONTHS[d.getMonth()].slice(0, 3);
      case "Mo": return ordinal(d.getMonth() + 1);
      case "MM": return pad(d.getMonth() + 1);
      case "M": return String(d.getMonth() + 1);
      case "DDDD": return pad(dayOfYear(d), 3);
      case "DDDo": return ordinal(dayOfYear(d));
      case "DDD": return String(dayOfYear(d));
      case "Do": return ordinal(d.getDate());
      case "DD": return pad(d.getDate());
      case "D": return String(d.getDate());
      case "dddd": return DAYS[d.getDay()];
      case "ddd": return DAYS[d.getDay()].slice(0, 3);
      case "dd": return DAYS[d.getDay()].slice(0, 2);
      case "do": return ordinal(d.getDay());
      case "d": return String(d.getDay());
      case "E": return String(d.getDay() || 7);
      case "e": return String(d.getDay());
      case "GGGG": return pad(iso().year, 4);
      case "GG": return pad(iso().year % 100);
      case "gggg": return pad(loc().year, 4);
      case "gg": return pad(loc().year % 100);
      case "WW": return pad(iso().week);
      case "W": return String(iso().week);
      case "Wo": return ordinal(iso().week);
      case "ww": return pad(loc().week);
      case "w": return String(loc().week);
      case "wo": return ordinal(loc().week);
      case "HH": return pad(d.getHours());
      case "H": return String(d.getHours());
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "kk": return pad(d.getHours() || 24);
      case "k": return String(d.getHours() || 24);
      case "mm": return pad(d.getMinutes());
      case "m": return String(d.getMinutes());
      case "ss": return pad(d.getSeconds());
      case "s": return String(d.getSeconds());
      case "SSS": return pad(d.getMilliseconds(), 3);
      case "SS": return pad(Math.floor(d.getMilliseconds() / 10));
      case "S": return String(Math.floor(d.getMilliseconds() / 100));
      case "A": return d.getHours() < 12 ? "AM" : "PM";
      case "a": return d.getHours() < 12 ? "am" : "pm";
      case "X": return String(Math.floor(d.getTime() / 1000));
      case "x": return String(d.getTime());
      case "ZZ": return tz("");
      case "Z": return tz(":");
    }
    return t;
  });
}
function addDays(d, n) {
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + n);
  return r;
}
function shiftDate(d, n, unit) {
  const r = new Date(d.getTime());
  if (unit === "d") r.setDate(r.getDate() + n);
  else if (unit === "w") r.setDate(r.getDate() + 7 * n);
  else if (unit === "M" || unit === "m") r.setMonth(r.getMonth() + n);
  else if (unit === "y") r.setFullYear(r.getFullYear() + n);
  return r;
}
function relativeTime(t) {
  const s = now() - t;
  if (s < -120) return shortDate(t);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return shortDate(t);
}
function shortDate(t) {
  const d = new Date(t * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${d.getFullYear() === new Date().getFullYear() ? "" : " " + d.getFullYear()}`;
}

// ---------- vaults ----------

function appSupport() {
  return env("OB_TEST_APPSUPPORT", "") || `${HOME}/Library/Application Support/obsidian`;
}

// Vaults Obsidian knows, open ones first, then the most recently opened.
function knownVaults() {
  const j = readJSON(`${appSupport()}/obsidian.json`);
  const out = [];
  if (j && j.vaults && typeof j.vaults === "object") {
    for (const id of Object.keys(j.vaults)) {
      const e = j.vaults[id];
      if (!e || typeof e.path !== "string") continue;
      const path = expandPath(e.path);
      if (path) out.push({ id, path, ts: Number(e.ts) || 0, open: !!e.open });
    }
  }
  out.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || b.ts - a.ts);
  return out;
}

let VAULTS = null;
// { list: [vault], missing: [configured names or paths that don't exist] }
function vaults() {
  if (VAULTS) return VAULTS;
  const known = knownVaults();
  const wanted = splitList(env("vaults", ""));
  const missing = [];
  let list = [];
  if (!wanted.length) list = known.filter((v) => isDir(v.path));
  else {
    for (const w of wanted) {
      let v = null;
      if (w.startsWith("/") || w.startsWith("~")) {
        const p = expandPath(w);
        v = known.find((k) => k.path === p) || (p ? { id: null, path: p, ts: 0, open: false } : null);
      } else {
        v = known.find((k) => fold(basename(k.path)) === fold(w));
      }
      if (v && isDir(v.path)) {
        if (!list.some((x) => x.path === v.path)) list.push(v);
      } else missing.push(w);
    }
  }
  const names = Object.create(null);
  for (const v of list) {
    v.name = basename(v.path) || v.path;
    v.key = hashKey(v.path);
    names[v.name] = (names[v.name] || 0) + 1;
  }
  // the obsidian:// "vault" parameter takes the name, or the ID when two vaults share a name
  for (const v of list) v.uriVault = names[v.name] > 1 && v.id ? v.id : v.name;
  VAULTS = { list, missing };
  return VAULTS;
}

function readJSONSafe(path, fallback) {
  const j = readJSON(path);
  return j === null || typeof j !== "object" ? fallback : j;
}

// Obsidian's settings for a vault (all optional; defaults match Obsidian's)
function vconf(v) {
  if (v.conf) return v.conf;
  const dir = `${v.path}/.obsidian`;
  const app = readJSONSafe(`${dir}/app.json`, {});
  let core = readJSONSafe(`${dir}/core-plugins.json`, null);
  if (core && !Array.isArray(core)) core = Object.keys(core).filter((k) => core[k] === true); // pre-1.4 format
  const community = readJSONSafe(`${dir}/community-plugins.json`, []);
  const hasPlugin = (id) => Array.isArray(community) && community.includes(id);
  const coreOn = (id) => !core || core.includes(id);

  let daily = readJSONSafe(`${dir}/daily-notes.json`, {});
  if (hasPlugin("periodic-notes")) {
    const pn = readJSONSafe(`${dir}/plugins/periodic-notes/data.json`, {});
    if (pn.daily && pn.daily.enabled) daily = pn.daily;
  }
  const templateDirs = [];
  const tpl = readJSONSafe(`${dir}/templates.json`, {});
  if (typeof tpl.folder === "string" && tpl.folder.trim()) templateDirs.push(cleanRel(tpl.folder));
  if (hasPlugin("templater-obsidian")) {
    const t = readJSONSafe(`${dir}/plugins/templater-obsidian/data.json`, {});
    if (typeof t.templates_folder === "string" && t.templates_folder.trim()) templateDirs.push(cleanRel(t.templates_folder));
  }
  const ws = readJSONSafe(`${dir}/workspace.json`, {});
  const str = (x, d) => (typeof x === "string" ? x : d);
  v.conf = {
    markdownLinks: app.useMarkdownLinks === true,
    linkStyle: str(app.newLinkFormat, "shortest"),
    newLocation: str(app.newFileLocation, "root"),
    newFolder: cleanRel(str(app.newFileFolderPath, "")),
    ignore: Array.isArray(app.userIgnoreFilters) ? app.userIgnoreFilters.filter((x) => typeof x === "string" && x) : [],
    daily: {
      folder: cleanRel(str(daily.folder, "")),
      format: str(daily.format, "").trim() || "YYYY-MM-DD",
      template: cleanRel(str(daily.template, "")),
    },
    templateDirs: [...new Set(templateDirs.filter(Boolean))],
    templateDate: str(tpl.dateFormat, "").trim() || "YYYY-MM-DD",
    templateTime: str(tpl.timeFormat, "").trim() || "HH:mm",
    advancedUri: hasPlugin("obsidian-advanced-uri"),
    recent: Array.isArray(ws.lastOpenFiles) ? ws.lastOpenFiles.filter((x) => typeof x === "string") : [],
    bookmarksOn: coreOn("bookmarks"),
  };
  return v.conf;
}

// A vault-relative path from a setting: no leading/trailing slashes, no "." or ".." parts
function cleanRel(p) {
  return String(p || "").split("/").map((x) => x.trim()).filter((x) => x && x !== "." && x !== "..").join("/");
}

// Obsidian's "Excluded files" (plain path prefixes or /regex/) plus the workflow's own list
function excluder(v, cfg) {
  const prefixes = [], regexes = [];
  for (const f of vconf(v).ignore.concat(cfg.excluded)) {
    if (f.length > 2 && f.startsWith("/") && f.endsWith("/")) {
      try {
        regexes.push(new RegExp(f.slice(1, -1)));
      } catch (e) {}
    } else {
      const p = fold(f.replace(/^\/+/, ""));
      if (p) prefixes.push(p);
    }
  }
  if (!prefixes.length && !regexes.length) return () => false;
  return (rel) => {
    const f = fold(rel);
    for (const p of prefixes) if (f.startsWith(p)) return true;
    for (const r of regexes) if (r.test(rel)) return true;
    return false;
  };
}

function primaryVault(list, cfg) {
  if (cfg.defaultVault) {
    const w = fold(cfg.defaultVault);
    const p = expandPath(cfg.defaultVault);
    const v = list.find((x) => fold(x.name) === w || x.path === p);
    if (v) return v;
  }
  return list[0] || null;
}

// "@work" picks a vault by the start of its name; returns [vault or null, remaining words]
function pickVault(words, list) {
  const rest = [];
  let chosen = null;
  for (const w of words) {
    if (!chosen && w.length > 1 && w.startsWith("@")) {
      const n = fold(w.slice(1));
      const v = list.find((x) => fold(x.name) === n) || list.find((x) => fold(x.name).startsWith(n));
      if (v) {
        chosen = v;
        continue;
      }
    }
    rest.push(w);
  }
  return [chosen, rest];
}

// ---------- scanning (getattrlistbulk: a whole directory in a few system calls) ----------

let BULK = null;
function bulkAvailable() {
  if (BULK === null) {
    try {
      ObjC.bindFunction("open", ["int", ["char *", "int"]]);
      ObjC.bindFunction("close", ["int", ["int"]]);
      ObjC.bindFunction("getattrlistbulk", ["int", ["int", "void *", "void *", "unsigned long", "unsigned long long"]]);
      BULK = env("OB_TEST_NO_BULK", "") !== "1";
    } catch (e) {
      BULK = false;
    }
  }
  return BULK;
}
const A_RETURNED = 0x80000000, A_ERROR = 0x20000000, A_NAME = 0x1, A_TYPE = 0x8, A_CRTIME = 0x200, A_MODTIME = 0x400, A_FLAGS = 0x40000, F_DATALENGTH = 0x200;
const SF_DATALESS = 0x40000000;
const VREG = 1, VDIR = 2;
function u32bytes(v) {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}
let ATTRLIST = null;
function attrList() {
  if (!ATTRLIST) {
    const common = A_RETURNED | A_ERROR | A_NAME | A_TYPE | A_CRTIME | A_MODTIME | A_FLAGS;
    const bytes = [5, 0, 0, 0, ...u32bytes(common), ...u32bytes(0), ...u32bytes(0), ...u32bytes(F_DATALENGTH), ...u32bytes(0)];
    ATTRLIST = $(String.fromCharCode(...bytes)).dataUsingEncoding($.NSISOLatin1StringEncoding).mutableCopy;
  }
  return ATTRLIST;
}
function decodeName(raw) {
  try {
    return decodeURIComponent(escape(raw));
  } catch (e) {
    return null;
  }
}
function bulkRead(dir) {
  const fd = $.open(dir, 0x100000 /* O_RDONLY | O_DIRECTORY */);
  if (fd < 0) return null;
  const size = 256 * 1024;
  const buf = $.NSMutableData.dataWithLength(size);
  const al = attrList();
  const out = [];
  try {
    for (;;) {
      const n = $.getattrlistbulk(fd, al.mutableBytes, buf.mutableBytes, size, 8 /* FSOPT_PACK_INVAL_ATTRS */);
      if (n < 0) return out.length ? out : null;
      if (n === 0) break;
      const s = $.NSString.alloc.initWithDataEncoding(buf, $.NSISOLatin1StringEncoding).js;
      const u32 = (o) => (s.charCodeAt(o) | (s.charCodeAt(o + 1) << 8) | (s.charCodeAt(o + 2) << 16)) + s.charCodeAt(o + 3) * 16777216;
      const i32 = (o) => u32(o) | 0;
      const time = (o) => u32(o) + i32(o + 4) * 4294967296 + u32(o + 8) / 1e9;
      let p = 0;
      for (let i = 0; i < n; i++) {
        const len = u32(p);
        if (!len) break;
        let o = p + 4;
        const retFile = u32(o + 12);
        o += 20;
        const err = u32(o);
        o += 4;
        const nameStart = o + i32(o), nameLen = u32(o + 4);
        o += 8;
        const name = decodeName(s.substr(nameStart, Math.max(0, nameLen - 1)));
        if (!err && name !== null && name !== "." && name !== "..") {
          const type = u32(o);
          const created = time(o + 4);
          const modified = time(o + 20);
          const flags = u32(o + 36);
          const fsize = retFile & F_DATALENGTH ? u32(o + 40) + u32(o + 44) * 4294967296 : 0;
          out.push({ name, type, created, modified, size: fsize, dataless: (flags & SF_DATALESS) !== 0 });
        }
        p += len;
      }
    }
  } finally {
    $.close(fd);
  }
  return out;
}
function fmRead(dir) {
  const keys = $([$.NSURLCreationDateKey, $.NSURLContentModificationDateKey, $.NSURLIsDirectoryKey, $.NSURLIsSymbolicLinkKey, $.NSURLFileSizeKey]);
  const urls = FM.contentsOfDirectoryAtURLIncludingPropertiesForKeysOptionsError($.NSURL.fileURLWithPath(dir), keys, 0, $());
  if (urls.isNil()) return null;
  const out = [];
  const t = (d) => (d && !d.isNil() ? d.timeIntervalSince1970 : 0);
  for (let i = 0; i < urls.count; i++) {
    const u = urls.objectAtIndex(i);
    const v = u.resourceValuesForKeysError(keys, $());
    if (v.isNil()) continue;
    const link = v.objectForKey($.NSURLIsSymbolicLinkKey), dir2 = v.objectForKey($.NSURLIsDirectoryKey), sz = v.objectForKey($.NSURLFileSizeKey);
    const isLink = !link.isNil() && link.boolValue;
    out.push({
      name: u.lastPathComponent.js,
      type: isLink ? 5 : !dir2.isNil() && dir2.boolValue ? VDIR : VREG,
      created: t(v.objectForKey($.NSURLCreationDateKey)),
      modified: t(v.objectForKey($.NSURLContentModificationDateKey)),
      size: sz.isNil() ? 0 : Number(sz.js),
    });
  }
  return out;
}
function readDir(dir) {
  if (bulkAvailable()) {
    const r = bulkRead(dir);
    if (r) return r;
  }
  return fmRead(dir);
}

// Every file of a vault, like Obsidian sees it: hidden files and folders (".obsidian", ".trash",
// ".git") are skipped, and symbolic links aren't followed (no loops).
function walkVault(root) {
  const notes = [], media = [];
  const queue = [""];
  let count = 0, truncated = false;
  for (let qi = 0; qi < queue.length; qi++) {
    const rel = queue[qi];
    const raw = readDir(rel ? `${root}/${rel}` : root);
    if (!raw) {
      if (!rel) return null; // the vault itself can't be read
      continue;
    }
    for (const r of raw) {
      if (r.name.startsWith(".") || r.name === "Icon\r") continue;
      if (++count > MAX_FILES) {
        truncated = true;
        break;
      }
      const p = rel ? `${rel}/${r.name}` : r.name;
      if (r.type === VDIR) queue.push(p);
      else if (r.type === VREG) {
        const e = { p, m: Math.floor(r.modified), s: r.size };
        if (r.dataless) e.d = 1; // in iCloud only: reading it would download it
        (NOTE_EXT.has(extOf(r.name)) ? notes : media).push(e);
      }
    }
    if (truncated) break;
  }
  return { notes, media, truncated };
}

// ---------- parsing notes ----------

function unquote(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.trim();
}
// The values of a frontmatter key: `key: a`, `key: [a, b]`, `key: a, b` or a block list
function yamlValues(lines, names, splitSpaces) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(lines[i]);
    if (!m || !names.includes(m[1].toLowerCase())) continue;
    const v = m[2].replace(/[ \t]+#.*$/, "").trim();
    if (v === "" || v === "|" || v === ">") {
      for (let j = i + 1; j < lines.length; j++) {
        const b = /^[ \t]*-[ \t]+(.*)$/.exec(lines[j]);
        if (b) out.push(unquote(b[1]));
        else if (!/^[ \t]*$/.test(lines[j])) break;
      }
    } else if (v.startsWith("[")) {
      out.push(...v.replace(/^\[|\]$/g, "").split(",").map(unquote));
    } else {
      const parts = v.split(",");
      for (const p of parts) out.push(...(splitSpaces ? unquote(p).split(/\s+/) : [unquote(p)]));
    }
  }
  return out.filter((x) => x && x !== "null" && x !== "~");
}

const TAG_RE = /(?:^|[\s,;(])#([^\s#!"$%&'()*+,.:;<=>?@^`{|}~\[\]\\]+)/gu;
function cleanInline(s) {
  return s
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|==|~~|`)/g, "")
    .trim();
}

function parseNote(text) {
  let body = text;
  const aliases = [], tags = [];
  if (/^---[ \t]*\r?\n/.test(text)) {
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text) || /^---[ \t]*\r?\n()(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
    if (m) {
      const lines = m[1].split(/\r?\n/);
      aliases.push(...yamlValues(lines, ["aliases", "alias"], false));
      tags.push(...yamlValues(lines, ["tags", "tag"], true).map((t) => t.replace(/^#/, "")));
      body = text.slice(m[0].length);
    }
  }
  const headings = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h) {
      const t = cleanInline(h[2]);
      if (t && headings.length < 60) headings.push([h[1].length, t]);
      continue;
    }
    if (line.includes("#")) {
      const l = line.replace(/`[^`]*`/g, " ");
      TAG_RE.lastIndex = 0;
      let t;
      while ((t = TAG_RE.exec(l)) && tags.length < 80) if (/[^\d\/]/.test(t[1])) tags.push(t[1].replace(/\/+$/, ""));
    }
  }
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
  const words = (body.replace(cjk, " ").match(/[^\s]+/g) || []).filter((w) => /[\p{L}\p{N}]/u.test(w)).length + (body.match(cjk) || []).length;
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  return { aliases: uniq(aliases).slice(0, 30), tags: uniq(tags), headings, words };
}

// ---------- the index ----------
// index-<key>.json: { v, root, built, notes: [{p, m, s, w, a, t, h, x, d}], media: [{p, m, s, d}] }
// (path, mtime, size, words, aliases, tags, headings, x = not read yet, d = in iCloud only)
// content-<key>.txt: one line per note: "<key>\t<path>\t<folded text>", searched with grep
// stamp-<key>: touched after every refresh (its mtime tells when the index was last checked)

function indexPath(v) {
  return `${cacheDir()}/index-${v.key}.json`;
}
function contentPath(v) {
  return `${cacheDir()}/content-${v.key}.txt`;
}
function stampPath(v) {
  return `${cacheDir()}/stamp-${v.key}`;
}
function loadIndex(v) {
  const j = readJSON(indexPath(v));
  return j && j.v === INDEX_VERSION && j.root === v.path && Array.isArray(j.notes) ? j : null;
}
function touch(path) {
  writeFile(path, String(now()));
}

function contentLine(v, rel, text) {
  if (/[\t\n\r]/.test(rel)) return null;
  const body = fold(text.length > MAX_CONTENT ? text.slice(0, MAX_CONTENT) : text).replace(/\s+/g, " ");
  return `${v.key}\t${rel}\t${body}`;
}

function buildIndex(v) {
  const prev = loadIndex(v);
  const scan = walkVault(v.path);
  if (!scan) return false;
  const old = new Map();
  if (prev) for (const n of prev.notes) old.set(n.p, n);
  const changed = [];
  const notes = scan.notes.map((f) => {
    const o = old.get(f.p);
    if (o && !o.x && o.m === f.m && o.s === f.s && !o.d === !f.d) return o;
    changed.push(f);
    return Object.assign({ w: 0, a: [], t: [], h: [], x: 1 }, f);
  });
  const removed = prev ? prev.notes.length + changed.length - notes.length : 0;
  const mediaChanged = !prev || JSON.stringify(prev.media) !== JSON.stringify(scan.media);
  if (prev && !changed.length && !removed && mediaChanged === false && !!prev.truncated === scan.truncated) {
    touch(stampPath(v));
    return true;
  }
  const write = (list) => {
    writeFile(indexPath(v), JSON.stringify({ v: INDEX_VERSION, root: v.path, built: now(), truncated: scan.truncated, notes: list, media: scan.media }));
  };
  // A first index of a big vault: publish the file names at once, the contents follow
  if (!prev && changed.length > 300) write(notes);

  const lines = new Map();
  if (prev) {
    const s = readFile(contentPath(v)) || "";
    let i = 0;
    while (i < s.length) {
      let j = s.indexOf("\n", i);
      if (j < 0) j = s.length;
      const a = s.indexOf("\t", i), b = a < 0 ? -1 : s.indexOf("\t", a + 1);
      if (b > 0 && b < j) lines.set(s.slice(a + 1, b), s.slice(i, j));
      i = j + 1;
    }
  }
  const byPath = new Map(notes.map((n) => [n.p, n]));
  for (const f of changed) {
    const n = byPath.get(f.p);
    delete n.x;
    lines.delete(f.p);
    if (extOf(f.p) !== "md" || f.d) continue;
    const text = readFile(`${v.path}/${f.p}`);
    if (text === null) continue;
    const info = parseNote(text);
    n.w = info.words;
    n.a = info.aliases;
    n.t = info.tags;
    n.h = info.headings;
    const line = contentLine(v, f.p, text);
    if (line) lines.set(f.p, line);
  }
  const out = [];
  for (const n of notes) {
    const l = lines.get(n.p);
    if (l) out.push(l);
  }
  writeFile(contentPath(v), out.join("\n") + "\n");
  write(notes);
  touch(stampPath(v));
  return true;
}

// Background job: refresh every vault's index
function runIndexer() {
  $.setsid();
  const lock = tryLock("index", INDEX_STALE);
  if (!lock) return;
  try {
    for (const v of vaults().list) {
      try {
        buildIndex(v);
      } catch (e) {
        writeFile(`${cacheDir()}/index-error.txt`, `${v.path}: ${e && e.message ? e.message : e}`);
      }
    }
  } finally {
    const owner = parseInt(readFile(`${lock}/pid`) || "", 10);
    if (owner === PID || !pidAlive(owner)) removeFile(lock);
  }
}

// The indexes for these vaults; starts a background refresh when one is missing or old.
// Returns { data: Map(vault -> index), building: bool }
function indexes(list) {
  const data = new Map();
  let stale = false, missing = false;
  for (const v of list) {
    const idx = loadIndex(v);
    if (idx) data.set(v, idx);
    else missing = true;
    if (!idx || now() - mtime(stampPath(v)) > REFRESH_AFTER) stale = true;
  }
  let building = false;
  if (stale || missing) {
    building = lockHeld("index", INDEX_STALE);
    if (!building) building = spawnIndexer() > 0;
  }
  return { data, building: building && (missing || list.some((v) => data.has(v) && data.get(v).notes.some((n) => n.x))) };
}

// Prepared, searchable notes of one vault (folded fields computed once per run)
function prepare(v, idx, cfg) {
  const skip = excluder(v, cfg);
  const names = Object.create(null);
  for (const n of idx.notes) {
    const b = fold(stripExt(basename(n.p)));
    names[b] = (names[b] || 0) + 1;
  }
  const notes = [];
  for (const n of idx.notes) {
    if (skip(n.p)) continue;
    n.vault = v;
    n.title = stripExt(basename(n.p));
    n.folder = dirname(n.p);
    n.ext = extOf(n.p);
    n.unique = names[fold(n.title)] === 1;
    notes.push(n);
  }
  return notes;
}

// Is a note's base name unique in its vault (so the shortest link is just the name)?
function isUnique(v, rel) {
  if (!v.nameCounts) {
    v.nameCounts = Object.create(null);
    const idx = loadIndex(v);
    if (idx) for (const n of idx.notes) {
      const b = fold(stripExt(basename(n.p)));
      v.nameCounts[b] = (v.nameCounts[b] || 0) + 1;
    }
  }
  return (v.nameCounts[fold(stripExt(basename(rel)))] || 0) <= 1;
}

// ---------- links and URIs ----------

function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function obsidianURI(v, rel, sub) {
  const file = rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  return `obsidian://open?vault=${uriEncode(v.uriVault)}&file=${uriEncode(file + (sub || ""))}`;
}
// The link Obsidian itself would insert: wikilink or Markdown, shortest path when unique
function noteLink(v, rel, unique, cfg, sub, display) {
  const md = cfg.linkFormat === "markdown" || (cfg.linkFormat === "vault" && vconf(v).markdownLinks);
  const ext = extOf(rel);
  const bare = ext === "md" ? rel.slice(0, -3) : rel;
  const short = vconf(v).linkStyle === "shortest" && unique ? basename(bare) : bare;
  sub = sub || "";
  if (md) {
    const target = (vconf(v).linkStyle === "shortest" && unique ? basename(rel) : rel).split("/").map((x) => encodeURI(x).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
    const label = display || (sub ? `${stripExt(basename(rel))} > ${sub.replace(/^#\^?/, "")}` : stripExt(basename(rel)));
    return `[${label.replace(/([\[\]])/g, "\\$1")}](${target}${sub ? "#" + encodeURI(sub.replace(/^#/, "")).replace(/%5E/g, "^") : ""})`;
  }
  return `[[${short}${sub}${display ? "|" + display : ""}]]`;
}
function embedLink(v, rel, unique, cfg) {
  return "!" + noteLink(v, rel, unique, cfg);
}

// ---------- rows ----------

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title: oneLine(title), subtitle: oneLine(subtitle || ""), valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}
function mod(arg, subtitle, variables, valid = true) {
  return { arg, subtitle: oneLine(subtitle), valid, variables: variables || {} };
}
const OTHER_PANE = { current: "tab", tab: "current", split: "current", window: "current" };
const PANE_WORDS = { current: "the current tab", tab: "a new tab", split: "a split pane", window: "a new window" };

function multiVault() {
  return vaults().list.length > 1;
}

function noteSubtitle(n, extra) {
  const bits = [];
  if (extra) bits.push(extra);
  if (multiVault()) bits.push(n.vault.name);
  bits.push(n.folder ? n.folder : "/");
  bits.push(relativeTime(n.m));
  if (n.w) bits.push(plural(n.w, "word", "words"));
  return bits.join(" · ");
}

// A note (or heading) row: ↩ open, ⌘ paste link, ⌥ reveal, ⌃ other pane, ⇧ append clipboard,
// fn default app, ⌘⌥ copy URI, ⌘⇧ copy a Markdown link to the URI.
function noteItem(n, cfg, opts = {}) {
  const v = n.vault;
  const abs = `${v.path}/${n.p}`;
  const sub = opts.heading ? "#" + opts.heading : "";
  const link = noteLink(v, n.p, n.unique, cfg, sub);
  const uri = obsidianURI(v, n.p, sub);
  const vars = { ob_vault: v.path, ob_rel: n.p, ob_heading: opts.heading || "" };
  const act = (a, extra) => Object.assign({ ob_action: a }, vars, extra || {});
  const label = opts.heading ? opts.heading : n.title;
  const it = {
    type: "file",
    title: oneLine(label),
    subtitle: oneLine(opts.subtitle || noteSubtitle(n)),
    arg: abs,
    icon: { path: `icons/${opts.icon || (n.ext === "canvas" ? "canvas" : "note")}.png` },
    quicklookurl: abs,
    text: { copy: link, largetype: label },
    variables: act("open", { ob_pane: cfg.pane }),
    mods: {
      cmd: mod(link, `Paste ${link} into the frontmost app`, act("paste")),
      alt: mod(abs, "Reveal in Finder", act("reveal")),
      ctrl: mod(abs, `Open in ${PANE_WORDS[OTHER_PANE[cfg.pane]]}`, act("open", { ob_pane: OTHER_PANE[cfg.pane] })),
      shift: mod(abs, "Append the clipboard to this note", act("append-clipboard"), n.ext === "md"),
      fn: mod(abs, "Open in the default app for this file type", act("default-app")),
      "cmd+alt": mod(uri, "Copy the Obsidian URI", act("copy", { ob_text: uri })),
      "cmd+shift": mod(abs, "Copy a Markdown link to the Obsidian URI", act("copy", { ob_text: `[${label.replace(/([\[\]])/g, "\\$1")}](${uri})` })),
    },
  };
  if (opts.append !== undefined) appendMods(it, abs, opts.append, cfg, act, label);
  return it;
}

const FORMAT_WORDS = { bullet: "as a bullet", task: "as a task", time: "with the time", plain: "as a paragraph", custom: "with your format" };
// Rows that append text: ↩ the configured format, ⌥ task, ⌃ time, fn paragraph, ⇧ and open
function appendMods(it, target, text, cfg, act, label) {
  const has = text.trim() !== "";
  const alt = (f) => (f === cfg.format ? "bullet" : f);
  const shown = quoted(text, 40);
  it.icon = { path: "icons/append.png" };
  it.valid = has;
  it.variables = act("append", { ob_text: text, ob_format: cfg.format });
  it.subtitle = has ? `Append ${shown} ${FORMAT_WORDS[cfg.format]} · ${it.subtitle}` : `Type the text to append after “>” · ${it.subtitle}`;
  const m = (f, words) => mod(target, `Append ${shown} ${words}`, act("append", { ob_text: text, ob_format: f }), has);
  it.mods.alt = m(alt("task"), FORMAT_WORDS[alt("task")]);
  it.mods.ctrl = m(alt("time"), FORMAT_WORDS[alt("time")]);
  it.mods.fn = m(alt("plain"), FORMAT_WORDS[alt("plain")]);
  it.mods.shift = mod(target, `Append ${shown} and open ${oneLine(label)}`, act("append", { ob_text: text, ob_format: cfg.format, ob_open: "1" }), has);
}

function noVaultsItems() {
  const { missing } = vaults();
  if (missing.length) {
    return [info(`Couldn’t find the vault ${quoted(missing[0])}`, "Check the vault names or folders in the Workflow’s Configuration", "error", { valid: true, arg: "", variables: { ob_action: "configure" } })];
  }
  const app = exists(`${appSupport()}/obsidian.json`);
  return [
    info("No Obsidian vaults found", app ? "Open or create a vault in Obsidian first" : "Install Obsidian and open a vault, or add vault folders in the Workflow’s Configuration", "error", {
      valid: true, arg: "", variables: { ob_action: "launch" },
    }),
  ];
}

// ---------- search ----------

// 4: starts the text, 3: starts a word, 2: anywhere, 0: no match; +1 when it ends a word
const ALNUM = /[\p{L}\p{N}]/u;
function wordScore(hay, w) {
  let i = hay.indexOf(w);
  if (i < 0) return 0;
  // prefer an occurrence at the start of a word
  if (i > 0 && ALNUM.test(hay[i - 1])) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u");
    const m = re.exec(hay);
    if (m) i = m.index + m[1].length;
  }
  const base = i === 0 ? 4 : ALNUM.test(hay[i - 1]) ? 2 : 3;
  const after = hay[i + w.length];
  return base + (after === undefined || !ALNUM.test(after) ? 1 : 0);
}
// letters in order (title only)
function fuzzy(hay, w) {
  let j = 0;
  for (let k = 0; k < hay.length && j < w.length; k++) if (hay[k] === w[j]) j++;
  return j === w.length;
}

// #tag matches the tag and its nested tags (#tag/sub); the tag still being typed matches by prefix
function parseSearch(q) {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  const typing = !/\s$/.test(q);
  const tags = [], folders = [], words = [];
  tokens.forEach((t, i) => {
    if (t === "#") return; // a tag about to be typed: suggestions only
    if (t.length > 1 && t.startsWith("#")) tags.push({ tag: fold(t.slice(1)).replace(/\/+$/, ""), prefix: typing && i === tokens.length - 1 });
    else if (t.length > 1 && t.startsWith("/")) folders.push(fold(t.slice(1)).replace(/\/+$/, ""));
    else words.push(t);
  });
  return { tags, folders, words };
}

function passesFilters(n, tags, folders) {
  for (const { tag, prefix } of tags) {
    if (!n.ft) n.ft = n.t.map(fold);
    if (!n.ft.some((x) => x === tag || x.startsWith(prefix ? tag : tag + "/"))) return false;
  }
  for (const f of folders) {
    const fp = fold(n.folder);
    if (!(fp === f || fp.startsWith(f) || fp.includes("/" + f))) return false;
  }
  return true;
}

// Notes whose text contains every word: a grep per word (longest first) on the folded content
// files, then awk checks the words against the text part of each line only.
const GREP_SH = [
  "set -f",
  'filt() { if [ $# -eq 0 ]; then cat; else w=$1; shift; LC_ALL=C /usr/bin/grep -F -e "$w" | filt "$@"; fi; }',
  'w=$1; shift',
  'LC_ALL=C /usr/bin/grep -h -F -e "$w" -- $OB_FILES | filt "$@" | LC_ALL=C /usr/bin/awk -F "\t" \'BEGIN { n = split(ENVIRON["OB_WORDS"], w, "\\n") } { s = substr($0, length($1) + length($2) + 3); for (i = 1; i <= n; i++) if (index(s, w[i]) == 0) next; print $1 "\t" $2; if (++c >= 400) exit }\'',
].join("\n");
function contentSearch(list, words) {
  // the files are named content-<hex>.txt and passed by name from inside the cache folder
  const files = list.map((v) => basename(contentPath(v))).filter((f) => exists(`${cacheDir()}/${f}`));
  if (!files.length || !words.length) return [];
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length);
  const r = runTask("/bin/sh", ["-c", GREP_SH, "sh", ...sorted], { OB_WORDS: sorted.join("\n"), OB_FILES: files.join(" ") }, cacheDir());
  if (r.status === -1) return [];
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("\t");
    return [l.slice(0, i), l.slice(i + 1)];
  });
}

// A short excerpt around the first word, read from the note itself
function snippet(abs, words) {
  const text = readFile(abs);
  if (text === null) return "";
  const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
  for (const line of body.split(/\r?\n/)) {
    const f = fold(line);
    const i = f.indexOf(words[0]);
    if (i < 0) continue;
    // folding can change lengths (e.g. "ß"), so the excerpt position is approximate
    const start = Math.max(0, i - 30);
    const s = line.replace(/\s+/g, " ").slice(start, start + 110).trim();
    return (start > 0 ? "…" : "") + s;
  }
  return "";
}

function recentNotes(prepared, list, limit) {
  const out = [], seen = new Set();
  for (const v of list) {
    const byPath = new Map(prepared.filter((n) => n.vault === v).map((n) => [n.p, n]));
    for (const rel of vconf(v).recent) {
      const n = byPath.get(rel);
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
      if (out.length >= Math.ceil(limit / 2)) break;
    }
  }
  const rest = prepared.filter((n) => !seen.has(n)).sort((a, b) => b.m - a.m);
  return out.concat(rest).slice(0, limit);
}

function searchItems(rawQuery) {
  const cfg = config();
  const all = vaults().list;
  if (!all.length) return { items: noVaultsItems() };
  // "note > text" appends the text to the chosen note
  let query = rawQuery, append;
  const gt = rawQuery.indexOf(">");
  if (gt >= 0) {
    query = rawQuery.slice(0, gt);
    append = rawQuery.slice(gt + 1).replace(/^[ \t]+/, "").replace(/\s+$/, "");
  }
  const trailingSpace = /\s$/.test(query);
  let { tags, folders, words } = parseSearch(query);
  const [only, rest] = pickVault(words, all);
  words = rest.map(fold);
  const list = only ? [only] : all;
  const { data, building } = indexes(list);
  const prepared = [];
  for (const v of list) if (data.has(v)) prepared.push(...prepare(v, data.get(v), cfg));

  const items = [];
  if (!data.size) {
    return {
      items: [info(`Indexing ${list.length === 1 ? quoted(list[0].name) : "your vaults"}…`, "The first search of a vault takes a moment", "refresh")],
      rerun: 0.5,
    };
  }

  const filtered = prepared.filter((n) => passesFilters(n, tags, folders));
  const rowOpts = (n, extra) => Object.assign(append !== undefined && n.ext === "md" ? { append } : {}, extra || {});
  const inAppend = append !== undefined;
  const pool = inAppend ? filtered.filter((n) => n.ext === "md") : filtered;

  // tag suggestions while a tag is being typed
  const lastTok = query.trim().split(/\s+/).pop() || "";
  if (!inAppend && !trailingSpace && lastTok.startsWith("#") && !words.length) {
    const counts = new Map(); // folded tag -> [shown as, count]
    const partial = fold(lastTok.slice(1));
    for (const n of prepared) {
      for (const f of new Set(n.t.map(fold))) {
        if (!f.startsWith(partial)) continue;
        const e = counts.get(f);
        if (e) e[1]++;
        else counts.set(f, [n.t.find((t) => fold(t) === f), 1]);
      }
    }
    const head = query.trim().slice(0, query.trim().length - lastTok.length);
    [...counts.values()].sort((a, b) => b[1] - a[1] || (fold(a[0]) < fold(b[0]) ? -1 : 1)).slice(0, partial ? 6 : 12).forEach(([t, c]) => {
      items.push(info(`#${t}`, `${plural(c, "note", "notes")} · ⇥ to filter by this tag`, "tag", { autocomplete: `${head}#${t} `, valid: false }));
    });
  }

  if (!words.length) {
    const base = tags.length || folders.length ? pool.slice().sort((a, b) => b.m - a.m) : recentNotes(pool, list, MAX_ROWS);
    for (const n of base.slice(0, MAX_ROWS)) items.push(noteItem(n, cfg, rowOpts(n)));
    if (!base.length && !items.length) {
      items.push(info(prepared.length ? "No matching notes" : "No notes yet", tags.length || folders.length ? "No note has that tag or folder" : "Create one via the new-note keyword", "empty"));
    }
  } else {
    const q = words.join(" ");
    const scored = [], headingRows = [];
    for (const n of pool) {
      if (!n.fTitle) {
        n.fTitle = fold(n.title);
        n.fPath = fold(n.folder);
        n.fAlias = n.a.map(fold);
      }
      let score = 0, ok = true, aliasHit = "";
      for (const w of words) {
        let s = wordScore(n.fTitle, w) * 3;
        for (let i = 0; i < n.fAlias.length; i++) {
          const a = wordScore(n.fAlias[i], w) * 2.5;
          if (a > s) {
            s = a;
            aliasHit = n.a[i];
          }
        }
        s = Math.max(s, wordScore(n.fPath, w));
        if (!s) {
          if (!n.ft) n.ft = n.t.map(fold);
          if (n.ft.some((t) => t.startsWith(w))) s = 1;
        }
        if (!s && w.length > 1 && fuzzy(n.fTitle, w)) s = 1;
        if (!s) {
          ok = false;
          break;
        }
        score += s;
      }
      if (ok) {
        if (n.fTitle === q) score += 30;
        else if (n.fTitle.startsWith(q)) score += 10;
        if (n.fAlias.includes(q)) score += 20;
        scored.push({ n, score, alias: aliasHit });
      }
      // headings that contain every word
      if (n.h.length) {
        let hits = 0;
        for (const [lvl, text] of n.h) {
          const f = fold(text);
          let hs = 0;
          for (const w of words) {
            const s = wordScore(f, w);
            if (!s) {
              hs = 0;
              break;
            }
            hs += s * 2;
          }
          if (hs && !ok) {
            headingRows.push({ n, score: hs + (f === q ? 10 : 0), heading: text, level: lvl });
            if (++hits >= 3) break;
          }
        }
      }
    }
    const recency = (n) => n.m;
    scored.sort((a, b) => b.score - a.score || recency(b.n) - recency(a.n));
    headingRows.sort((a, b) => b.score - a.score || recency(b.n) - recency(a.n));
    const listed = new Set();
    const rows = [];
    for (const s of scored) {
      listed.add(s.n);
      const extra = s.alias && fold(s.alias) !== s.n.fTitle ? `Alias “${oneLine(s.alias)}”` : "";
      rows.push({ score: s.score, m: s.n.m, make: () => noteItem(s.n, cfg, rowOpts(s.n, extra ? { subtitle: noteSubtitle(s.n, extra) } : {})) });
    }
    for (const h of headingRows.slice(0, 30)) {
      listed.add(h.n);
      rows.push({
        score: h.score - 0.5,
        m: h.n.m,
        make: () => noteItem(h.n, cfg, rowOpts(h.n, { heading: h.heading, icon: "heading", subtitle: noteSubtitle(h.n, `H${h.level} in ${oneLine(h.n.title)}`) })),
      });
    }
    rows.sort((a, b) => b.score - a.score || b.m - a.m);
    for (const r of rows.slice(0, MAX_ROWS)) items.push(r.make());

    // note contents, when titles, aliases and headings leave room
    if (cfg.content && items.length < MAX_ROWS && q.replace(/\s/g, "").length >= 2) {
      const byKey = new Map();
      for (const n of pool) byKey.set(`${n.vault.key}\t${n.p}`, n);
      const hits = [];
      for (const [key, rel] of contentSearch(list, words)) {
        const n = byKey.get(`${key}\t${rel}`);
        if (n && !listed.has(n)) {
          listed.add(n);
          hits.push(n);
        }
      }
      hits.sort((a, b) => b.m - a.m);
      hits.slice(0, MAX_ROWS - items.length).forEach((n, i) => {
        const snip = i < 20 ? snippet(`${n.vault.path}/${n.p}`, words) : "";
        items.push(noteItem(n, cfg, rowOpts(n, { icon: inAppend ? undefined : "content", subtitle: snip ? `${multiVault() ? n.vault.name + " · " : ""}${n.folder ? n.folder + " · " : ""}${snip}` : noteSubtitle(n, "Contains the words") })));
      });
    }
    if (!items.length) {
      if (inAppend) items.push(info("No matching notes", "Type part of a note’s name before “>”", "empty"));
      else items.push(newNoteSuggestion(query, only || primaryVault(all, cfg), cfg));
    }
  }
  if (building) {
    items.push(info("Updating the index…", "New and changed notes appear in a moment", "refresh"));
    return { items, rerun: 1 };
  }
  return { items };
}

// "No results" offers to create the note, like Obsidian's quick switcher
function newNoteSuggestion(query, v, cfg) {
  const words = query.trim().split(/\s+/).filter((t) => !t.startsWith("/") && !(t.startsWith("@") && t !== "@"));
  const p = v ? parseNew(words.join(" "), [v], cfg) : null;
  if (!p || !p.title) return info("No matching notes", "Try fewer words, or search for a tag with #", "empty");
  const rel = uniqueRel(v, p.folder, p.title);
  const act = { ob_action: "create", ob_vault: v.path, ob_rel: rel, ob_template: defaultTemplate(v, cfg), ob_content: "", ob_tags: p.tags.join("\n"), ob_open: "1" };
  return {
    title: oneLine(`Create “${stripExt(basename(rel))}”`),
    subtitle: oneLine(`No matching notes · ↩ Create ${rel}${multiVault() ? " in " + v.name : ""}`),
    arg: rel, valid: true, icon: { path: "icons/new.png" }, variables: act,
    mods: { cmd: mod("", "Create the note first", {}, false) },
  };
}

// ---------- new notes ----------

// Characters Obsidian doesn't allow in file names, or that break links
function sanitizeTitle(s) {
  return String(s).replace(/[\\:*?"<>|#^\[\]\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
}
function newNoteFolder(v, cfg) {
  if (cfg.newFolder) return cleanRel(cfg.newFolder);
  const c = vconf(v);
  return c.newLocation === "folder" ? c.newFolder : "";
}
function uniqueRel(v, folder, title) {
  const base = (folder ? folder + "/" : "") + title;
  let rel = base + ".md";
  for (let i = 1; exists(`${v.path}/${rel}`) && i < 1000; i++) rel = `${base} ${i}.md`;
  return rel;
}
function templates(v) {
  const out = [];
  for (const dir of vconf(v).templateDirs) {
    const abs = `${v.path}/${dir}`;
    if (!isDir(abs)) continue;
    const e = FM.enumeratorAtPath(abs);
    let p;
    while (!(p = e.nextObject).isNil() && out.length < 200) {
      const rel = p.js;
      if (rel.split("/").some((x) => x.startsWith("."))) continue;
      if (extOf(rel) === "md") out.push(`${dir}/${rel}`);
    }
  }
  return [...new Set(out)].sort((a, b) => fold(a).localeCompare(fold(b)));
}
function findTemplate(v, name) {
  if (!name) return "";
  const n = fold(stripExt(name));
  const all = templates(v);
  return all.find((t) => fold(stripExt(t)) === n) || all.find((t) => fold(stripExt(basename(t))) === n) || "";
}
function defaultTemplate(v, cfg) {
  return findTemplate(v, cfg.newTemplate);
}

// Title (with optional folders), #tags and @vault from the query; text after ">" is the content
function parseNew(q, list, cfg) {
  let head = q, content = "";
  const gt = q.indexOf(">");
  if (gt >= 0) {
    head = q.slice(0, gt);
    content = q.slice(gt + 1).replace(/^[ \t]+/, "").replace(/\s+$/, "");
  }
  const toks = head.trim().split(/[ \t]+/).filter(Boolean);
  const tags = [];
  const kept = [];
  for (const t of toks) {
    if (t.length > 1 && t.startsWith("#") && /[^\d#\/]/.test(t.slice(1))) tags.push(t.slice(1).replace(/\/+$/, ""));
    else kept.push(t);
  }
  const [vault, words] = pickVault(kept, list);
  const v = vault || primaryVault(list, cfg);
  let path = words.join(" ");
  // "Projects/Idea" places the note in a folder of the vault
  const parts = path.split("/").map((x) => sanitizeTitle(x)).filter((x) => x);
  let title = parts.pop() || "";
  let folder = parts.join("/");
  if (!title && content) {
    // from a selection: the first line becomes the title
    const first = content.split(/\r?\n/).map((l) => l.replace(/^[#>\-*+\s]+/, "").trim()).find(Boolean) || "";
    title = sanitizeTitle(shorten(first, 60).replace(/…$/, ""));
  }
  const explicitFolder = parts.length > 0;
  if (!explicitFolder && v) folder = newNoteFolder(v, cfg);
  return { v, title, folder, tags: [...new Set(tags)], content, explicitFolder };
}

function newItems(q) {
  const cfg = config();
  const list = vaults().list;
  if (!list.length) return { items: noVaultsItems() };
  const p = parseNew(q, list, cfg);
  const v = p.v;
  if (!p.title) {
    return {
      items: [
        info("Create a note", "Type a title · “Folder/Title” for a folder · #tag to tag it · “> text” for the content", "new"),
      ].concat(list.length > 1 ? [info("Choose a vault with @name", `New notes go to ${v.name} · also: ${list.filter((x) => x !== v).map((x) => "@" + x.name).join(", ")}`, "vault")] : []),
    };
  }
  const items = [];
  const exact = `${v.path}/${p.folder ? p.folder + "/" : ""}${p.title}.md`;
  const rel = uniqueRel(v, p.folder, p.title);
  const where = `${rel}${list.length > 1 ? " in " + v.name : ""}`;
  const tagText = p.tags.length ? " · " + p.tags.map((t) => "#" + t).join(" ") : "";
  const contentText = p.content ? ` · ${quoted(p.content, 30)}` : "";
  if (exists(exact)) {
    const r = exact.slice(v.path.length + 1);
    const n = { vault: v, p: r, title: p.title, folder: p.folder, ext: "md", m: mtime(exact), w: 0, unique: isUnique(v, r) };
    items.push(noteItem(n, cfg, { subtitle: `Already exists · ${noteSubtitle(n)}` }));
  }
  const base = { ob_action: "create", ob_vault: v.path, ob_rel: rel, ob_content: p.content, ob_tags: p.tags.join("\n"), ob_open: "1" };
  const row = (title, tpl, icon) => ({
    title: oneLine(title),
    subtitle: oneLine(`${where}${tagText}${contentText}`),
    arg: rel,
    valid: true,
    icon: { path: `icons/${icon}.png` },
    text: { copy: `${v.path}/${rel}`, largetype: stripExt(basename(rel)) },
    variables: Object.assign({}, base, { ob_template: tpl }),
    mods: {
      cmd: mod("", "Create the note first, then paste its link", {}, false),
      alt: mod(rel, "Create with the clipboard as the content", Object.assign({}, base, { ob_template: tpl, ob_content: "", ob_clipboard: "1" })),
      shift: mod(rel, "Create without opening it", Object.assign({}, base, { ob_template: tpl, ob_open: "0" })),
      ctrl: mod(rel, `Create and open in ${PANE_WORDS[OTHER_PANE[cfg.pane]]}`, Object.assign({}, base, { ob_template: tpl, ob_pane: OTHER_PANE[cfg.pane] })),
    },
  });
  const name = stripExt(basename(rel));
  const def = defaultTemplate(v, cfg);
  items.push(row(`Create “${name}”${def ? " from " + stripExt(basename(def)) : ""}`, def, "new"));
  const tpls = templates(v).filter((t) => t !== def);
  if (def) items.push(row(`Create “${name}” as a blank note`, "", "new"));
  for (const t of tpls.slice(0, 40)) items.push(row(`Create “${name}” from ${stripExt(basename(t))}`, t, "template"));
  return { items };
}

// ---------- templates ----------

function clipboardText() {
  const s = pasteboard().stringForType($.NSPasteboardTypeString);
  return s.isNil() ? "" : s.js;
}

// Obsidian's template variables: {{title}}, {{date}}, {{time}}, {{date:FORMAT}}, {{time:FORMAT}},
// {{date+1d:FORMAT}} (d, w, M, y), {{yesterday}}, {{tomorrow}}; plus {{clipboard}} and {{content}}.
function fillTemplate(text, vars) {
  let usedContent = false;
  const out = text.replace(/\{\{\s*([A-Za-z]+)\s*([+-]\s*\d+\s*[dwMmy])?\s*(?::([^}]*))?\}\}/g, (all, name, off, fmt) => {
    const key = name.toLowerCase();
    let d = vars.date;
    if (off) {
      const m = /([+-])\s*(\d+)\s*([dwMmy])/.exec(off);
      d = shiftDate(d, (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10), m[3]);
    }
    switch (key) {
      case "title": return vars.title;
      case "date": return formatDate(d, fmt ? fmt.trim() : vars.dateFormat);
      case "time": return formatDate(off ? d : new Date(), fmt ? fmt.trim() : vars.timeFormat);
      case "yesterday": return formatDate(addDays(vars.date, -1), fmt ? fmt.trim() : vars.dateFormat);
      case "tomorrow": return formatDate(addDays(vars.date, 1), fmt ? fmt.trim() : vars.dateFormat);
      case "clipboard": return clipboardText();
      case "content":
        usedContent = true;
        return vars.content || "";
    }
    return all;
  });
  return { text: out, usedContent };
}

// Add tags to the frontmatter (creating it when needed)
function addTags(text, tags) {
  if (!tags.length) return text;
  const list = tags.map((t) => `  - ${/^[\w\/-]+$/u.test(t) ? t : JSON.stringify(t)}`).join("\n");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return `---\ntags:\n${list}\n---\n${text}`;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^tags[ \t]*:/i.test(l));
  if (i < 0) lines.push(`tags:\n${list}`);
  else {
    const v = lines[i].replace(/^tags[ \t]*:/i, "").trim();
    if (v === "") lines.splice(i + 1, 0, list);
    else if (v.startsWith("[")) {
      const inner = v.replace(/^\[|\]$/g, "").trim();
      lines[i] = `tags: [${inner ? inner + ", " : ""}${tags.map((t) => JSON.stringify(t)).join(", ")}]`;
    } else {
      // a single value or a comma list: rewrite as a block list
      const old = v.split(/[,\s]+/).map(unquote).filter(Boolean);
      lines[i] = `tags:\n${[...new Set(old.concat(tags))].map((t) => `  - ${/^[\w\/-]+$/u.test(t) ? t : JSON.stringify(t)}`).join("\n")}`;
    }
  }
  return `---\n${lines.join("\n")}\n---\n${text.slice(m[0].length)}`;
}

// ---------- daily notes ----------

function dailyRel(v, d) {
  const c = vconf(v).daily;
  const name = cleanRel(formatDate(d, c.format));
  return `${c.folder ? c.folder + "/" : ""}${name}.md`;
}
function templateText(v, rel) {
  if (!rel) return "";
  const r = extOf(rel) === "md" ? rel : rel + ".md";
  return readFile(`${v.path}/${r}`) || "";
}

// Create the note at rel from a template unless it exists; returns "" or an error message
function createNote(v, rel, opts) {
  const abs = `${v.path}/${rel}`;
  if (!inside(v.path, abs)) return "Couldn’t create the note: the path leaves the vault";
  if (exists(abs)) return "";
  const title = stripExt(basename(rel));
  const c = vconf(v);
  const tpl = opts.template ? templateText(v, cleanRel(opts.template)) : "";
  const filled = fillTemplate(tpl, {
    title, date: opts.date || today(), content: opts.content || "",
    dateFormat: opts.dateFormat || c.templateDate, timeFormat: c.templateTime,
  });
  let text = filled.text;
  if (opts.content && !filled.usedContent) text = text ? text.replace(/\s*$/, "\n\n") + opts.content : opts.content;
  text = addTags(text, opts.tags || []);
  if (text && !text.endsWith("\n")) text += "\n";
  mkdirs(dirname(abs));
  // NSDataWritingWithoutOverwriting: fails instead of replacing a file created meanwhile
  if (!$(text).dataUsingEncoding($.NSUTF8StringEncoding).writeToFileOptionsError(abs, 2, $())) {
    return exists(abs) ? "" : `Couldn’t create ${quoted(rel)}`;
  }
  opts.created = true;
  return "";
}

function ensureDaily(v, d) {
  const rel = dailyRel(v, d);
  const c = vconf(v).daily;
  const opts = { template: c.template, date: d, dateFormat: c.format };
  const err = createNote(v, rel, opts);
  return { rel, err, created: !!opts.created };
}

const DATE_WORDS = { today: 0, yesterday: -1, tomorrow: 1 };
function parseDay(w) {
  const lw = w.toLowerCase();
  if (lw in DATE_WORDS) return addDays(today(), DATE_WORDS[lw]);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], 12);
    if (d.getMonth() === +m[2] - 1) return d;
  }
  return null;
}

function dailyItems(q) {
  const cfg = config();
  const list = vaults().list;
  if (!list.length) return { items: noVaultsItems() };
  const raw = q.replace(/^\s+/, "").replace(/\s+$/, "");
  const firstTok = raw.split(/[ \t]+/)[0] || "";
  const [chosen] = pickVault([firstTok], list);
  const v = chosen || primaryVault(list, cfg);
  const text = chosen ? raw.slice(firstTok.length).replace(/^[ \t]+/, "") : raw;
  const items = [];
  const t = today();
  const vaultNote = list.length > 1 ? ` · ${v.name}` : "";
  const openRow = (d, label) => {
    const rel = dailyRel(v, d);
    const abs = `${v.path}/${rel}`;
    const there = exists(abs);
    const act = { ob_action: "daily-open", ob_vault: v.path, ob_date: formatDate(d, "YYYY-MM-DD") };
    const link = noteLink(v, rel, true, cfg);
    return {
      title: oneLine(`${label}: ${stripExt(basename(rel))}`),
      subtitle: oneLine(`${there ? "Open" : "Create"} ${rel}${vaultNote}`),
      arg: abs, valid: true, icon: { path: "icons/daily.png" },
      quicklookurl: there ? abs : undefined,
      text: { copy: link, largetype: stripExt(basename(rel)) },
      variables: Object.assign({ ob_pane: cfg.pane }, act),
      mods: {
        cmd: mod(link, `Paste ${link} into the frontmost app`, {}),
        alt: mod(abs, there ? "Reveal in Finder" : "The note doesn’t exist yet", { ob_action: "reveal" }, there),
        ctrl: mod(abs, `Open in ${PANE_WORDS[OTHER_PANE[cfg.pane]]}`, Object.assign({}, act, { ob_pane: OTHER_PANE[cfg.pane] })),
      },
    };
  };
  const day = parseDay(text);
  if (!text || day) {
    if (day) items.push(openRow(day, text.toLowerCase() in DATE_WORDS ? text[0].toUpperCase() + text.slice(1).toLowerCase() : formatDate(day, "ddd D MMM YYYY")));
    else {
      items.push(openRow(t, "Today"));
      items.push(info("Type to append to today’s daily note", `${cfg.heading ? "Under “" + cfg.heading + "” · " : ""}${FORMAT_WORDS[cfg.format]}${list.length > 1 ? " · @name for another vault" : ""}`, "append"));
      items.push(openRow(addDays(t, -1), "Yesterday"));
      items.push(openRow(addDays(t, 1), "Tomorrow"));
    }
    if (!day) return { items };
  }
  // append rows
  const rel = dailyRel(v, t);
  const abs = `${v.path}/${rel}`;
  const target = { ob_action: "daily-append", ob_vault: v.path, ob_date: formatDate(t, "YYYY-MM-DD"), ob_heading: cfg.heading };
  const link = noteLink(v, rel, true, cfg);
  const it = {
    title: oneLine(`Append to ${stripExt(basename(rel))}`),
    subtitle: `${cfg.heading ? "Under “" + oneLine(cfg.heading) + "” · " : ""}${rel}${vaultNote}`,
    arg: abs, valid: true, icon: { path: "icons/append.png" },
    text: { copy: text, largetype: text },
    mods: { cmd: mod(link, `Paste ${link} into the frontmost app`, {}) },
  };
  appendMods(it, abs, text, cfg, (a, extra) => Object.assign({}, target, extra || {}, { ob_action: "daily-append" }), stripExt(basename(rel)));
  it.subtitle = oneLine(it.subtitle);
  if (day) items.push(it);
  else items.unshift(it);
  return { items };
}

// ---------- media ----------

const MEDIA_KIND = Object.create(null);
for (const [k, list] of Object.entries({
  image: "png jpg jpeg gif webp svg bmp avif heic tif tiff",
  audio: "mp3 m4a wav ogg flac webm 3gp",
  video: "mp4 mov mkv ogv",
  pdf: "pdf",
})) for (const e of list.split(" ")) MEDIA_KIND[e] = k;

function formatSize(n) {
  if (n < 1000) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n, u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v.toFixed(u === 0 ? 0 : 1).replace(/\.0$/, "")} ${units[u]}`;
}

function mediaItems(q) {
  const cfg = config();
  const all = vaults().list;
  if (!all.length) return { items: noVaultsItems() };
  const toks = q.trim().split(/\s+/).filter(Boolean);
  const exts = [], kinds = [], folders = [];
  const rest = [];
  for (const t of toks) {
    const lt = t.toLowerCase();
    if (lt.length > 1 && lt.startsWith(".")) exts.push(lt.slice(1));
    else if (lt.length > 1 && lt.startsWith("/")) folders.push(fold(lt.slice(1)).replace(/\/+$/, ""));
    else if (["image", "images", "audio", "video", "videos", "pdf", "pdfs"].includes(lt) && !rest.length) kinds.push(lt.replace(/s$/, ""));
    else rest.push(t);
  }
  const [only, words0] = pickVault(rest, all);
  const words = words0.map(fold);
  const list = only ? [only] : all;
  const { data, building } = indexes(list);
  if (!data.size) return { items: [info("Indexing your vaults…", "The first search takes a moment", "refresh")], rerun: 0.5 };
  const found = [];
  for (const v of list) {
    const idx = data.get(v);
    if (!idx) continue;
    const skip = excluder(v, cfg);
    const names = Object.create(null);
    for (const f of idx.media) {
      const b = fold(basename(f.p));
      names[b] = (names[b] || 0) + 1;
    }
    for (const f of idx.media) {
      if (skip(f.p)) continue;
      const e = extOf(f.p);
      if (exts.length && !exts.includes(e)) continue;
      if (kinds.length && !kinds.includes(MEDIA_KIND[e])) continue;
      const fp = fold(dirname(f.p));
      if (folders.some((x) => !(fp === x || fp.startsWith(x) || fp.includes("/" + x)))) continue;
      const name = fold(basename(f.p));
      let score = 0;
      let ok = true;
      for (const w of words) {
        const s = Math.max(wordScore(name, w) * 3, wordScore(fp, w));
        if (!s) {
          ok = false;
          break;
        }
        score += s;
      }
      if (ok) found.push({ v, f, score, unique: names[fold(basename(f.p))] === 1 });
    }
  }
  found.sort((a, b) => b.score - a.score || b.f.m - a.f.m);
  const items = found.slice(0, MAX_ROWS).map(({ v, f, unique }) => {
    const abs = `${v.path}/${f.p}`;
    const embed = embedLink(v, f.p, unique, cfg);
    const vars = { ob_vault: v.path, ob_rel: f.p };
    const act = (a, extra) => Object.assign({ ob_action: a }, vars, extra || {});
    const uri = obsidianURI(v, f.p);
    return {
      type: "file",
      title: oneLine(basename(f.p)),
      subtitle: oneLine([multiVault() ? v.name : "", dirname(f.p) || "/", formatSize(f.s), relativeTime(f.m)].filter(Boolean).join(" · ")),
      arg: abs,
      icon: { type: "fileicon", path: abs },
      quicklookurl: abs,
      text: { copy: embed, largetype: basename(f.p) },
      variables: act("open", { ob_pane: cfg.pane }),
      mods: {
        cmd: mod(embed, `Paste ${embed} into the frontmost app`, act("paste")),
        alt: mod(abs, "Reveal in Finder", act("reveal")),
        ctrl: mod(abs, "Copy the file to the clipboard", act("copy-file")),
        shift: mod(abs, `Open in ${PANE_WORDS[OTHER_PANE[cfg.pane]]}`, act("open", { ob_pane: OTHER_PANE[cfg.pane] })),
        fn: mod(abs, "Open in the default app for this file type", act("default-app")),
        "cmd+alt": mod(uri, "Copy the Obsidian URI", act("copy", { ob_text: uri })),
        "cmd+shift": mod(abs, "Copy a Markdown link to the Obsidian URI", act("copy", { ob_text: `[${basename(f.p).replace(/([\[\]])/g, "\\$1")}](${uri})` })),
      },
    };
  });
  if (!items.length) items.push(info(q.trim() ? "No matching attachments" : "No attachments in your vaults", q.trim() ? `Nothing matches ${quoted(q)}` : "Images, PDFs, audio and other files appear here", "empty"));
  if (found.length > MAX_ROWS) items.push(info(`Showing the best ${MAX_ROWS} of ${found.length.toLocaleString("en-US")}`, "Type to narrow down, or filter with .png, image, pdf, audio or video", "info"));
  if (building) return { items: items.concat([info("Updating the index…", "New files appear in a moment", "refresh")]), rerun: 1 };
  return { items };
}

// ---------- bookmarks ----------

function bookmarkList(v) {
  const dir = `${v.path}/.obsidian`;
  const out = [];
  const walk = (items, group) => {
    if (!Array.isArray(items)) return;
    for (const b of items) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "group") walk(b.items, group ? `${group} › ${b.title || ""}` : b.title || "");
      else out.push(Object.assign({ group }, b));
    }
  };
  const bm = readJSON(`${dir}/bookmarks.json`);
  if (bm && Array.isArray(bm.items)) walk(bm.items, "");
  else {
    const st = readJSON(`${dir}/starred.json`); // before Obsidian 1.2
    if (st && Array.isArray(st.items)) walk(st.items, "");
  }
  return out;
}

function bookmarkItems(q) {
  const cfg = config();
  const all = vaults().list;
  if (!all.length) return { items: noVaultsItems() };
  const [only, words0] = pickVault(q.trim().split(/\s+/).filter(Boolean), all);
  const words = words0.map(fold);
  const list = only ? [only] : all;
  const items = [];
  let total = 0;
  for (const v of list) {
    const marks = bookmarkList(v);
    total += marks.length;
    for (const b of marks) {
      const rel = typeof b.path === "string" ? b.path : "";
      const sub = typeof b.subpath === "string" ? b.subpath : "";
      let title = typeof b.title === "string" && b.title ? b.title : "";
      const where = [multiVault() ? v.name : "", b.group].filter(Boolean);
      let it;
      if (b.type === "file" && rel) {
        const abs = `${v.path}/${rel}`;
        const n = { vault: v, p: rel, title: stripExt(basename(rel)), folder: dirname(rel), ext: extOf(rel), m: mtime(abs), w: 0, unique: isUnique(v, rel), a: [], t: [], h: [] };
        const heading = sub.startsWith("#") && !sub.startsWith("#^") ? sub.slice(1) : "";
        it = noteItem(n, cfg, { heading: heading || undefined, icon: "bookmark", subtitle: [...where, sub ? `${rel} ${sub}` : rel].join(" · ") });
        if (sub.startsWith("#^")) {
          it.variables.ob_heading = sub.slice(1); // a block reference: ^id
          it.text.copy = noteLink(v, rel, n.unique, cfg, sub);
          it.mods.cmd = mod(it.text.copy, `Paste ${it.text.copy} into the frontmost app`, {});
        }
        if (title) it.title = oneLine(title);
        if (!exists(abs)) it.type = "file:skipcheck";
        title = title || n.title + (sub ? " " + sub : "");
      } else if (b.type === "folder" && rel) {
        const abs = `${v.path}/${rel}`;
        title = title || basename(rel);
        it = { type: "file:skipcheck", title: oneLine(title), subtitle: oneLine([...where, "Folder", rel].join(" · ")), arg: abs, icon: { path: "icons/folder.png" }, valid: isDir(abs),
          variables: { ob_action: "reveal" }, mods: { cmd: mod(rel, `Paste ${rel}`, {}), alt: mod(abs, "Reveal in Finder", { ob_action: "reveal" }) } };
      } else if (b.type === "search" && typeof b.query === "string") {
        title = title || b.query;
        it = { title: oneLine(title), subtitle: oneLine([...where, `Search: ${b.query}`].join(" · ")), arg: b.query, valid: true, icon: { path: "icons/search.png" },
          variables: { ob_action: "obsidian-search", ob_vault: v.path, ob_text: b.query }, mods: { cmd: mod(b.query, `Paste ${b.query}`, {}) } };
      } else if (b.type === "url" && typeof b.url === "string" && /^[a-z][a-z0-9+.-]*:/i.test(b.url) && !/^(javascript|data|vbscript):/i.test(b.url)) {
        title = title || b.url;
        it = { title: oneLine(title), subtitle: oneLine([...where, b.url].join(" · ")), arg: b.url, valid: true, icon: { path: "icons/url.png" }, quicklookurl: b.url,
          variables: { ob_action: "open-url", ob_text: b.url }, mods: { cmd: mod(b.url, `Paste ${b.url}`, {}), "cmd+alt": mod(b.url, "Copy the address", { ob_action: "copy", ob_text: b.url }) } };
      } else continue;
      const hay = fold(`${title} ${rel} ${b.group} ${b.query || ""} ${b.url || ""}`);
      if (words.every((w) => hay.includes(w))) items.push(it);
    }
  }
  if (!items.length) {
    items.push(total ? info("No matching bookmarks", `Nothing matches ${quoted(q)}`, "empty") : info("No bookmarks yet", "Bookmark notes, headings, searches and links in Obsidian’s Bookmarks pane", "empty"));
  }
  return { items: items.slice(0, 200) };
}

// ---------- vaults ----------

function vaultItems(q) {
  const cfg = config();
  const all = vaults().list;
  if (!all.length) return { items: noVaultsItems() };
  const words = fold(q).trim().split(/\s+/).filter(Boolean);
  const items = [];
  if (!words.length || "random note".includes(words.join(" "))) {
    items.push({
      title: "Random Note", subtitle: `Open a random note${all.length > 1 ? " from any vault" : ""} · ⌥ reveal it in Finder`, arg: "", valid: true,
      icon: { path: "icons/random.png" }, variables: { ob_action: "random", ob_pane: cfg.pane },
      mods: { cmd: mod("", "Only for a note", {}, false), alt: mod("", "Reveal a random note in Finder", { ob_action: "random", ob_reveal: "1" }) },
    });
  }
  for (const v of all) {
    if (!words.every((w) => fold(v.name).includes(w) || fold(v.path).includes(w))) continue;
    const idx = loadIndex(v);
    const bits = [tilde(v.path)];
    if (idx) bits.push(plural(idx.notes.length, "note", "notes"), `indexed ${relativeTime(Math.max(idx.built, mtime(stampPath(v))))}`);
    else bits.push("not indexed yet");
    if (v === primaryVault(all, cfg) && all.length > 1) bits.push("default");
    items.push({
      type: "file", title: oneLine(v.name), subtitle: oneLine(bits.join(" · ")), arg: v.path, icon: { path: "icons/vault.png" },
      text: { copy: v.path, largetype: v.name },
      variables: { ob_action: "open-vault", ob_vault: v.path },
      mods: {
        cmd: mod(v.path, `Paste ${tilde(v.path)}`, {}),
        alt: mod(v.path, "Reveal in Finder", { ob_action: "reveal" }),
        shift: mod(v.path, "Open a random note from this vault", { ob_action: "random", ob_vault: v.path, ob_pane: cfg.pane }),
        ctrl: mod(v.path, "Rebuild this vault’s search index", { ob_action: "reindex", ob_vault: v.path }),
        fn: mod(v.path, "Open today’s daily note in this vault", { ob_action: "daily-open", ob_vault: v.path, ob_date: formatDate(today(), "YYYY-MM-DD"), ob_pane: cfg.pane }),
      },
    });
  }
  if (items.length === 0) items.push(info("No matching vaults", `Nothing matches ${quoted(q)}`, "empty"));
  if (!words.length) items.push(info("Open Obsidian’s vault switcher", "Create, open or manage vaults in Obsidian", "vault", { valid: true, arg: "", variables: { ob_action: "choose-vault" } }));
  return { items };
}

// ---------- actions ----------

function pasteboard() {
  const name = env("OB_TEST_PASTEBOARD", "") || (env("OB_TEST_DRYRUN", "") === "1" ? `${BUNDLE}.dryrun` : "");
  return name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
}
function copyText(s) {
  const pb = pasteboard();
  pb.clearContents;
  return pb.setStringForType($(s), $.NSPasteboardTypeString);
}

// Is path inside root? (built from root + a relative path: no "." or ".." parts allowed)
function inside(root, path) {
  if (/(^|\/)\.\.?(\/|$)/.test(path.slice(root.length))) return false;
  return path.startsWith(root + "/");
}

function openURL(url) {
  if (env("OB_TEST_DRYRUN", "") === "1") return `open ${url}`;
  const u = $.NSURL.URLWithString(url);
  if (u.isNil()) return "Couldn’t open the link";
  const ws = $.NSWorkspace.sharedWorkspace;
  if (url.startsWith("obsidian:") && ws.URLForApplicationToOpenURL(u).isNil()) return "Couldn’t open Obsidian: it isn’t installed";
  return ws.openURL(u) ? "" : "Couldn’t open the link";
}

function openNote(v, rel, pane, sub) {
  let url;
  if (sub && vconf(v).advancedUri && !sub.startsWith("^")) {
    url = `obsidian://adv-uri?vault=${uriEncode(v.uriVault)}&filepath=${uriEncode(rel)}&heading=${uriEncode(sub)}${pane !== "current" ? "&openmode=" + pane : ""}`;
  } else {
    url = obsidianURI(v, rel, sub ? "#" + sub : "");
    if (pane && pane !== "current") url += `&paneType=${pane}`;
  }
  return openURL(url);
}

// Obsidian notices new files within a moment; open them only after it has
function settle() {
  if (env("OB_TEST_DRYRUN", "") !== "1") delay(0.4);
}

function vaultFor(path) {
  const all = vaults().list;
  return all.find((v) => v.path === path) || (path && isDir(path) ? { id: null, path, name: basename(path), key: hashKey(path), uriVault: basename(path) } : null);
}

function formatEntry(text, format, cfg) {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const time = formatDate(new Date(), "HH:mm");
  const indent = (first) => [first, ...lines.slice(1).map((l) => (l ? "  " + l : l))].join("\n");
  switch (format) {
    case "task": return indent(`- [ ] ${lines[0]}`);
    case "time": return indent(`- ${time} ${lines[0]}`);
    case "plain": return lines.join("\n");
    case "custom": {
      const t = cfg.custom.replace(/\{\{\s*text\s*\}\}/g, "\u0000");
      const filled = fillTemplate(t, { title: "", date: today(), content: "", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" }).text;
      return filled.includes("\u0000") ? filled.replace("\u0000", lines.join("\n")).replace(/\u0000/g, "") : `${filled}${lines.join("\n")}`;
    }
    default: return indent(`- ${lines[0]}`);
  }
}

// Append an entry at the end of the note, or at the end of a heading's section
function appendText(abs, entry, heading, format) {
  const old = readFile(abs);
  if (old === null) return `Couldn’t read ${quoted(basename(abs))}`;
  const nl = old.includes("\r\n") ? "\r\n" : "\n";
  const para = format === "plain";
  let out;
  if (heading) {
    const hm = /^(#{1,6})\s+(.*)$/.exec(heading.trim());
    const want = fold(hm ? hm[2] : heading.trim());
    const level = hm ? hm[1].length : 0;
    const lines = old.split(/\r?\n/);
    let at = -1, lvl = 0, fence = null;
    for (let i = 0; i < lines.length; i++) {
      const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (f) {
        fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0];
        continue;
      }
      if (fence) continue;
      const h = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]);
      if (!h) continue;
      if (at < 0) {
        if (fold(cleanInline(h[2])) === want && (!level || h[1].length === level)) {
          at = i;
          lvl = h[1].length;
        }
      } else if (h[1].length <= lvl) {
        // before the next heading of the same or a higher level, after the section's last text
        let end = i;
        while (end - 1 > at && /^\s*$/.test(lines[end - 1])) end--;
        const add = (para && end - 1 > at ? [""] : []).concat(entry.split("\n"));
        if (end === i) add.push(""); // keep the next heading apart
        lines.splice(end, 0, ...add);
        out = lines.join(nl);
        break;
      }
    }
    if (at >= 0 && out === undefined) {
      // the section runs to the end of the note
      let end = lines.length;
      while (end - 1 > at && /^\s*$/.test(lines[end - 1])) end--;
      const add = (para && end - 1 > at ? [""] : []).concat(entry.split("\n"));
      out = lines.slice(0, end).concat(add).join(nl) + nl;
    }
    if (out === undefined) {
      const line = hm ? heading.trim() : `## ${heading.trim()}`;
      const base = old.replace(/\s+$/, "");
      out = (base ? base + nl + nl : "") + line + nl + entry.split("\n").join(nl) + nl;
    }
    return writeFile(abs, out, false) ? "" : `Couldn’t write to ${quoted(basename(abs))}`;
  }
  // plain append keeps the file as it is and adds to its end
  let prefix = "";
  if (old.length && !old.endsWith("\n")) prefix = nl;
  if (para && old.trim() && !/\n\s*\n$/.test(old + (prefix ? "\n" : ""))) prefix += nl;
  const data = $(prefix + entry.split("\n").join(nl) + nl).dataUsingEncoding($.NSUTF8StringEncoding);
  const fh = $.NSFileHandle.fileHandleForWritingAtPath(abs);
  if (fh.isNil()) return `Couldn’t write to ${quoted(basename(abs))}`;
  try {
    fh.seekToEndOfFile;
    fh.writeData(data);
  } finally {
    fh.closeFile;
  }
  return "";
}

function reopenIndex() {
  spawnIndexer(); // notes changed: refresh the index right away
}

function doAction(arg) {
  const cfg = config();
  const action = env("ob_action", "open");
  let v = vaultFor(env("ob_vault", ""));
  const rel = env("ob_rel", "");
  const pane = choice("ob_pane", PANES, cfg.pane);
  const dry = env("OB_TEST_DRYRUN", "") === "1";
  const needVault = () => (v ? "" : "Couldn’t find the vault");

  switch (action) {
    case "open": {
      if (needVault()) return needVault();
      if (!inside(v.path, `${v.path}/${rel}`) || !exists(`${v.path}/${rel}`)) return `${quoted(basename(rel))} no longer exists`;
      return openNote(v, rel, pane, env("ob_heading", ""));
    }
    case "reveal": {
      const p = arg || (v ? `${v.path}/${rel}` : "");
      if (!p || !exists(p)) return "Couldn’t find it in Finder: it no longer exists";
      if (dry) return `reveal ${p}`;
      $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($([$.NSURL.fileURLWithPath(p)]));
      return "";
    }
    case "default-app": {
      if (!exists(arg)) return `${quoted(basename(arg))} no longer exists`;
      if (dry) return `default-app ${arg}`;
      return $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(arg)) ? "" : `Couldn’t open ${quoted(basename(arg))}`;
    }
    case "copy": {
      const t = env("ob_text", "");
      return copyText(t) ? `Copied ${shorten(oneLine(t), 120)}` : "Couldn’t copy to the clipboard";
    }
    case "paste": // reached only without Alfred's clipboard object (tests)
      return copyText(arg) ? `Copied ${shorten(oneLine(arg), 120)}` : "Couldn’t copy to the clipboard";
    case "copy-file": {
      if (!exists(arg)) return `${quoted(basename(arg))} no longer exists`;
      const pb = pasteboard();
      pb.clearContents;
      return pb.writeObjects($([$.NSURL.fileURLWithPath(arg)])) ? `Copied ${quoted(basename(arg))} to the clipboard` : "Couldn’t copy the file";
    }
    case "append":
    case "append-clipboard": {
      if (needVault()) return needVault();
      const abs = `${v.path}/${rel}`;
      if (!inside(v.path, abs) || !exists(abs)) return `${quoted(basename(rel))} no longer exists`;
      const text = action === "append" ? env("ob_text", "") : clipboardText();
      if (!text.trim()) return action === "append" ? "Nothing to append" : "The clipboard has no text to append";
      const format = action === "append" ? choice("ob_format", FORMATS, cfg.format) : "plain";
      const err = appendText(abs, formatEntry(text, format, cfg), env("ob_heading", "").replace(/^\^.*/, ""), format);
      if (err) return err;
      reopenIndex();
      if (env("ob_open", "") === "1" || (action === "append" && cfg.openAfterAppend)) return openNote(v, rel, pane) || "";
      return `Added to ${stripExt(basename(rel))}`;
    }
    case "daily-open":
    case "daily-append": {
      if (!v) v = primaryVault(vaults().list, cfg);
      if (needVault()) return needVault();
      const d = parseDay(env("ob_date", "")) || today();
      const { rel: drel, err, created } = ensureDaily(v, d);
      if (err) return err;
      if (action === "daily-open") {
        if (created) {
          reopenIndex();
          settle();
        }
        return openNote(v, drel, pane);
      }
      // from the Script Filter the text is in ob_text; from the Hotkey it is the argument
      const text = env("ob_text", null) !== null ? env("ob_text", "") : arg;
      if (!text.trim()) return "Nothing to append";
      const format = choice("ob_format", FORMATS, cfg.format);
      const heading = env("ob_heading", null) === null ? cfg.heading : env("ob_heading", "");
      const e2 = appendText(`${v.path}/${drel}`, formatEntry(text, format, cfg), heading, format);
      if (e2) return e2;
      reopenIndex();
      if (env("ob_open", "") === "1" || cfg.openAfterAppend) {
        settle();
        return openNote(v, drel, pane);
      }
      return `Added to ${stripExt(basename(drel))}`;
    }
    case "create": {
      if (needVault()) return needVault();
      const r = cleanRel(rel);
      if (!r || r !== rel || extOf(r) !== "md" || r.split("/").some((x) => x.startsWith("."))) return "Couldn’t create the note: invalid name";
      let content = env("ob_content", "");
      if (env("ob_clipboard", "") === "1") content = clipboardText();
      const tags = env("ob_tags", "").split("\n").filter(Boolean);
      let target = r;
      if (exists(`${v.path}/${target}`)) target = uniqueRel(v, dirname(r), stripExt(basename(r)));
      const err = createNote(v, target, { template: env("ob_template", ""), content, tags });
      if (err) return err;
      reopenIndex();
      if (env("ob_open", "1") === "0") return `Created ${stripExt(basename(target))}`;
      settle();
      return openNote(v, target, pane);
    }
    case "random": {
      const list = v ? [v] : vaults().list;
      const pool = [];
      for (const x of list) {
        const idx = loadIndex(x);
        if (idx) for (const n of prepare(x, idx, cfg)) if (n.ext === "md") pool.push(n);
      }
      if (!pool.length) {
        spawnIndexer();
        return "No notes found yet: the index is being built, try again in a moment";
      }
      const pickIndex = env("OB_TEST_RANDOM", "") !== "" ? Number(env("OB_TEST_RANDOM", "0")) % pool.length : Math.floor(Math.random() * pool.length);
      const n = pool[pickIndex];
      if (env("ob_reveal", "") === "1") {
        if (dry) return `reveal ${n.vault.path}/${n.p}`;
        $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($([$.NSURL.fileURLWithPath(`${n.vault.path}/${n.p}`)]));
        return "";
      }
      return openNote(n.vault, n.p, pane);
    }
    case "open-vault":
      if (needVault()) return needVault();
      return openURL(`obsidian://open?vault=${uriEncode(v.uriVault)}`);
    case "choose-vault":
      return openURL("obsidian://choose-vault");
    case "launch":
      return openURL("https://obsidian.md");
    case "obsidian-search":
      if (needVault()) return needVault();
      return openURL(`obsidian://search?vault=${uriEncode(v.uriVault)}&query=${uriEncode(env("ob_text", ""))}`);
    case "open-url": {
      const u = env("ob_text", "");
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u) || /^(javascript|data|vbscript):/i.test(u)) return "Couldn’t open the link";
      return openURL(u);
    }
    case "reindex": {
      if (needVault()) return needVault();
      for (const p of [indexPath(v), contentPath(v), stampPath(v)]) removeFile(p);
      spawnIndexer();
      return `Rebuilding the index of ${v.name}`;
    }
    case "configure":
      if (dry) return "configure";
      try {
        Application("com.runningwithcrayons.Alfred").revealWorkflow(env("alfred_workflow_bundleid", BUNDLE));
      } catch (e) {
        return "Open Alfred Preferences › Workflows › Obsidian › Configure Workflow";
      }
      return "";
    default:
      return `Unknown action: ${oneLine(action)}`;
  }
}

// Every modifier is connected to an action, so a row without its own entry for one would run
// its ↩ action; make such modifiers do nothing instead (the subtitle stays).
const ALL_MODS = ["cmd", "alt", "ctrl", "shift", "fn", "cmd+alt", "cmd+shift"];
function fillMods(items) {
  for (const it of items) {
    if (it.valid === false) continue;
    it.mods = it.mods || {};
    for (const k of ALL_MODS) if (!it.mods[k]) it.mods[k] = { arg: it.arg || "", subtitle: it.subtitle || "", valid: false };
  }
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    let res;
    switch (cmd) {
      case "search": res = searchItems(query); break;
      case "new": res = newItems(query); break;
      case "daily": res = dailyItems(query); break;
      case "media": res = mediaItems(query); break;
      case "bookmarks": res = bookmarkItems(query); break;
      case "vaults": res = vaultItems(query); break;
      case "index":
        runIndexer();
        return undefined;
      case "index-now": // tests: build synchronously
        for (const v of vaults().list) buildIndex(v);
        return undefined;
      // an empty result prints nothing, so the Notification (only when populated) stays quiet
      case "action": return doAction(query) || undefined;
      default: res = { items: [info(`Unknown command: ${cmd}`, "", "error")] };
    }
    stableUids(res.items || []);
    fillMods(res.items || []);
    return JSON.stringify(Object.assign({ skipknowledge: true }, res));
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (cmd === "action") return `Couldn’t finish: ${msg}`;
    if (cmd === "index" || cmd === "index-now") return undefined;
    return JSON.stringify({ items: [info("Couldn’t search your vaults", msg, "error")] });
  }
}
