// World runtime: owns the active world, the simulation clock (independent of rendering),
// autosave, snapshots, rewind and alternate timelines.
import type { World } from './sim/types';
import { dateOf, SIM_VERSION } from './sim/types';
import { generateWorld, CELL, STREET_GAP } from './sim/generate';
import { tick } from './sim/tick';
import { computeMetrics } from './sim/metrics';
import { isActive } from './sim/world';
import { Store } from './db';
import { handleGod, type Host, type GodResult } from './god/service';
import { llmConfig } from './god/interpret';

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const BK = ['residential', 'commercial', 'office', 'industrial', 'university', 'school', 'hospital', 'lab', 'government', 'utility'];
const ST = ['child', 'student', 'employed', 'owner', 'unemployed', 'retired', 'inactive'];

export class Runtime implements Host {
  store: Store; world!: World; timelineId = 'main'; running = false; speed = 1; busy = false;
  listeners = new Set<(m: any) => void>();
  private acc = 0; private last = Date.now(); private lastCity = 0; private lastSave = Date.now(); private flushed = 0; private timer: any = null; cityVersion = 0;

  constructor(dbPath: string, private opts: { seed?: number; population?: number } = {}) { this.store = new Store(dbPath); }

  init() {
    const active = this.store.getMeta('active');
    const w = active ? this.store.loadTimeline(active) : null;
    if (w && w.v === SIM_VERSION) { this.world = w; this.timelineId = active!; this.speed = Number(this.store.getMeta('speed') || 1); this.running = this.store.getMeta('running') !== '0'; }
    else { if (w) for (const t of this.store.timelines()) this.store.deleteTimeline(t.id); this.world = generateWorld(this.opts.seed, this.opts.population); this.timelineId = 'main'; this.store.saveTimeline('main', 'Prime timeline', 'main', null, 'The original world', this.world); this.store.setMeta('active', 'main'); this.running = true; this.snapshot('Genesis', 'manual'); }
    this.flushed = this.world.nextEventId - 1;
    this.save();
    return this;
  }
  start() { this.last = Date.now(); this.timer = setInterval(() => this.loop(), 50); }
  stop() { clearInterval(this.timer); this.save(); }
  send(m: any) { for (const l of this.listeners) l(m); }

  private loop() {
    const now = Date.now(), dt = (now - this.last) / 1000; this.last = now;
    if (!this.running || this.busy) return;
    this.acc = Math.min(this.acc + this.speed * dt, Math.max(2, this.speed));
    const t0 = Date.now(); let n = 0;
    while (this.acc >= 1 && Date.now() - t0 < 35) { this.advance(); this.acc -= 1; n++; }
    if (n) this.pushTick();
    if (now - this.lastSave > 20000) this.save();
  }
  private advance() {
    const w = this.world; tick(w);
    if (w.tick % 30 === 0) { this.cityVersion++; if (w.tick % 90 === 0) { this.store.addSnapshot(uid('s'), this.timelineId, `Auto ${dateOf(w.tick)}`, 'auto', w); this.store.pruneSnapshots(this.timelineId, 'auto', 10); } }
    else if (w.health.diseases.some((d) => d.active) && w.tick % 3 === 0) this.cityVersion++;
  }
  stepDays(n: number) { if (this.busy) return; for (let i = 0; i < n; i++) this.advance(); this.cityVersion++; this.pushTick(true); }
  status() { const w = this.world; return { tick: w.tick, date: dateOf(w.tick), running: this.running, speed: this.speed, busy: this.busy, metrics: w.metrics, timeline: this.timelineId, cityVersion: this.cityVersion, llm: llmConfig(), name: w.name }; }
  pushTick(force = false) {
    const w = this.world, fresh = w.events.filter((e) => e.id > this.flushedSent).slice(-20);
    this.flushedSent = w.nextEventId - 1;
    this.send({ type: 'tick', ...this.status(), events: fresh });
    const now = Date.now();
    if (force || (this.cityVersion !== this.sentCity && now - this.lastCity > 900)) { this.sentCity = this.cityVersion; this.lastCity = now; this.send({ type: 'city', city: this.cityDynamic() }); }
  }
  private flushedSent = 0; private sentCity = -1;

  setRunning(r: boolean) { this.running = r; this.store.setMeta('running', r ? '1' : '0'); this.pushTick(); }
  setSpeed(s: number) { this.speed = Math.max(0.25, Math.min(400, s)); this.store.setMeta('speed', String(this.speed)); this.pushTick(); }

  save() {
    const w = this.world, rows = this.store.timelines().find((t) => t.id === this.timelineId);
    this.store.saveTimeline(this.timelineId, rows?.name || 'Prime timeline', rows?.kind || 'main', rows?.parent || null, rows?.note || '', w);
    this.store.appendEvents(this.timelineId, w.events.filter((e) => e.id > this.flushed)); this.flushed = w.nextEventId - 1;
    this.store.setMeta('active', this.timelineId); this.store.mirror(w); this.lastSave = Date.now();
  }
  touched() { this.cityVersion++; this.save(); this.pushTick(true); }

