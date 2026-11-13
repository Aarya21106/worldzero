// Persistence Layer (SQLite via node:sqlite). World states are stored as gzipped JSON blobs;
// citizens and organisations of the active timeline are also mirrored into queryable tables.
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { World, SimEvent } from './sim/types';

const require2 = createRequire(import.meta.url);
export const pack = (w: World) => gzipSync(Buffer.from(JSON.stringify(w)), { level: 1 });
export const unpack = (b: Uint8Array): World => JSON.parse(gunzipSync(b).toString());

export interface TimelineRow { id: string; name: string; kind: string; parent: string | null; note: string; tick: number; created: number; metrics: Record<string, number>; history: any }
export interface SnapshotRow { id: string; timeline: string; tick: number; label: string; kind: string; created: number; metrics: Record<string, number> }

export class Store {
  db: any;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = require2('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS timelines(id TEXT PRIMARY KEY, name TEXT, kind TEXT, parent TEXT, note TEXT, tick INTEGER, created INTEGER, metrics TEXT, history TEXT, head BLOB);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, timeline TEXT, tick INTEGER, label TEXT, kind TEXT, created INTEGER, metrics TEXT, blob BLOB);
      CREATE TABLE IF NOT EXISTS events(timeline TEXT, id INTEGER, tick INTEGER, cat TEXT, type TEXT, title TEXT, data TEXT, PRIMARY KEY(timeline, id));
      CREATE TABLE IF NOT EXISTS chat(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, role TEXT, content TEXT);
      CREATE TABLE IF NOT EXISTS citizens(id INTEGER PRIMARY KEY, name TEXT, age INTEGER, status TEXT, role TEXT, employer INTEGER, household INTEGER, income REAL, savings REAL, debt REAL, alive INTEGER);
      CREATE TABLE IF NOT EXISTS organisations(id INTEGER PRIMARY KEY, name TEXT, type TEXT, sector TEXT, employees INTEGER, cash REAL, revenue REAL, alive INTEGER);`);
  }
  tx(fn: () => void) { this.db.exec('BEGIN'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  getMeta(k: string): string | null { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : null; }
  setMeta(k: string, v: string) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v); }

  saveTimeline(id: string, name: string, kind: string, parent: string | null, note: string, w: World) {
    this.db.prepare('INSERT INTO timelines(id,name,kind,parent,note,tick,created,metrics,history,head) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tick=excluded.tick, metrics=excluded.metrics, history=excluded.history, head=excluded.head')
      .run(id, name, kind, parent, note, w.tick, Date.now(), JSON.stringify(w.metrics), JSON.stringify(w.history), pack(w));
  }
  renameTimeline(id: string, name: string) { this.db.prepare('UPDATE timelines SET name=? WHERE id=?').run(name, id); }
  loadTimeline(id: string): World | null { const r = this.db.prepare('SELECT head FROM timelines WHERE id=?').get(id); return r ? unpack(r.head) : null; }
  timelines(): TimelineRow[] { return this.db.prepare('SELECT id,name,kind,parent,note,tick,created,metrics,history FROM timelines ORDER BY created').all().map((r: any) => ({ ...r, metrics: JSON.parse(r.metrics), history: JSON.parse(r.history) })); }
  deleteTimeline(id: string) { this.tx(() => { for (const t of ['snapshots', 'events']) this.db.prepare(`DELETE FROM ${t} WHERE timeline=?`).run(id); this.db.prepare('DELETE FROM timelines WHERE id=?').run(id); }); }

  addSnapshot(id: string, timeline: string, label: string, kind: string, w: World) { this.db.prepare('INSERT INTO snapshots(id,timeline,tick,label,kind,created,metrics,blob) VALUES(?,?,?,?,?,?,?,?)').run(id, timeline, w.tick, label, kind, Date.now(), JSON.stringify(w.metrics), pack(w)); }
  snapshots(timeline?: string): SnapshotRow[] { const q = 'SELECT id,timeline,tick,label,kind,created,metrics FROM snapshots'; const rows = timeline ? this.db.prepare(q + ' WHERE timeline=? ORDER BY created').all(timeline) : this.db.prepare(q + ' ORDER BY created').all(); return rows.map((r: any) => ({ ...r, metrics: JSON.parse(r.metrics) })); }
  loadSnapshot(id: string): { world: World; row: SnapshotRow } | null { const r = this.db.prepare('SELECT * FROM snapshots WHERE id=?').get(id); if (!r) return null; return { world: unpack(r.blob), row: { id: r.id, timeline: r.timeline, tick: r.tick, label: r.label, kind: r.kind, created: r.created, metrics: JSON.parse(r.metrics) } }; }
  deleteSnapshot(id: string) { this.db.prepare('DELETE FROM snapshots WHERE id=?').run(id); }
  pruneSnapshots(timeline: string, kind: string, keep: number) { const rows = this.db.prepare('SELECT id FROM snapshots WHERE timeline=? AND kind=? ORDER BY created DESC').all(timeline, kind); for (const r of rows.slice(keep)) this.deleteSnapshot(r.id); }

  appendEvents(timeline: string, evs: SimEvent[]) { if (!evs.length) return; const st = this.db.prepare('INSERT OR REPLACE INTO events(timeline,id,tick,cat,type,title,data) VALUES(?,?,?,?,?,?,?)'); this.tx(() => { for (const e of evs) st.run(timeline, e.id, e.t, e.cat, e.type, e.title, JSON.stringify(e)); }); }
  truncateEvents(timeline: string, afterTick: number) { this.db.prepare('DELETE FROM events WHERE timeline=? AND tick>?').run(timeline, afterTick); }
  events(timeline: string, o: { cat?: string; limit?: number; before?: number } = {}): SimEvent[] { const rows = this.db.prepare(`SELECT data FROM events WHERE timeline=? ${o.cat ? 'AND cat=?' : ''} ORDER BY id DESC LIMIT ?`).all(...(o.cat ? [timeline, o.cat, o.limit || 100] : [timeline, o.limit || 100])); return rows.map((r: any) => JSON.parse(r.data)); }

  addChat(role: string, content: any) { this.db.prepare('INSERT INTO chat(ts,role,content) VALUES(?,?,?)').run(Date.now(), role, JSON.stringify(content)); }
  chat(limit = 60): { ts: number; role: string; content: any }[] { return this.db.prepare('SELECT ts,role,content FROM chat ORDER BY seq DESC LIMIT ?').all(limit).reverse().map((r: any) => ({ ts: r.ts, role: r.role, content: JSON.parse(r.content) })); }

  mirror(w: World) {
    this.tx(() => {
      this.db.exec('DELETE FROM citizens; DELETE FROM organisations;');
      const c = this.db.prepare('INSERT INTO citizens VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const x of w.citizens) c.run(x.id, x.name, x.age, x.status, x.role, x.employer, x.hh, x.income, x.savings, x.debt, x.alive && !x.left ? 1 : 0);
      const o = this.db.prepare('INSERT INTO organisations VALUES(?,?,?,?,?,?,?,?)');
      for (const x of w.orgs) o.run(x.id, x.name, x.type, x.sector, x.employees.length, x.cash, x.revenue, x.alive ? 1 : 0);
    });
  }
  count(table: 'citizens' | 'organisations'): number { return this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; }
  close() { this.db.close(); }
}
