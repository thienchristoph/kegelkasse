import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, getDocs, writeBatch, query, where, Timestamp
} from "firebase/firestore";
import { jsPDF } from "jspdf";
import { firebaseConfig } from "./config.js";

// ---------- Firebase ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// ---------- Konstanten & Helfer ----------
const ROLES = { schrift: "Schriftführer", praes: "Präsident", kass: "Kassierer", admin: "Admin" };
const TOP = ["Pumpe", "Vorsagen", "Betrug", "Kugel bringen erfolgreich"];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const eur = c => (c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const toCents = s => Math.round(parseFloat(String(s).replace(",", ".")) * 100) || 0;
const fmtDate = d => { const [y, m, t] = d.split("-"); return `${t}.${m}.${y}`; };
const $ = s => document.querySelector(s);
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Zustand (Spiegel der Datenbank) ----------
const S = { members: [], catalog: [], settings: { beitrag: 1500, extra: 250, iban: "", bic: "" }, evenings: [], ledger: [], guests: {} };
let role = null, view = null, editEvening = null, loaded = {};
const UI = { mode: null, active: null };
let pending = false;
let isVertreter = false; try { isVertreter = localStorage.getItem("kk-vertr") === "1"; } catch (e) { }
let vList = [];

// ---------- Rechenlogik ----------
const memberName = m => `${m.last}, ${m.first}`;
function personName(key) {
  if (key.startsWith("g:")) return (S.guests[key] || key.slice(2)) + " (Gast)";
  const m = S.members.find(x => x.id === key); return m ? memberName(m) : "?";
}
function shortName(k) {
  if (k.startsWith("g:")) return (S.guests[k] || k.slice(2)) + " (Gast)";
  const m = S.members.find(x => x.id === k); return m ? `${m.last}, ${m.first.charAt(0)}.` : "?";
}
const activeMembers = () => S.members.filter(m => m.active).sort((a, b) => (a.last + a.first).localeCompare(b.last + b.first, "de"));
const balance = key => S.ledger.filter(e => e.key === key).reduce((a, e) => a + e.amount, 0);
const present = ev => activeMembers().filter(m => !ev.absent[m.id]).map(m => m.id).concat(ev.guests.map(g => g.key));
const strafSum = (ev, key) => ev.entries.filter(e => e.key === key).reduce((a, e) => a + e.amount, 0);
const maxStraf = ev => Math.max(0, ...present(ev).map(k => strafSum(ev, k)));
function eveningCharges(ev) {
  const mx = maxStraf(ev), b = S.settings.beitrag, out = [];
  activeMembers().forEach(m => {
    const abs = !!ev.absent[m.id], s = abs ? mx : strafSum(ev, m.id);
    out.push({ key: m.id, abs, straf: s, total: b + s });
  });
  ev.guests.forEach(g => out.push({ key: g.key, abs: false, straf: strafSum(ev, g.key), total: b + strafSum(ev, g.key) }));
  return out;
}
const cats = () => S.catalog.filter(c => !c.free);
const cnt = (ev, k, c) => ev.entries.filter(e => e.key === k && e.cat === c).length;
const freeSum = (ev, k) => ev.entries.filter(e => e.key === k && !cats().some(c => c.id === e.cat)).reduce((a, e) => a + e.amount, 0);
function freq(c) { let n = 0; S.evenings.forEach(ev => ev.entries.forEach(e => { if (e.cat === c.id) n++; })); return n + (TOP.includes(c.name) ? 3 : 0); }
const byId = id => S.evenings.find(e => e.id === id);

// ---------- Schreiben ----------
const evRef = id => doc(db, "evenings", id);
function w(p) { p.catch(err => { console.error(err); if (isVertreter && err.code === "permission-denied") return onErr(err); toast("Nicht gespeichert: keine Berechtigung"); }); }
const saveEntries = ev => w(updateDoc(evRef(ev.id), { entries: ev.entries }));

// ---------- UI-Helfer ----------
function toast(t) { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 2400); }
function sheet(html) { $("#sheet").innerHTML = html ? `<div class="sheet" data-close="1"><div>${html}</div></div>` : ""; }
function closeSheet() { sheet(""); }
document.addEventListener("click", e => { if (e.target.dataset && e.target.dataset.close) closeSheet(); });
let confirmFn = null;
function confirmBox(text, okLabel, fn) {
  confirmFn = fn;
  sheet(`<h2>${esc(text)}</h2><div class="row" style="margin-top:12px"><button onclick="closeSheet()">Abbrechen</button><button class="pri" onclick="runConfirm()">${esc(okLabel)}</button></div>`);
}
function runConfirm() { closeSheet(); const f = confirmFn; confirmFn = null; f && f(); }
function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { } }

// ---------- Synchronisationsanzeige ----------
function syncBar() {
  const el = $("#sync"); if (!el) return;
  const online = navigator.onLine;
  if (!online) { el.className = "off"; el.textContent = "Offline – Eingaben werden gespeichert und später übertragen."; }
  else if (pending) { el.className = "off"; el.textContent = "Wird übertragen …"; }
  else { el.className = ""; el.textContent = "Alles gespeichert und synchronisiert."; }
}
addEventListener("online", syncBar); addEventListener("offline", syncBar);