  snapshot(label: string, kind = 'manual'): string { const id = uid('s'); this.store.addSnapshot(id, this.timelineId, label, kind, this.world); if (kind === 'pre') this.store.pruneSnapshots(this.timelineId, 'pre', 12); return id; }
  /** Rewind: really restores the stored world state (not just the clock). */
  restore(snapshotId: string) {
    const s = this.store.loadSnapshot(snapshotId); if (!s) throw new Error('snapshot not found');
    if (s.row.timeline !== this.timelineId) { this.save(); this.timelineId = s.row.timeline; }
    this.world = s.world; this.store.truncateEvents(this.timelineId, s.world.tick); this.flushed = this.world.nextEventId - 1; this.flushedSent = this.flushed;
    this.replaced();
  }
  addTimeline(w: World, name: string, kind: string, note: string): string { const id = uid('t'); this.store.saveTimeline(id, name, kind, this.timelineId, note, w); this.store.appendEvents(id, w.events.slice(-200)); this.send({ type: 'timelines' }); return id; }
  branch(snapshotId: string | null, name: string, switchTo: boolean): string {
    const w = snapshotId ? this.store.loadSnapshot(snapshotId)?.world : structuredClone(this.world); if (!w) throw new Error('snapshot not found');
    const id = this.addTimeline(w, name || `Branch ${dateOf(w.tick)}`, 'branch', snapshotId ? 'Branched from snapshot' : 'Branched from the live world');
    if (switchTo) this.switchTimeline(id);
    return id;
  }
  switchTimeline(id: string) { if (id === this.timelineId) return; const w = this.store.loadTimeline(id); if (!w) throw new Error('timeline not found'); this.save(); this.world = w; this.timelineId = id; this.flushed = w.nextEventId - 1; this.flushedSent = this.flushed; this.replaced(); }
  deleteTimeline(id: string) { if (id === this.timelineId || id === 'main') throw new Error('cannot delete the active or prime timeline'); this.store.deleteTimeline(id); this.send({ type: 'timelines' }); }
  private replaced() { computeMetrics(this.world); this.acc = 0; this.cityVersion++; this.save(); this.send({ type: 'replaced' }); this.pushTick(true); this.send({ type: 'timelines' }); }

  timelines() { this.save(); const tl = this.store.timelines().map(({ history, ...t }) => t); return { active: this.timelineId, timelines: tl, snapshots: this.store.snapshots() }; }
  compare(a: string, b: string) { this.save(); const all = this.store.timelines(); const A = all.find((t) => t.id === a), B = all.find((t) => t.id === b); if (!A || !B) throw new Error('timeline not found'); const pickT = (t: any) => ({ id: t.id, name: t.name, tick: t.tick, date: dateOf(t.tick), metrics: t.metrics, history: t.history }); return { a: pickT(A), b: pickT(B) }; }

  async god(text: string): Promise<GodResult> {
    if (this.busy) throw new Error('GOD MODE is still processing the previous instruction');
    this.busy = true; this.store.addChat('user', { text });
    try {
      const r = await handleGod(this, text, (stage, detail) => this.send({ type: 'god', stage, detail }));
      this.store.addChat('god', r); this.send({ type: 'god', stage: 'done' });
      return r;
    } finally { this.busy = false; this.last = Date.now(); this.pushTick(true); }
  }

  cityStatic() { const w = this.world; return { name: w.name, geo: { riverX: w.mods['geo.riverX'] ?? 0, riverW: w.mods['geo.riverW'] ?? 0, cell: CELL, street: STREET_GAP - 6 }, districts: w.districts.map((d) => ({ id: d.id, name: d.name, kind: d.kind, wealth: d.wealth, x: d.x, z: d.z, w: d.w, d: d.d })), buildingKinds: BK, statuses: ST }; }
  cityDynamic() {
    const w = this.world, n = w.citizens.length;
    const home = new Array(n), work = new Array(n), st = new Array(n), tier = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = w.citizens[i];
      if (!isActive(c)) { st[i] = 255; home[i] = -1; work[i] = -1; tier[i] = 0; continue; }
      const h = w.households[c.hh]; home[i] = h.building; tier[i] = c.tier;
      const place = c.employer >= 0 ? c.employer : c.school; work[i] = place >= 0 ? w.orgs[place].building : -1;
      st[i] = c.inf === 2 || c.inf === 3 ? 7 : c.protest ? 8 : ST.indexOf(c.status);
    }
    return {
      version: this.cityVersion, tick: w.tick,
      buildings: w.buildings.map((b) => [b.id, b.district, Math.round(b.x), Math.round(b.z), Math.round(b.w), Math.round(b.d), Math.round(b.h), BK.indexOf(b.kind), b.status === 'active' ? 0 : b.status === 'vacant' ? 1 : 2, b.units, b.occupied, b.orgs.filter((id) => w.orgs[id].alive).length, b.built, b.orgs.reduce((n, id) => n + (w.orgs[id].alive ? w.orgs[id].employees.length : 0), 0)]),
      citizens: { home, work, st, tier },
      districts: w.districts.map((d) => ({ id: d.id, pop: d.pop, unemp: d.unemp, crime: d.crime, rent: d.rentIdx, income: d.avgIncome, infected: d.infected, protest: d.protest, happy: d.happy })),
      civic: w.districts.find((d) => d.kind === 'government')!.id,
    };
  }
}
