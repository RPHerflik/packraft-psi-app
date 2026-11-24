"use strict";
// ============================================================================
// Historia ciśnienia i temperatury
//  - zapis próbek z telefonu (IndexedDB) z pozycją GPS, gdy aplikacja jest połączona,
//  - import aktywności z zegarka (plik .fit lub .zip z Garmin Connect),
//  - lista sesji, wykres, mapa (Leaflet + OpenStreetMap, wymaga internetu),
//  - eksport CSV i GPX.
// ============================================================================
const Hist = (() => {
  const DB_NAME = "pk-history";
  const S_SAMPLES = "samples";   // próbki z telefonu: {t, psi, temp, batt, lat, lon, acc}
  const S_IMPORTS = "imports";   // aktywności z zegarka: {id, name, t0, samples:[...]}
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const FIT_EPOCH_S = 631065600; // 1989-12-31T00:00:00Z

  let db = null;

  function openDb() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(S_SAMPLES, { keyPath: "t" });
        r.result.createObjectStore(S_IMPORTS, { keyPath: "id" });
      };
      r.onsuccess = () => { db = r.result; resolve(db); };
      r.onerror = () => reject(r.error);
    });
  }

  function tx(store, mode, fn) {
    return openDb().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const res = fn(t.objectStore(store));
      t.oncomplete = () => resolve(res && res.result !== undefined ? res.result : undefined);
      t.onerror = () => reject(t.error);
    }));
  }

  const put = (store, v) => tx(store, "readwrite", s => s.put(v));
  const getAll = store => tx(store, "readonly", s => s.getAll());
  const delRange = (t0, t1) => tx(S_SAMPLES, "readwrite", s => s.delete(IDBKeyRange.bound(t0, t1)));
  const delImport = id => tx(S_IMPORTS, "readwrite", s => s.delete(id));

  // -------------------------------------------------------------------------
  // Sesje
  // -------------------------------------------------------------------------
  function summarize(samples) {
    const ps = samples.map(s => s.psi).filter(v => v != null);
    const ts = samples.map(s => s.temp).filter(v => v != null);
    const inflated = ps.filter(v => v >= 0.3);
    return {
      t0: samples[0].t, t1: samples[samples.length - 1].t, n: samples.length,
      maxPsi: ps.length ? Math.max(...ps) : null,
      minPsi: inflated.length ? Math.min(...inflated) : null,
      maxTemp: ts.length ? Math.max(...ts) : null,
      minTemp: ts.length ? Math.min(...ts) : null,
      gps: samples.some(s => s.lat != null),
    };
  }

  function splitSessions(samples) {
    const out = [];
    let cur = [];
    for (const s of samples) {
      if (cur.length && s.t - cur[cur.length - 1].t > SESSION_GAP_MS) { out.push(cur); cur = []; }
      cur.push(s);
    }
    if (cur.length) out.push(cur);
    return out.map(arr => Object.assign(summarize(arr), { source: "phone", samples: arr, id: "p" + arr[0].t }));
  }

  async function listSessions() {
    const phone = splitSessions((await getAll(S_SAMPLES)).sort((a, b) => a.t - b.t));
    const watch = (await getAll(S_IMPORTS)).map(imp => Object.assign(summarize(imp.samples),
      { source: "watch", samples: imp.samples, id: imp.id, name: imp.name }));
    return phone.concat(watch).sort((a, b) => b.t0 - a.t0);
  }

  async function deleteSession(sess) {
    if (sess.source === "watch") await delImport(sess.id);
    else await delRange(sess.t0, sess.t1);
  }

  // -------------------------------------------------------------------------
  // Zapis z telefonu (co 10 s, z ostatnią pozycją GPS)
  // -------------------------------------------------------------------------
  let lastSaved = 0, geo = null, geoWatch = null;

  function startGps() {
    if (geoWatch != null || !navigator.geolocation) return;
    geoWatch = navigator.geolocation.watchPosition(
      p => { geo = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; },
      () => { geo = null; },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
  }

  function stopGps() {
    if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
  }

  function record(d) {
    const t = Date.now();
    if (d.psi == null || t - lastSaved < 10000) return;
    lastSaved = t;
    const fix = geo && t - geo.t < 60000 ? geo : null;
    put(S_SAMPLES, {
      t, psi: d.psi, temp: d.temp, batt: d.batt,
      lat: fix ? fix.lat : null, lon: fix ? fix.lon : null, acc: fix ? fix.acc : null,
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Import FIT (z zegarka: pole danych "Packraft PSI (pole)")
  // -------------------------------------------------------------------------
  const BASE = { 0: [1, "getUint8"], 1: [1, "getInt8"], 2: [1, "getUint8"], 0x83: [2, "getInt16"],
    0x84: [2, "getUint16"], 0x85: [4, "getInt32"], 0x86: [4, "getUint32"], 0x88: [4, "getFloat32"],
    0x89: [8, "getFloat64"], 0x8B: [2, "getUint16"], 0x8C: [4, "getUint32"], 10: [1, "getUint8"],
    13: [1, "getUint8"] };

  function parseFit(buf) {
    const dv = new DataView(buf);
    const hsize = dv.getUint8(0);
    if (String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)) !== ".FIT")
      throw new Error("To nie jest plik FIT");
    const end = hsize + dv.getUint32(4, true);
    const defs = {}, devNames = {}, samples = [];
    let pos = hsize, lastTs = 0;
    const read = (bt, at, size, le) => {
      const b = BASE[bt];
      if (!b || b[0] !== size) return null;
      return dv[b[1]](at, le);
    };
    while (pos < end) {
      const h = dv.getUint8(pos++);
      let local, compressedTs = null;
      if (h & 0x80) {                                  // nagłówek ze skompresowanym czasem
        local = (h >> 5) & 3;
        const off = h & 0x1F;
        compressedTs = (lastTs & ~0x1F) + off + (off < (lastTs & 0x1F) ? 0x20 : 0);
      } else if (h & 0x40) {                           // definicja
        local = h & 0x0F;
        const le = dv.getUint8(pos + 1) === 0;
        const gnum = dv.getUint16(pos + 2, le);
        const n = dv.getUint8(pos + 4);
        pos += 5;
        const fields = [];
        for (let i = 0; i < n; i++, pos += 3) fields.push([dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2)]);
        const devf = [];
        if (h & 0x20) {
          const nd = dv.getUint8(pos++);
          for (let i = 0; i < nd; i++, pos += 3) devf.push([dv.getUint8(pos), dv.getUint8(pos + 1)]);
        }
        defs[local] = { gnum, le, fields, devf };
        continue;
      } else {
        local = h & 0x0F;
      }
      const d = defs[local];
      if (!d) throw new Error("Uszkodzony plik FIT");
      const v = {};
      for (const [num, size, bt] of d.fields) {
        if (d.gnum === 206 && (num === 3 || num === 8)) {       // nazwa / jednostka pola deweloperskiego
          let s = "";
          for (let i = 0; i < size; i++) { const c = dv.getUint8(pos + i); if (!c) break; s += String.fromCharCode(c); }
          v[num] = s;
        } else {
          v[num] = read(bt, pos, size, d.le);
        }
        pos += size;
      }
      const dev = {};
      for (const [num, size] of d.devf) {
        if (size === 4) dev[num] = dv.getFloat32(pos, true);
        pos += size;
      }
      if (v[253] != null) lastTs = v[253];
      if (d.gnum === 206) devNames[v[1]] = v[3];
      if (d.gnum === 20) {
        const ts = v[253] != null ? v[253] : compressedTs;
        const named = {};
        for (const k in dev) named[devNames[k]] = dev[k];
        const okPos = v[0] != null && v[0] !== 0x7FFFFFFF && v[1] != null && v[1] !== 0x7FFFFFFF;
        samples.push({
          t: (ts + FIT_EPOCH_S) * 1000,
          psi: named.packraft_pressure != null ? named.packraft_pressure : null,
          temp: named.packraft_temperature != null ? named.packraft_temperature : null,
          lat: okPos ? v[0] * 180 / 2 ** 31 : null,
          lon: okPos ? v[1] * 180 / 2 ** 31 : null,
        });
      }
    }
    const withData = samples.filter(s => s.psi != null);
    if (!withData.length) throw new Error("W pliku nie ma danych z pola Packraft PSI");
    return withData;
  }

  // .zip z Garmin Connect ("Eksportuj plik oryginalny") - pierwszy plik .fit
  async function unzipFirstFit(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Nieprawidłowy plik ZIP");
    let p = dv.getUint32(eocd + 16, true);
    const count = dv.getUint16(eocd + 10, true);
    for (let e = 0; e < count; e++) {
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
      p += 46 + nlen + xlen + clen;
      if (!/\.fit$/i.test(name)) continue;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const comp = new Uint8Array(buf, start, csize);
      if (method === 0) return comp.slice().buffer;
      if (method !== 8 || typeof DecompressionStream === "undefined") throw new Error("Nieobsługiwana kompresja ZIP");
      const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).arrayBuffer();
    }
    throw new Error("W archiwum nie ma pliku .fit");
  }

  async function importFile(file) {
    let buf = await file.arrayBuffer();
    if (new DataView(buf).getUint32(0, true) === 0x04034b50) buf = await unzipFirstFit(buf);
    const samples = parseFit(buf);
    const id = "w" + samples[0].t;
    await put(S_IMPORTS, { id, name: file.name, t0: samples[0].t, samples });
    return id;
  }

  // -------------------------------------------------------------------------
  // Eksport
  // -------------------------------------------------------------------------
  const iso = t => new Date(t).toISOString();
  const num = (v, d) => v == null ? "" : v.toFixed(d);

  // CSV dla polskiego Excela: średnik jako separator, przecinek dziesiętny (tylko w liczbach)
  function toCsv(sess) {
    const n = (v, d) => num(v, d).replace(".", ",");
    const local = t => new Date(t).toLocaleString("sv-SE").replace(" ", "T");   // czas lokalny, ISO
    const rows = ["czas_lokalny;czas_utc;psi;temperatura_C;bateria_proc;szerokosc;dlugosc"];
    for (const s of sess.samples) {
      rows.push([local(s.t), iso(s.t), n(s.psi, 3), n(s.temp, 2), s.batt != null ? s.batt : "",
        n(s.lat, 6), n(s.lon, 6)].join(";"));
    }
    return rows.join("\r\n");
  }

  function toGpx(sess) {
    const pts = sess.samples.filter(s => s.lat != null).map(s =>
      `      <trkpt lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}"><time>${iso(s.t)}</time>` +
      `<extensions><pk:psi>${num(s.psi, 3)}</pk:psi><pk:temp>${num(s.temp, 2)}</pk:temp></extensions></trkpt>`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Packraft PSI" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:pk="https://rpherflik.github.io/packraft-psi-app/gpx">
  <trk><name>Packraft ${iso(sess.t0).slice(0, 16).replace("T", " ")}</name><trkseg>
${pts.join("\n")}
  </trkseg></trk>
</gpx>`;
  }

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function exportSession(sess, kind) {
    const base = "packraft_" + iso(sess.t0).slice(0, 16).replace(/[:T]/g, "-");
    if (kind === "csv") download(base + ".csv", "﻿" + toCsv(sess), "text/csv");
    else download(base + ".gpx", toGpx(sess), "application/gpx+xml");
  }

  return { record, startGps, stopGps, listSessions, deleteSession, importFile, exportSession, parseFit, put,
           S_SAMPLES };
})();
