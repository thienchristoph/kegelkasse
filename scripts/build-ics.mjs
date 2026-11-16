// Erzeugt kegeltermine.ics aus dem öffentlichen Terminplan in Firestore (public/schedule).
// Aufruf: node scripts/build-ics.mjs [--offline anchor rhythm start]
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const URL = "https://firestore.googleapis.com/v1/projects/kegelkasse-red-snapper/databases/(default)/documents/public/schedule";
const DAY = 86400000;

async function load() {
  const i = process.argv.indexOf("--offline");
  if (i > 0) return { anchor: process.argv[i + 1], rhythm: +process.argv[i + 2], start: process.argv[i + 3] };
  const r = await fetch(URL);
  if (!r.ok) throw new Error("Firestore " + r.status);
  const f = (await r.json()).fields || {};
  return { anchor: f.anchor?.stringValue, rhythm: +(f.rhythm?.integerValue ?? f.rhythm?.doubleValue ?? 28), start: f.start?.stringValue || "20:00" };
}

function dates({ anchor, rhythm }) {
  const [y, m, d] = anchor.split("-").map(Number);
  const a = Date.UTC(y, m - 1, d), now = Date.now(), out = [];
  let k = Math.ceil((now - 1 * DAY - a) / (rhythm * DAY));
  while (out.length < 12) { out.push(new Date(a + k * rhythm * DAY).toISOString().slice(0, 10)); k++; }
  return out;
}

const pad = n => String(n).padStart(2, "0");
function ics(s) {
  const [hh, mm] = s.start.split(":").map(Number);
  const endH = (hh + 4) % 24, nextDay = hh + 4 >= 24;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KC Red Snapper//Kegelkasse//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Kegeln KC Red Snapper", "X-WR-TIMEZONE:Europe/Berlin", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
    "BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE"];
  for (const d of dates(s)) {
    const ymd = d.replace(/-/g, "");
    const endYmd = nextDay ? new Date(Date.parse(d) + DAY).toISOString().slice(0, 10).replace(/-/g, "") : ymd;
    L.push("BEGIN:VEVENT", `UID:kegeln-${ymd}@kc-red-snapper`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Berlin:${ymd}T${pad(hh)}${pad(mm)}00`, `DTEND;TZID=Europe/Berlin:${endYmd}T${pad(endH)}${pad(mm)}00`,
      "SUMMARY:🎳 Kegeln KC Red Snapper", "DESCRIPTION:Kegelkasse: https://thienchristoph.github.io/kegelkasse/", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.join("\r\n") + "\r\n";
}

let s;
try { s = await load(); } catch (e) { console.log("Terminplan nicht lesbar (" + e.message + ") – Kalender bleibt unverändert"); process.exit(0); }
if (!s.anchor || !/^\d{4}-\d{2}-\d{2}$/.test(s.anchor)) throw new Error("Kein gültiger Terminplan");
const out = ics(s);
const strip = t => t.replace(/DTSTAMP:\d+T\d+Z\r\n/g, "");
const old = existsSync("kegeltermine.ics") ? readFileSync("kegeltermine.ics", "utf8") : "";
if (strip(old) === strip(out)) console.log("Keine Änderung");
else { writeFileSync("kegeltermine.ics", out); console.log("kegeltermine.ics aktualisiert:", dates(s).join(", ")); }