// ---------- Anmeldung ----------
let pickedRole = null;
function openLogin() {
  sheet(`<h2>Anmelden</h2><p class="mut">Rolle wählen und PIN eingeben. Die erste Anmeldung auf einem Gerät braucht Internet, danach bleibt die Rolle gespeichert.</p>
  <div class="row" id="rsel">${Object.entries(ROLES).map(([k, r]) => `<button data-r="${k}" onclick="pickRole('${k}')">${r}</button>`).join("")}</div>
  <div class="row" style="margin-top:12px"><input id="pin" inputmode="numeric" type="password" placeholder="PIN" class="grow"><button class="pri" onclick="login()">Anmelden</button></div>
  ${role ? `<p><button onclick="logout()">Abmelden</button></p>` : ""}`);
}
function pickRole(k) { pickedRole = k; document.querySelectorAll("#rsel button").forEach(b => b.classList.toggle("sel", b.dataset.r === k)); $("#pin").focus(); }
async function login() {
  if (!pickedRole) return toast("Bitte Rolle wählen");
  const pin = $("#pin").value.trim(); if (!pin) return toast("Bitte PIN eingeben");
  await doLogin(pickedRole, pin, false);
}
async function doLogin(r, pin, vertr) {
  if (!navigator.onLine) return toast("Für die Anmeldung wird Internet gebraucht");
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    const p = setDoc(doc(db, "sessions", auth.currentUser.uid), { role: r, pin, at: Date.now() });
    await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000))]);
    role = r; isVertreter = vertr;
    try { localStorage.setItem("kk-role", role); localStorage.setItem("kk-vertr", vertr ? "1" : "0"); } catch (e) { }
    closeSheet(); view = null; startListeners(); render(); toast(vertr ? `Als Vertretung angemeldet: ${ROLES[role]}` : `Angemeldet als ${ROLES[role]}`);
  } catch (e) {
    console.error(e); toast(e.message === "timeout" ? "Keine Verbindung – bitte später erneut" : vertr ? "Vertretung ist abgelaufen oder beendet" : "PIN falsch");
  }
}
async function logout() {
  try { await deleteDoc(doc(db, "sessions", auth.currentUser.uid)); } catch (e) { }
  role = null; isVertreter = false; try { localStorage.removeItem("kk-role"); localStorage.removeItem("kk-vertr"); } catch (e) { }
  stopListeners(); closeSheet(); render();
}

// ---------- Live-Daten ----------
let unsubs = [];
function stopListeners() { unsubs.forEach(u => u()); unsubs = []; loaded = {}; }
function startListeners() {
  stopListeners();
  const opt = { includeMetadataChanges: true };
  const pend = {};
  const track = (name, snap) => { pend[name] = snap.metadata.hasPendingWrites; pending = Object.values(pend).some(Boolean); loaded[name] = true; syncBar(); };
  unsubs.push(onSnapshot(collection(db, "members"), opt, s => { S.members = s.docs.map(d => ({ id: d.id, ...d.data() })); track("members", s); renderSafe(); }, onErr));
  unsubs.push(onSnapshot(collection(db, "catalog"), opt, s => { S.catalog = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); track("catalog", s); renderSafe(); }, onErr));
  unsubs.push(onSnapshot(doc(db, "settings", "main"), opt, s => { if (s.exists()) S.settings = s.data(); track("settings", s); renderSafe(); }, onErr));
  unsubs.push(onSnapshot(collection(db, "guests"), opt, s => { S.guests = {}; s.docs.forEach(d => S.guests[d.id] = d.data().name); track("guests", s); renderSafe(); }, onErr));
  unsubs.push(onSnapshot(collection(db, "evenings"), opt, s => {
    S.evenings = s.docs.map(d => ({ id: d.id, absent: {}, guests: [], entries: [], ...d.data() })).sort((a, b) => (a.date + a.time + (a.created || 0)).localeCompare(b.date + b.time + (b.created || 0)));
    track("evenings", s); renderSafe();
  }, onErr));
  unsubs.push(onSnapshot(collection(db, "ledger"), opt, s => { S.ledger = s.docs.map(d => ({ id: d.id, ...d.data() })); track("ledger", s); renderSafe(); }, onErr));
  if (!isVertreter) {
    const q = (role === "praes" || role === "admin") ? query(collection(db, "pins"), where("vertretung", "==", true))
      : query(collection(db, "pins"), where("vertretung", "==", true), where("role", "==", role));
    unsubs.push(onSnapshot(q, s => { vList = s.docs.map(d => ({ pin: d.id, ...d.data() })); renderSafe(); }, e => console.warn(e)));
  }
}
function onErr(e) {
  console.error(e);
  if (e.code === "permission-denied") { const v = isVertreter; role = null; isVertreter = false; try { localStorage.removeItem("kk-role"); localStorage.removeItem("kk-vertr"); } catch (x) { } stopListeners(); render(); toast(v ? "Die Vertretung ist beendet – danke!" : "Bitte neu anmelden"); }
}

// ---------- Navigation ----------
function tabs() {
  const t = [];
  if (role === "schrift" || role === "admin") t.push(["abend", "Kegelabend"]);
  if (role === "praes" || role === "admin") t.push(["pruefen", "Prüfen & PDF"]);
  if (role === "kass" || role === "admin") t.push(["offen", "Offene Beträge"], ["katalog", "Katalog & Einstellungen"], ["mitglieder", "Mitglieder"]);
  if (!isVertreter) t.push(["vertretung", "Vertretung"]);
  if (role === "admin") t.push(["admin", "PINs"]);
  return t;
}
function go(v) { view = v; editEvening = null; render(); }
let wantRender = false;
function renderSafe() { if (lp) { wantRender = true; return; } render(); }
function render() {
  wantRender = false;
  $("#roleBtn").textContent = role ? ROLES[role] + " ▾" : "Anmelden";
  const t = tabs();
  if (!role) {
    $("#nav").innerHTML = "";
    $("#main").innerHTML = `<div class="card"><h2>Kegelkasse KC Red Snapper</h2><p>Oben rechts mit Rolle und PIN anmelden.</p><p class="mut">Ablauf: Schriftführer erfasst den Abend und schließt ihn im Entwurf ab → Präsident prüft, schließt final ab und erstellt das PDF → Kassierer hakt Zahlungen ab.</p></div>`;
    return;
  }
  if (!loaded.evenings || !loaded.members) { $("#main").innerHTML = `<div class="card">Lade Daten …</div>`; return; }
  if (!view || !t.find(x => x[0] === view)) view = t[0][0];
  $("#nav").innerHTML = t.map(([k, l]) => `<button class="${k === view ? "sel" : ""}" onclick="go('${k}')">${l}</button>`).join("");
  ({ abend: vAbend, pruefen: vPruefen, offen: vOffen, katalog: vKatalog, mitglieder: vMitglieder, admin: vAdmin, vertretung: vVertretung })[view]();
  if (isVertreter) $("#main").insertAdjacentHTML("afterbegin", `<div class="hi">Du bist als <b>Vertretung</b> für ${ROLES[role]} angemeldet. Der Zugang endet automatisch.</div>`);
}

