import { create } from 'zustand';

export const api = async (path: string, body?: any, method?: string) => {
  const r = await fetch('/api' + path, body !== undefined || method ? { method: method || 'POST', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
};

export interface ChatMsg { role: 'user' | 'god' | 'error'; content: any; ts: number }
interface S {
  status: any | null; cityStatic: any | null; city: any | null; events: any[];
  selected: string | null; inspector: any | null; focus: { x: number; z: number; n: number } | null;
  chat: ChatMsg[]; godBusy: boolean; godStage: { stage: string; detail?: string } | null;
  overlay: string; colorBy: string; panel: string | null; timelinesV: number; connected: boolean;
  select(ref: string | null, fly?: boolean): void; refreshInspector(): void; sendGod(text: string): void; control(action: string, value?: any): void;
  set(p: Partial<S>): void; loadCity(): Promise<void>; init(): void;
}

export const useStore = create<S>((set, get) => ({
  status: null, cityStatic: null, city: null, events: [], selected: null, inspector: null, focus: null,
  chat: [], godBusy: false, godStage: null, overlay: 'none', colorBy: 'status', panel: null, timelinesV: 0, connected: false,
  set: (p) => set(p),
  async loadCity() { const c = await api('/city'); set({ cityStatic: c.static, city: c.dynamic }); },
  async select(ref, fly = true) {
    if (!ref) return set({ selected: null, inspector: null });
    const [kind, id] = ref.split(':');
    try {
      const data = await api(`/${kind === 'org' ? 'org' : kind}/${id}`);
      set({ selected: ref, inspector: data });
      if (fly) { const p = locate(get(), ref, data); if (p) set({ focus: { ...p, n: Date.now() } }); }
    } catch { /* entity vanished */ }
  },
  refreshInspector() { const s = get().selected; if (s) get().select(s, false); },
  async sendGod(text) {
    if (get().godBusy) return;
    set((s) => ({ chat: [...s.chat, { role: 'user', content: { text }, ts: Date.now() }], godBusy: true, godStage: { stage: 'understand' } }));
    try {
      const r = await api('/god', { text });
      set((s) => ({ chat: [...s.chat, { role: 'god', content: r, ts: Date.now() }] }));
      if (r.focus) get().select(r.focus); else get().refreshInspector();
    } catch (e: any) { set((s) => ({ chat: [...s.chat, { role: 'error', content: { text: e.message }, ts: Date.now() }] })); }
    set((s) => ({ godBusy: false, godStage: null, timelinesV: s.timelinesV + 1 }));
  },
  async control(action, value) { try { set({ status: await api('/control', { action, value }) }); } catch { /* ignore */ } },
  init() {
    get().loadCity();
    api('/chat').then((c) => set({ chat: c }));
    api('/events?limit=60').then((e) => set({ events: e.reverse() }));
    const es = new EventSource('/api/stream');
    es.onopen = () => set({ connected: true });
    es.onerror = () => set({ connected: false });
    es.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type === 'tick') { const { events, type, ...st } = d; set((s) => ({ status: st, events: events?.length ? [...s.events, ...events].slice(-120) : s.events })); }
      else if (d.type === 'city') set({ city: d.city });
      else if (d.type === 'god') set({ godStage: d.stage === 'done' ? null : { stage: d.stage, detail: d.detail } });
      else if (d.type === 'replaced') { get().loadCity(); api('/events?limit=60').then((e) => set({ events: e.reverse() })); set({ selected: null, inspector: null }); }
      else if (d.type === 'timelines') set((s) => ({ timelinesV: s.timelinesV + 1 }));
    };
  },
}));

function locate(s: S, ref: string, data: any): { x: number; z: number } | null {
  const [kind, id] = ref.split(':'); const city = s.city, st = s.cityStatic; if (!city || !st) return null;
  const b = (bid: number) => { const r = city.buildings[bid]; return r ? { x: r[2], z: r[3] } : null; };
  if (kind === 'building') return b(Number(id));
  if (kind === 'district') { const d = st.districts[Number(id)]; return d ? { x: d.x, z: d.z } : null; }
  if (kind === 'org' && data?.building) return b(Number(data.building.split(':')[1]));
  if (kind === 'citizen') { const h = city.citizens.home[Number(id)]; return h >= 0 ? b(h) : null; }
  return null;
}

export const fmtMoney = (n: number) => { if (n === null || n === undefined || !isFinite(n)) return '—'; const a = Math.abs(n), s = n < 0 ? '−' : ''; return s + 'Ƶ' + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : Math.round(a).toLocaleString('en-US')); };
export const fmtPct = (n: number, d = 1) => (isFinite(n) ? (n * 100).toFixed(d) + '%' : '—');
export const fmtUnit = (unit: string, v: number) => unit === 'currency' ? fmtMoney(v) : unit === 'pct' ? fmtPct(v) : unit === 'int' ? Math.round(v).toLocaleString('en-US') : unit === 'index' ? (v >= 50 ? v.toFixed(0) : v.toFixed(2)) : v.toFixed(2);