// ---------- Schriftführer ----------
const currentEvening = () => S.evenings.find(e => e.status === "offen");
function vAbend() {
  const ev = currentEvening();
  if (!ev) {
    const now = new Date(), d = today(), t = now.toTimeString().slice(0, 5);
    $("#main").innerHTML = `<div class="card"><h2>Neuer Kegelabend</h2><div class="row"><input type="date" id="evd" value="${d}"><input type="time" id="evt" value="${t}"><button class="pri" onclick="newEvening()">Abend anlegen</button></div>
    <p class="mut">Die Uhrzeit ist nur zur Info.</p></div>${lastEvenings()}`; return;
  }
  renderEvening(ev);
}
function lastEvenings() {
  if (!S.evenings.length) return "";
  return `<div class="card"><h2>Bisherige Abende</h2><table>${S.evenings.slice().reverse().map(e => `<tr><td>${fmtDate(e.date)}</td><td><span class="pill ${e.status}">${e.status === "final" ? "final" : e.status === "entwurf" ? "Entwurf" : "offen"}</span></td></tr>`).join("")}</table></div>`;
}
function newEvening() {
  const id = uid();
  w(setDoc(evRef(id), { date: $("#evd").value, time: $("#evt").value, status: "offen", absent: {}, guests: [], entries: [], created: Date.now() }));
}
function setMode(m) { UI.mode = m; render(); }
function setActive(k) { UI.active = k; render(); }
function back() { editEvening = null; render(); }
function edit(id) { editEvening = id; render(); }
function renderEvening(ev) {
  const mx = maxStraf(ev), editable = ev.status !== "final";
  const pres = present(ev);
  const mode = UI.mode || (window.innerWidth >= 900 ? "raster" : "kegler");
  const gw0 = $(".gridwrap"), sl = gw0 ? gw0.scrollLeft : 0, sy = window.scrollY, st0 = $(".strip"), stl = st0 ? st0.scrollLeft : 0;
  const gname = $("#gname") ? $("#gname").value : "";
  $("#main").innerHTML = `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Abend ${fmtDate(ev.date)} · ${esc(ev.time || "")}</h2><span class="pill ${ev.status}">${ev.status === "entwurf" ? "Entwurf" : ev.status}</span></div>
    <div class="hi">Höchststrafe heute: <b>${eur(mx)}</b> – zahlen alle Abwesenden zusätzlich zum Beitrag von ${eur(S.settings.beitrag)}.</div>
    <div class="row" style="margin-bottom:10px"><button class="${mode === "raster" ? "sel" : ""}" onclick="setMode('raster')">Raster (Tablet)</button><button class="${mode === "kegler" ? "sel" : ""}" onclick="setMode('kegler')">Aktiver Kegler (Handy)</button></div>
    ${!pres.length ? '<p class="mut">Niemand anwesend.</p>' : mode === "raster" ? gridHtml(ev, pres, editable) : keglerHtml(ev, pres, editable)}
  </div>
  <div class="card"><h2>Anwesenheit</h2><p class="mut">Antippen schaltet um zwischen anwesend und abwesend.</p>
    <div class="row">${activeMembers().map(m => `<button class="${ev.absent[m.id] ? "" : "sel"}" ${editable ? "" : "disabled"} onclick="toggleAbs('${ev.id}','${m.id}')">${esc(m.last)}, ${esc(m.first.split(" ")[0])}</button>`).join("")}</div>
  </div>
  <div class="card"><h2>Gäste</h2><div class="row"><input id="gname" class="grow" placeholder="Name des Gastes" value="${esc(gname)}"><button onclick="addGuest('${ev.id}')" ${editable ? "" : "disabled"}>Gast hinzufügen</button></div>
    ${ev.guests.length ? `<ul class="entries">${ev.guests.map(g => `<li><span>${esc(S.guests[g.key] || g.key.slice(2))}</span>${editable && !ev.entries.some(e => e.key === g.key) ? `<button onclick="delGuest('${ev.id}','${g.key}')">Entfernen</button>` : ""}</li>`).join("")}</ul>` : ""}
  </div>
  ${summaryCard(ev)}
  <div class="card row">
    ${ev.status === "offen" ? `<button class="pri" onclick="toDraft('${ev.id}')">Im Entwurf abschließen</button>` : ""}
    ${editEvening ? `<button onclick="back()">Zurück</button>` : ""}
  </div>`;
  const gw = $(".gridwrap"); if (gw) gw.scrollLeft = sl;
  const st = $(".strip"); if (st) { st.scrollLeft = stl; const c = st.querySelector(".chip.sel"); if (c && (c.offsetLeft < st.scrollLeft || c.offsetLeft + c.offsetWidth > st.scrollLeft + st.clientWidth)) st.scrollLeft = c.offsetLeft - 12; }
  window.scrollTo(0, sy);
}
function toDraft(id) {
  confirmBox("Abend im Entwurf abschließen? Danach kann nur noch der Präsident ändern.", "Im Entwurf abschließen", () => { w(updateDoc(evRef(id), { status: "entwurf" })); toast("An Präsident übergeben"); });
}
function summaryCard(ev) {
  const ch = eveningCharges(ev), sum = ch.reduce((a, c) => a + c.total, 0);
  return `<div class="card"><h2>Abrechnung des Abends</h2><table><tr><th>Name</th><th class="r">Beitrag</th><th class="r">Strafen</th><th class="r">Gesamt</th></tr>
  ${ch.map(c => `<tr><td>${esc(personName(c.key))}${c.abs ? ' <span class="pill">abwesend</span>' : ""}</td><td class="r">${eur(S.settings.beitrag)}</td><td class="r">${eur(c.straf)}</td><td class="r"><b>${eur(c.total)}</b></td></tr>`).join("")}
  <tr><td><b>Summe</b></td><td></td><td></td><td class="r"><b>${eur(sum)}</b></td></tr></table></div>`;
}
const press = (evId, k, c) => `data-ev="${evId}" data-k="${k}" data-c="${c}" onpointerdown="pd(event)" oncontextmenu="return false"`;
function gridHtml(ev, pres, ed) {
  const C = cats();
  return `<p class="mut">Zelle antippen = +1 · lange drücken = −1</p><div class="gridwrap"><table class="grid"><thead><tr><th class="nm">Name</th>${C.map(c => `<th>${esc(c.name)}<small>${eur(c.amount)}</small></th>`).join("")}<th>Freitext / Ordnung</th><th>Summe</th></tr></thead><tbody>
  ${pres.map(k => `<tr><td class="nm">${esc(shortName(k))}</td>${C.map(c => { const n = cnt(ev, k, c.id); return `<td class="cell ${n ? "has" : ""}" ${ed ? press(ev.id, k, c.id) : ""}>${n || ""}</td>`; }).join("")}<td class="cell free ${freeSum(ev, k) ? "has" : ""}" ${ed ? `onclick="freeDlg('${ev.id}','${k}')"` : ""}>${freeSum(ev, k) ? eur(freeSum(ev, k)) : "+"}</td><td class="sum">${eur(strafSum(ev, k))}</td></tr>`).join("")}
  </tbody></table></div>`;
}
function keglerHtml(ev, pres, ed) {
  if (!UI.active || !pres.includes(UI.active)) UI.active = pres[0];
  const k = UI.active, C = cats().slice().sort((a, b) => freq(b) - freq(a)), big = C.slice(0, 4), rest = C.slice(4);
  const btn = c => { const n = cnt(ev, k, c.id); return `<button class="cat" ${ed ? press(ev.id, k, c.id) : "disabled"}>${esc(c.name)}<small>${eur(c.amount)}</small>${n ? `<span class="cnt">${n}</span>` : ""}</button>`; };
  const mine = ev.entries.filter(e => e.key === k);
  return `<div class="strip">${pres.map(p => `<button class="chip ${p === k ? "sel" : ""}" onclick="setActive('${p}')">${esc(shortName(p))}<small>${eur(strafSum(ev, p))}</small></button>`).join("")}</div>
  <div class="row" style="margin:12px 0 8px"><h2 class="grow" style="margin:0">${esc(personName(k))}</h2><b style="font-size:24px">${eur(strafSum(ev, k))}</b></div>
  <div class="cats big">${big.map(btn).join("")}</div>
  <div class="cats" style="margin-top:8px">${rest.map(btn).join("")}<button class="cat" ${ed ? `onclick="freeDlg('${ev.id}','${k}')"` : "disabled"}>Freitext / Ordnung<small>freier Betrag</small></button></div>
  <p class="mut">Oben antippen, wer gerade kegelt. Strafe antippen = +1 · lange drücken = −1.</p>
  ${mine.length ? `<details><summary class="mut">Erfasst für ${esc(shortName(k))} (${mine.length})</summary><ul class="entries">${mine.slice().reverse().map(e => `<li><span>${esc(e.text)}</span><span>${eur(e.amount)} ${ed ? `<button onclick="delE('${ev.id}','${e.id}')">Löschen</button>` : ""}</span></li>`).join("")}</ul></details>` : ""}`;
}
// Tippen (+1) und langes Drücken (−1); global abgefangen, damit ein Neuaufbau der Seite nichts verschluckt
let lp = null;
function pd(e) {
  const t = e.currentTarget; pc();
  lp = { evId: t.dataset.ev, key: t.dataset.k, catId: t.dataset.c, x: e.clientX, y: e.clientY, fired: false };
  lp.t = setTimeout(() => { if (!lp) return; lp.fired = true; const l = lp; lp = null; removeLast(l.evId, l.key, l.catId); }, 550);
}
function pu() { if (!lp) return; clearTimeout(lp.t); const l = lp; lp = null; if (!l.fired) addE(l.evId, l.key, l.catId); if (wantRender) render(); }
function pc() { if (lp) { clearTimeout(lp.t); lp = null; if (wantRender) render(); } }
document.addEventListener("pointerup", pu);
document.addEventListener("pointercancel", pc);
document.addEventListener("pointermove", e => { if (lp && (Math.abs(e.clientX - lp.x) > 12 || Math.abs(e.clientY - lp.y) > 12)) pc(); });
function addE(evId, key, catId) {
  const ev = byId(evId), c = S.catalog.find(x => x.id === catId); if (!ev || !c) return;
  const e = { id: uid(), key, cat: c.id, amount: c.amount, text: c.name };
  ev.entries = ev.entries.concat([e]); saveEntries(ev); buzz(15); render(); undoBar(ev, e);
}
function removeLast(evId, key, catId) {
  const ev = byId(evId); const i = ev.entries.map(e => e.key === key && e.cat === catId).lastIndexOf(true);
  if (i < 0) { render(); return; }
  const e = ev.entries[i]; ev.entries = ev.entries.filter((_, j) => j !== i); saveEntries(ev); buzz([20, 40, 20]); render(); toast(`${e.text} – ${shortName(key)} entfernt`);
}
function delE(evId, id) { const ev = byId(evId); ev.entries = ev.entries.filter(e => e.id !== id); saveEntries(ev); render(); const u = $("#undo"); if (u) u.remove(); }
let undoT = null;
function undoBar(ev, e) {
  let d = $("#undo"); if (!d) { d = document.createElement("div"); d.id = "undo"; document.body.appendChild(d); }
  d.innerHTML = `<span>${esc(e.text)} – ${esc(shortName(e.key))}</span><button onclick="delE('${ev.id}','${e.id}')">Rückgängig</button>`;
  clearTimeout(undoT); undoT = setTimeout(() => { const x = $("#undo"); if (x) x.remove(); }, 4000);
}
function freeDlg(evId, key) {
  sheet(`<h2>Freitext-Strafe – ${esc(personName(key))}</h2>
  <div class="row"><select id="ftcat"><option value="">Freitext</option>${S.catalog.filter(c => c.free).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
  <input id="fttext" class="grow" placeholder="Text (z. B. Handy auf dem Tisch)"></div>
  <div class="row" style="margin-top:10px"><input id="ftamt" inputmode="decimal" placeholder="Betrag €" class="grow"><button onclick="closeSheet()">Abbrechen</button><button class="pri" onclick="addFreeE('${evId}','${key}')">Hinzufügen</button></div>`);
  setTimeout(() => { const a = $("#ftamt"); a && a.focus(); }, 50);
}
function addFreeE(evId, key) {
  const amt = toCents($("#ftamt").value); if (amt <= 0) return toast("Bitte Betrag eingeben");
  const catId = $("#ftcat").value, c = S.catalog.find(x => x.id === catId), t = $("#fttext").value.trim();
  const ev = byId(evId), e = { id: uid(), key, cat: catId || "free", amount: amt, text: (c ? c.name : "Freitext") + (t ? ": " + t : "") };
  ev.entries = ev.entries.concat([e]); saveEntries(ev); closeSheet(); buzz(15); render(); undoBar(ev, e);
}
function toggleAbs(evId, key) {
  const ev = byId(evId); if (ev.status === "final") return;
  const absent = { ...ev.absent };
  if (absent[key]) delete absent[key]; else { if (ev.entries.some(e => e.key === key)) return toast("Hat schon Strafen – erst löschen"); absent[key] = true; }
  w(updateDoc(evRef(evId), { absent }));
}
function addGuest(evId) {
  const n = $("#gname").value.trim(); if (!n) return;
  const key = "g:" + n.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-");
  const ev = byId(evId);
  w(setDoc(doc(db, "guests", key), { name: n }));
  if (!ev.guests.some(g => g.key === key)) w(updateDoc(evRef(evId), { guests: ev.guests.concat([{ key }]) }));
  $("#gname").value = "";
}
function delGuest(evId, key) { const ev = byId(evId); w(updateDoc(evRef(evId), { guests: ev.guests.filter(g => g.key !== key) })); }

// ---------- Präsident ----------
function vPruefen() {
  if (editEvening) { const ev = byId(editEvening); if (ev) return renderEvening(ev); editEvening = null; }
  const drafts = S.evenings.filter(e => e.status === "entwurf" || (role === "admin" && e.status === "offen")), finals = S.evenings.filter(e => e.status === "final");
  const last = finals[finals.length - 1];
  $("#main").innerHTML = `
  <div class="card"><h2>Zur Prüfung</h2>${drafts.length ? drafts.map(ev => `
    <div class="card"><div class="row"><b class="grow">Abend ${fmtDate(ev.date)}</b><button onclick="edit('${ev.id}')">Prüfen / korrigieren</button>
    <button class="pri" onclick="askFinal('${ev.id}')">Final abschließen</button>${role === "admin" ? ` <button onclick="askDelete('${ev.id}')">Löschen</button>` : ""}</div>
    ${summaryCard(ev)}</div>`).join("") : '<p class="mut">Kein Abend wartet auf Prüfung.</p>'}</div>
  <div class="card"><h2>Abgeschlossene Abende</h2>${finals.length ? `<table>${finals.slice().reverse().map(ev => `<tr><td>${fmtDate(ev.date)}</td><td class="r"><button class="pri" onclick="makePdf('${ev.date}')">PDF erstellen</button> ${ev === last ? `<button onclick="askUnfinal('${ev.id}')">Zurücknehmen</button>` : ""}</td></tr>`).join("")}</table>` : '<p class="mut">Noch keiner.</p>'}
  <p class="mut">Das PDF zeigt den offenen Stand je Person, so wie er gerade ist.</p></div>`;
}
function askFinal(id) {
  const ev = byId(id);
  confirmBox(`Abend ${fmtDate(ev.date)} final abschließen? Wer noch offene Beträge hat, bekommt die Extrastrafe von ${eur(S.settings.extra)}.`, "Final abschließen", () => finalize(ev));
}
function askDelete(id) {
  const ev = byId(id);
  confirmBox(`Abend ${fmtDate(ev.date)} komplett löschen? Alle erfassten Strafen dieses Abends gehen verloren.`, "Löschen", () => { w(deleteDoc(evRef(id))); toast("Abend gelöscht"); });
}
function finalize(ev) {
  const b = writeBatch(db);
  const keys = new Set(S.ledger.map(e => e.key));
  keys.forEach(k => { if (balance(k) > 0) b.set(doc(db, "ledger", uid()), { key: k, date: ev.date, type: "extra", amount: S.settings.extra, text: "Extrastrafe (nicht gezahlt)", ev: ev.id }); });
  eveningCharges(ev).forEach(c => b.set(doc(db, "ledger", uid()), { key: c.key, date: ev.date, type: "abend", amount: c.total, text: c.abs ? "Abwesend: Beitrag + Höchststrafe" : "Beitrag + Strafen", ev: ev.id }));
  b.update(evRef(ev.id), { status: "final" });
  w(b.commit()); toast("Final abgeschlossen");
}
function askUnfinal(id) {
  const ev = byId(id);
  confirmBox(`Finalen Abschluss vom ${fmtDate(ev.date)} zurücknehmen? Der Abend geht zurück in den Entwurf.`, "Zurücknehmen", () => {
    const b = writeBatch(db);
    S.ledger.filter(e => e.ev === id).forEach(e => b.delete(doc(db, "ledger", e.id)));
    b.update(evRef(id), { status: "entwurf" }); w(b.commit());
  });
}
async function makePdf(date) {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(15);
  pdf.text(`Ausstehende Kegelbeiträge zum ${fmtDate(date)}`, 20, 38);
  try { const img = await fetch("logo.png").then(r => r.blob()).then(b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); })); pdf.addImage(img, "PNG", 145, 18, 45, 35); } catch (e) { }
  const rows = activeMembers().map(m => [memberName(m), balance(m.id)])
    .concat(Object.keys(S.guests).filter(k => balance(k) > 0).map(k => [S.guests[k] + " (Gast)", balance(k)]));
  const x0 = 20, x1 = 115, x2 = 150, x3 = 190; let y = 60; const rh = 8.5;
  pdf.setFillColor(217, 217, 217); pdf.rect(x0, y, x3 - x0, 13, "F");
  pdf.setFontSize(12); pdf.text("Name", x0 + 1.5, y + 6); pdf.text("Ausstehende", x2 - 2, y + 5.5, { align: "right" }); pdf.text("Beiträge", x2 - 6, y + 11, { align: "right" }); pdf.text("Bezahlt?", (x2 + x3) / 2, y + 6, { align: "center" });
  pdf.setLineWidth(.4); pdf.rect(x0, y, x3 - x0, 13);
  [x1, x2].forEach(x => pdf.line(x, y, x, y + 13 + rows.length * rh));
  y += 13; pdf.setFont("helvetica", "normal"); pdf.setFontSize(11);
  rows.forEach(([n, b]) => { pdf.rect(x0, y, x3 - x0, rh); pdf.text(n, x0 + 1.5, y + 5.8); pdf.text(b > 0 ? eur(b) : "- €", x2 - 2, y + 5.8, { align: "right" }); pdf.rect((x2 + x3) / 2 - 1.6, y + 2.6, 3.2, 3.2); y += rh; });
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(11);
  pdf.text(`IBAN: ${S.settings.iban}`, x0, y + 18); pdf.text(`BIC: ${S.settings.bic}`, x0, y + 24);
  const name = `${date.replace(/-/g, "_")}_Ausstehende_Kegelbeitraege.pdf`;
  const blob = pdf.output("blob"), file = new File([blob], name, { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  window._pdfFile = file;
  window._pdfUrl = url;
  sheet(`<div class="row"><h2 class="grow" style="margin:0">PDF ist fertig</h2><button onclick="closeSheet()">Schließen</button></div>
  <p class="mut">${esc(name)}</p>
  <div class="row" style="margin:10px 0">${canShare ? `<button class="pri" onclick="sharePdf()">Teilen (z. B. WhatsApp)</button>` : ""}<button onclick="openPdf()">Öffnen</button><a href="${url}" download="${esc(name)}"><button>Herunterladen</button></a></div>
  <div class="card"><h2>Ausstehende Kegelbeiträge zum ${fmtDate(date)}</h2><table><tr><th>Name</th><th class="r">Ausstehend</th></tr>${rows.map(([n, b]) => `<tr><td>${esc(n)}</td><td class="r">${b > 0 ? eur(b) : "- €"}</td></tr>`).join("")}</table>
  <p class="mut">IBAN: ${esc(S.settings.iban)} · BIC: ${esc(S.settings.bic)}</p></div>`);
}
function openPdf() { const a = document.createElement("a"); a.href = window._pdfUrl; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
async function sharePdf() { try { await navigator.share({ files: [window._pdfFile], title: window._pdfFile.name }); } catch (e) { } }

// ---------- Kassierer ----------
function vOffen() {
  const keys = activeMembers().map(m => m.id).concat(Object.keys(S.guests));
  const rows = keys.map(k => ({ k, b: balance(k), paid: S.ledger.filter(e => e.key === k && e.type === "zahlung").sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-1)[0] })).filter(r => r.b > 0 || r.paid);
  const total = rows.reduce((a, r) => a + Math.max(0, r.b), 0);
  $("#main").innerHTML = `<div class="card"><h2>Offene Beträge</h2><p class="mut">Nach Kontoauszug abhaken. Wer beim nächsten finalen Abschluss noch offen ist, bekommt die Extrastrafe (${eur(S.settings.extra)}).</p>
  <table><tr><th>Name</th><th class="r">Offen</th><th></th></tr>${rows.map(r => `<tr><td>${esc(personName(r.k))}</td><td class="r">${r.b > 0 ? eur(r.b) : "–"}</td>
  <td class="r">${r.b > 0 ? `<button class="ok" onclick="pay('${r.k}')">Bezahlt</button>` : `<span class="mut">bezahlt ${eur(-r.paid.amount)}</span> <button onclick="unpay('${r.paid.id}')">Rückgängig</button>`}</td></tr>`).join("")}
  <tr><td><b>Summe offen</b></td><td class="r"><b>${eur(total)}</b></td><td></td></tr></table></div>
  <div class="card"><h2>Anfangssaldo / Korrektur</h2><p class="mut">Einmalig beim Start oder für Korrekturen. Positiv = schuldet, negativ = Guthaben.</p>
  <div class="row"><select id="sk">${activeMembers().map(m => `<option value="${m.id}">${esc(memberName(m))}</option>`).join("")}</select><input id="sa" inputmode="decimal" placeholder="Betrag €" style="width:120px"><button onclick="addStart()">Buchen</button></div>
  ${S.ledger.filter(e => e.type === "start").length ? `<ul class="entries">${S.ledger.filter(e => e.type === "start").map(e => `<li><span>${esc(personName(e.key))} · ${fmtDate(e.date)}</span><span>${eur(e.amount)} <button onclick="unpay('${e.id}')">Löschen</button></span></li>`).join("")}</ul>` : ""}</div>`;
}
function pay(k) { w(setDoc(doc(db, "ledger", uid()), { key: k, date: today(), type: "zahlung", amount: -balance(k), text: "Zahlung", at: Date.now() })); }
function unpay(id) { w(deleteDoc(doc(db, "ledger", id))); }
function addStart() { const a = toCents($("#sa").value); if (!a) return; w(setDoc(doc(db, "ledger", uid()), { key: $("#sk").value, date: today(), type: "start", amount: a, text: "Anfangssaldo/Korrektur", at: Date.now() })); $("#sa").value = ""; toast("Gebucht"); }

function vKatalog() {
  const v = c => (c / 100).toFixed(2).replace(".", ",");
  $("#main").innerHTML = `<div class="card"><h2>Einstellungen</h2>
  <div class="row"><label class="grow">Kegelbeitrag je Abend<br><input id="sb" value="${v(S.settings.beitrag)}"></label>
  <label class="grow">Extrastrafe (nicht gezahlt)<br><input id="se" value="${v(S.settings.extra)}"></label></div>
  <div class="row" style="margin-top:8px"><label class="grow">IBAN<br><input id="si" value="${esc(S.settings.iban)}" style="width:100%"></label><label>BIC<br><input id="sc" value="${esc(S.settings.bic)}"></label></div>
  <p><button class="pri" onclick="saveSettings()">Speichern</button></p></div>
  <div class="card"><h2>Strafenkatalog</h2><table><tr><th>Strafe</th><th class="r">Betrag</th><th></th></tr>
  ${S.catalog.map(c => `<tr><td><input value="${esc(c.name)}" onchange="catSet('${c.id}','name',this.value)" style="width:100%"></td><td class="r">${c.free ? '<span class="mut">frei</span>' : `<input value="${v(c.amount)}" onchange="catSet('${c.id}','amount',this.value)" style="width:90px;text-align:right">`}</td><td class="r"><button onclick="catDel('${c.id}')">✕</button></td></tr>`).join("")}</table>
  <div class="row" style="margin-top:10px"><input id="cn" class="grow" placeholder="Neue Strafe"><input id="ca" inputmode="decimal" placeholder="€ (leer = frei)" style="width:130px"><button onclick="catAdd()">Hinzufügen</button></div></div>`;
}
function saveSettings() { w(setDoc(doc(db, "settings", "main"), { beitrag: toCents($("#sb").value), extra: toCents($("#se").value), iban: $("#si").value.trim(), bic: $("#sc").value.trim() })); toast("Gespeichert"); }
function catSet(id, f, val) { w(updateDoc(doc(db, "catalog", id), { [f]: f === "amount" ? toCents(val) : val })); }
function catDel(id) { confirmBox("Strafe aus dem Katalog entfernen? Bereits erfasste Strafen bleiben.", "Entfernen", () => w(deleteDoc(doc(db, "catalog", id)))); }
function catAdd() {
  const n = $("#cn").value.trim(); if (!n) return; const a = $("#ca").value.trim();
  const order = Math.max(0, ...S.catalog.map(c => c.order || 0)) + 1;
  w(setDoc(doc(db, "catalog", uid()), { name: n, amount: a ? toCents(a) : 0, free: !a, order }));
}
function vMitglieder() {
  $("#main").innerHTML = `<div class="card"><h2>Mitglieder</h2><table>${S.members.slice().sort((a, b) => (a.last + a.first).localeCompare(b.last + b.first, "de")).map(m => `<tr><td>${esc(memberName(m))}</td><td class="r"><button onclick="toggleMem('${m.id}')">${m.active ? "Deaktivieren" : "Aktivieren"}</button></td></tr>`).join("")}</table>
  <div class="row" style="margin-top:10px"><input id="ml" placeholder="Nachname" class="grow"><input id="mf" placeholder="Vorname" class="grow"><button onclick="addMem()">Hinzufügen</button></div>
  <p class="mut">Deaktivierte Mitglieder erscheinen nicht mehr an neuen Abenden und nicht im PDF.</p></div>`;
}
function toggleMem(id) { const m = S.members.find(x => x.id === id); w(updateDoc(doc(db, "members", id), { active: !m.active })); }
function addMem() { const l = $("#ml").value.trim(), f = $("#mf").value.trim(); if (!l) return; w(setDoc(doc(db, "members", uid()), { last: l, first: f, active: true })); }

// ---------- Vertretung ----------
const fmtDT = ms => new Date(ms).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " Uhr";
const vLink = v => `${location.origin}${location.pathname}#v-${v.role}-${v.pin}`;
const vText = v => `Hallo! Du vertrittst heute in der Kegelkasse KC Red Snapper als ${ROLES[v.role]} (gültig bis ${fmtDT(v.until.toMillis())}). Einfach hier tippen, dann bist du direkt angemeldet: ${vLink(v)}`;
function vVertretung() {
  const roles = (role === "praes" || role === "admin") ? ["schrift", "kass"] : [role];
  const now = Date.now();
  $("#main").innerHTML = roles.map(r => {
    const act = vList.filter(v => v.role === r && v.until && v.until.toMillis() > now);
    return `<div class="card"><h2>Vertretung ${ROLES[r]}</h2>${act.length ? act.map(v => `
      <p>Aktiv bis <b>${fmtDT(v.until.toMillis())}</b> · PIN <b>${esc(v.pin)}</b></p>
      <div class="row"><a href="https://wa.me/?text=${encodeURIComponent(vText(v))}" target="_blank" rel="noopener"><button class="ok">Per WhatsApp senden</button></a>
      <button onclick="shareV('${v.pin}')">Anders teilen</button><button onclick="endV('${v.pin}')">Vertretung beenden</button></div>`).join("")
      : `<p class="mut">Der Vertreter bekommt einen Link, mit dem er direkt angemeldet ist. Der Zugang gilt 24 Stunden und nur für diese Rolle.</p>
      <button class="pri" onclick="createV('${r}')">Vertretung einrichten</button>`}</div>`;
  }).join("");
}
async function createV(r) {
  if (!navigator.onLine) return toast("Dafür wird Internet gebraucht");
  for (let i = 0; i < 6; i++) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    try {
      await setDoc(doc(db, "pins", pin), { role: r, vertretung: true, until: Timestamp.fromMillis(Date.now() + 24 * 3600 * 1000), by: auth.currentUser.uid });
      toast("Vertretung eingerichtet"); return;
    } catch (e) { console.warn(e); }
  }
  toast("Hat nicht geklappt – bitte erneut versuchen");
}
async function shareV(pin) {
  const v = vList.find(x => x.pin === pin); if (!v) return;
  try { if (navigator.share) await navigator.share({ text: vText(v) }); else { await navigator.clipboard.writeText(vText(v)); toast("Text kopiert"); } } catch (e) { }
}
function endV(pin) { confirmBox("Vertretung jetzt beenden? Der Vertreter wird sofort abgemeldet.", "Beenden", () => { w(deleteDoc(doc(db, "pins", pin))); toast("Vertretung beendet"); }); }

// ---------- Admin: PINs ----------
async function vAdmin() {
  $("#main").innerHTML = `<div class="card"><h2>PINs ändern</h2><p class="mut">Neue PIN für eine Rolle setzen (mindestens 4 Ziffern). Die alte PIN wird sofort ungültig, wer damit angemeldet ist, wird abgemeldet.</p>
  <div class="row"><select id="pr">${Object.entries(ROLES).map(([k, r]) => `<option value="${k}">${r}</option>`).join("")}</select><input id="pn" inputmode="numeric" placeholder="Neue PIN" class="grow"><button class="pri" onclick="setPin()">Setzen</button></div></div>
  <div class="card"><h2>Alle Geräte abmelden</h2><p class="mut">Meldet alle Geräte ab, z. B. beim Ämterwechsel. Du bleibst angemeldet.</p><button onclick="kickAll()">Alle anderen abmelden</button></div>`;
}
async function setPin() {
  const r = $("#pr").value, p = $("#pn").value.trim();
  if (!/^\d{4,}$/.test(p)) return toast("Mindestens 4 Ziffern");
  try {
    const all = await getDocs(collection(db, "pins")); const b = writeBatch(db);
    all.docs.forEach(d => { if (d.data().role === r && !d.data().vertretung) b.delete(d.ref); });
    b.set(doc(db, "pins", p), { role: r }); await b.commit(); $("#pn").value = ""; toast(`PIN für ${ROLES[r]} geändert`);
  } catch (e) { console.error(e); toast("Fehler beim Speichern"); }
}
async function kickAll() {
  try {
    const all = await getDocs(collection(db, "sessions")); const b = writeBatch(db);
    all.docs.forEach(d => { if (d.id !== auth.currentUser.uid) b.delete(d.ref); }); await b.commit(); toast(`${all.size - 1} Geräte abgemeldet`);
  } catch (e) { console.error(e); toast("Fehler"); }
}

// ---------- Ersteinrichtung (einmalig, nur bei offenen Regeln) ----------
async function setupSeed(pins) {
  if (!auth.currentUser) await signInAnonymously(auth);
  const names = [["Agnesens", "Jan Erik"], ["Bollmann", "Dominik"], ["Eckrodt", "Marius"], ["Frochte", "Julian Linus"], ["Krogbeumker", "Caspar Maria"], ["Ohlmeier", "Kai Henning"], ["Peters", "Christian"], ["Pöpsel", "Max"], ["Steinhoff", "Frederik"], ["Tadick", "Jens Günter"], ["Thien", "Christoph"], ["Thien", "Nicolas"], ["Wingen", "Malte"]];
  const cat = [["Ordnungsstrafe § 10 oder § 11", 0, true], ["Pumpe", 50], ["Stafette", 100], ["Klingelband berührt", 100], ["Hinterherlaufen erfolgreich", 150], ["Hinterherlaufen erfolglos", 150], ["Abkommen von der Bahn", 150], ["Kugel rollt zurück", 150], ["Kugel bleibt liegen", 150], ["Kugel bringen erfolgreich", 200], ["Kugel bringen erfolglos", 200], ["Unberechtigtes Betreten der Bahn", 100], ["Falsche Reihenfolge", 100], ["Vorsagen", 100], ["Betrug", 250], ["Mit zwei Händen kegeln", 50]];
  const b = writeBatch(db);
  names.forEach(([l, f]) => b.set(doc(db, "members", uid()), { last: l, first: f, active: true }));
  cat.forEach(([n, a, free], i) => b.set(doc(db, "catalog", uid()), { name: n, amount: a, free: !!free, order: i }));
  b.set(doc(db, "settings", "main"), { beitrag: 1500, extra: 250, iban: "DE67 4166 0124 0142 2061 07", bic: "GENODEM1LPS" });
  Object.entries(pins).forEach(([r, p]) => b.set(doc(db, "pins", p), { role: r }));
  await b.commit();
  return "ok";
}

// ---------- Start ----------
Object.assign(window, { closeSheet, runConfirm, pickRole, login, logout, go, newEvening, setMode, setActive, back, edit, toDraft, pd, delE, freeDlg, addFreeE, toggleAbs, addGuest, delGuest, askFinal, askUnfinal, makePdf, sharePdf, openPdf, askDelete, pay, unpay, addStart, saveSettings, catSet, catDel, catAdd, toggleMem, addMem, setPin, kickAll, setupSeed, createV, shareV, endV });
$("#roleBtn").onclick = openLogin;
let linkLogin = null;
{ const m = location.hash.match(/^#v-(schrift|kass)-(\d{4,})$/); if (m) { linkLogin = { r: m[1], pin: m[2] }; history.replaceState(null, "", location.pathname); } }
try { role = localStorage.getItem("kk-role"); } catch (e) { }
onAuthStateChanged(auth, async u => {
  if (u && role) {
    try { const s = await getDoc(doc(db, "sessions", u.uid)); if (s.exists() && s.data().role === role) { startListeners(); } else if (s.exists()) { role = s.data().role; startListeners(); } else role = null; }
    catch (e) { startListeners(); } // offline: Rolle aus dem Gerätespeicher
  } else if (!u) role = null;
  syncBar(); render();
  if (linkLogin) { const l = linkLogin; linkLogin = null; await doLogin(l.r, l.pin, true); }
});
syncBar(); render();
