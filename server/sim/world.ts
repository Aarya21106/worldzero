// World State Manager helpers: events + causality links, bounded memory, counters,
// and the shared labour primitives (hire / fire / close) every engine goes through.
import type { World, Citizen, Org, SimEvent, Building, BuildingKind, DistrictKind, OrgType } from './types';
import { clamp } from './types';
import { rand } from './rng';

export const isActive = (c: Citizen) => c.alive && !c.left;
export const isAdult = (c: Citizen) => c.age >= 18;
export const isMarketOrg = (o: Org) => o.type !== 'school' && o.type !== 'gov_department' && o.type !== 'nonprofit';
export const isPrivateFirm = (o: Org) => o.type === 'corporation' || o.type === 'startup' || o.type === 'small_business' || o.type === 'bank' || o.type === 'investment_firm' || o.type === 'media';

export function count(w: World, key: string, n = 1) { w.counters[key] = (w.counters[key] || 0) + n; }

export function money(n: number): string {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}Ƶ${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}Ƶ${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}Ƶ${(a / 1e3).toFixed(1)}k`;
  return `${s}Ƶ${Math.round(a).toLocaleString('en-US')}`;
}
export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Record a structured event. Causes are linked to recent interventions that touched the same system. */
export function emit(w: World, e: { cat: string; type: string; title: string; detail?: string; sev?: number; district?: number; entity?: string; why?: string; causes?: number[]; data?: Record<string, number | string> }): SimEvent {
  const causes = e.causes ? [...e.causes] : [];
  if (!e.causes && e.cat !== 'intervention') {
    for (let i = w.interventions.length - 1; i >= 0 && causes.length < 3; i--) {
      const iv = w.interventions[i];
      if (w.tick - iv.t > 360) break;
      if (iv.systems.includes(e.cat) || iv.systems.includes('all')) causes.push(iv.eventId);
    }
  }
  const ev: SimEvent = { id: w.nextEventId++, t: w.tick, cat: e.cat, type: e.type, title: e.title, detail: e.detail || '', sev: e.sev ?? 0.3, district: e.district ?? -1, entity: e.entity || '', causes, why: e.why || '', data: e.data };
  w.events.push(ev);
  if (w.events.length > 700) w.events.splice(0, w.events.length - 700);
  return ev;
}

/** Bounded agent memory: 8 short-term entries, 6 salient long-term entries. */
export function remember(w: World, c: Citizen, k: string, d: string, v: number) {
  c.mem.push({ t: w.tick, k, d, v });
  if (c.mem.length > 8) c.mem.shift();
  if (Math.abs(v) >= 0.6) {
    c.ltm.push({ t: w.tick, k, d, v });
    if (c.ltm.length > 6) c.ltm.shift();
  }
}
export function orgLog(w: World, o: Org, d: string) {
  o.log.push({ t: w.tick, d });
  if (o.log.length > 10) o.log.shift();
}

export function eduMult(edu: number) { return edu >= 4 ? 1.5 : edu === 3 ? 1.22 : edu === 2 ? 1.0 : 0.88; }

export function offerWage(w: World, o: Org, c: Citizen): number {
  const s = w.sectors[o.sector];
  return Math.round(Math.max(w.policy.minWage, s.baseWage * s.wageIdx * o.wageLevel * eduMult(c.edu) * (0.75 + 0.5 * c.skill)));
}

export function roleFor(o: Org, c: Citizen): string {
  const hi = c.edu >= 4, mid = c.edu === 3;
  switch (o.type) {
    case 'hospital': return hi ? 'Doctor' : mid ? 'Nurse' : 'Hospital staff';
    case 'university': return hi ? 'Professor' : mid ? 'Lecturer' : 'University staff';
    case 'school': return c.edu >= 3 ? 'Teacher' : 'School staff';
    case 'research_lab': return hi ? 'Researcher' : mid ? 'Research engineer' : 'Lab technician';
    case 'gov_department': return o.name.includes('Police') ? 'Police officer' : c.edu >= 3 ? 'Civil servant' : 'Public worker';
    case 'bank': return c.edu >= 3 ? 'Banker' : 'Bank clerk';
    case 'investment_firm': return c.edu >= 3 ? 'Investment analyst' : 'Office administrator';
    case 'media': return c.edu >= 3 ? 'Journalist' : 'Media technician';
    case 'nonprofit': return 'Community organiser';
  }
  switch (o.sector) {
    case 'tech': return hi ? 'Research scientist' : mid ? 'Software engineer' : 'Technician';
    case 'manufacturing': return c.edu >= 3 ? 'Engineer' : 'Factory worker';
    case 'construction': return c.edu >= 3 ? 'Site engineer' : 'Builder';
    case 'energy': return c.edu >= 3 ? 'Energy engineer' : 'Plant operator';
    case 'food': return c.edu >= 3 ? 'Food scientist' : 'Food worker';
    case 'retail': return c.edu >= 3 ? 'Retail manager' : 'Retail worker';
    case 'healthcare': return hi ? 'Doctor' : mid ? 'Nurse' : 'Care assistant';
    case 'finance': return 'Financial analyst';
    default: return c.edu >= 3 ? 'Consultant' : 'Service worker';
  }
}

export function hire(w: World, o: Org, c: Citizen, wage?: number) {
  if (c.employer >= 0 && c.employer !== o.id) {
    const old = w.orgs[c.employer];
    const i = old.employees.indexOf(c.id);
    if (i >= 0) old.employees.splice(i, 1);
  }
  c.employer = o.id; c.status = 'employed'; c.role = roleFor(o, c);
  c.wage = wage ?? offerWage(w, o, c);
  c.unempMonths = 0; c.seeking = false; c.tenure = 0; c.field = o.sector;
  c.refRealWage = c.wage / w.cpi;
  if (!o.employees.includes(c.id)) o.employees.push(c.id);
}

export function separate(w: World, o: Org, c: Citizen, kind: 'layoff' | 'closure' | 'resign') {
  const i = o.employees.indexOf(c.id);
  if (i >= 0) o.employees.splice(i, 1);
  const mi = o.managers.indexOf(c.id);
  if (mi >= 0) o.managers.splice(mi, 1);
  c.employer = -1; c.role = 'Unemployed'; c.status = c.age >= 65 ? 'retired' : 'unemployed'; c.tenure = 0;
  if (kind === 'resign' && o.alive && o.util > 0.88 && w.tick >= o.freezeUntil) o.openings++; // replacement hiring
  if (c.stakeOrg === o.id && kind === 'closure') c.stakeOrg = -1;
  if (kind !== 'resign') {
    c.happy = clamp(c.happy - 0.15); c.stress = clamp(c.stress + 0.25); c.trustBiz = clamp(c.trustBiz - 0.06);
    remember(w, c, 'job_loss', kind === 'closure' ? `Lost my job when ${o.name} closed` : `Laid off from ${o.name}`, -0.75);
    c.goal = 'find_job';
  }
}

export function closeOrg(w: World, o: Org, reason: string) {
  if (!o.alive) return;
  const n = o.employees.length;
  for (const id of [...o.employees]) separate(w, o, w.citizens[id], 'closure');
  o.alive = false; o.closed = w.tick; o.closeReason = reason; o.openings = 0; o.employees = [];
  if (o.owner >= 0) { const ow = w.citizens[o.owner]; if (ow.stakeOrg === o.id) ow.stakeOrg = -1; if (isActive(ow) && ow.status === 'owner') { ow.status = 'unemployed'; ow.role = 'Unemployed'; ow.employer = -1; remember(w, ow, 'business_failed', `My business ${o.name} failed`, -0.9); } }
  const b = w.buildings[o.building];
  if (b && b.orgs.every((id) => !w.orgs[id].alive)) b.status = 'vacant';
  count(w, 'org.closed'); count(w, `org.closed.${o.type}`); count(w, 'org.jobs_lost_closure', n);
  emit(w, { cat: 'business', type: 'closure', title: `${o.name} closes`, detail: `${typeLabel(o.type)} in ${o.sector} shut down, ${n} jobs lost.`, sev: clamp(0.25 + n / 120), district: o.district, entity: `org:${o.id}`, why: reason, data: { jobs: n } });
}

export function typeLabel(t: OrgType): string {
  return ({ corporation: 'Corporation', startup: 'Startup', small_business: 'Small business', bank: 'Bank', investment_firm: 'Investment firm', university: 'University', school: 'School', hospital: 'Hospital', research_lab: 'Research laboratory', gov_department: 'Government department', media: 'Media organisation', nonprofit: 'Non-profit' } as Record<OrgType, string>)[t];
}

const BKIND: Record<OrgType, BuildingKind> = { corporation: 'office', startup: 'office', small_business: 'commercial', bank: 'office', investment_firm: 'office', university: 'university', school: 'school', hospital: 'hospital', research_lab: 'lab', gov_department: 'government', media: 'office', nonprofit: 'commercial' };
const PREF: Record<OrgType, DistrictKind[]> = { corporation: ['business', 'industrial'], startup: ['business', 'research'], small_business: ['commercial', 'residential'], bank: ['business'], investment_firm: ['business'], university: ['university'], school: ['residential'], hospital: ['medical'], research_lab: ['research'], gov_department: ['government'], media: ['government', 'business'], nonprofit: ['commercial', 'government', 'medical'] };
const INDUSTRIAL: string[] = ['manufacturing', 'energy', 'construction'];

export function buildingHeightFor(w: World, b: Building): number {
  if (b.kind === 'residential') return 7 + b.units * (b.units > 6 ? 2.6 : 3.2);
  let emp = 0;
  for (const id of b.orgs) if (w.orgs[id].alive) emp += w.orgs[id].employees.length;
  switch (b.kind) {
    case 'office': return clamp(16 + emp * 1.25, 16, 230);
    case 'commercial': return clamp(9 + emp * 0.6, 9, 30);
    case 'industrial': return clamp(11 + emp * 0.12, 11, 26);
    case 'hospital': return clamp(22 + emp * 0.25, 22, 60);
    case 'university': return clamp(18 + emp * 0.2, 18, 46);
    case 'lab': return clamp(14 + emp * 0.7, 14, 44);
    case 'government': return clamp(20 + emp * 0.45, 20, 52);
    case 'school': return 11;
    default: return 14;
  }
}

/** Find (or build) premises for an organisation. Small tenants share buildings; others take a free lot. */
export function placeOrg(w: World, o: Org, opts: { nameHint?: string; construction?: boolean } = {}): boolean {
  const type = o.type;
  let kinds = PREF[type];
  let bkind = BKIND[type];
  if ((type === 'corporation' || type === 'small_business') && INDUSTRIAL.includes(o.sector)) { kinds = ['industrial']; bkind = 'industrial'; }
  if (type === 'corporation' && (o.sector === 'retail' || o.sector === 'food' || o.sector === 'services')) kinds = ['commercial', 'business'];
  if (type === 'small_business' && o.sector === 'healthcare') kinds = ['medical', 'commercial'];
  const shareable = type === 'small_business' || type === 'startup' || type === 'nonprofit' || type === 'investment_firm';
  if (shareable && rand(w) < 0.72) {
    const cands: Building[] = [];
    for (const b of w.buildings) {
      if (b.kind !== bkind || b.status === 'construction' || b.orgs.length >= 4) continue;
      if (!kinds.includes(w.districts[b.district].kind)) continue;
      if (b.orgs.some((id) => { const t = w.orgs[id].type; return t !== 'small_business' && t !== 'startup' && t !== 'nonprofit' && t !== 'investment_firm'; })) continue;
      cands.push(b);
    }
    if (cands.length) {
      const b = cands[Math.floor(rand(w) * cands.length)];
      b.orgs.push(o.id); if (b.status === 'vacant') b.status = 'active';
      o.building = b.id; o.district = b.district;
      return true;
    }
  }
  const b = newBuilding(w, bkind, kinds, { nameHint: opts.nameHint, construction: opts.construction, name: o.name });
  if (!b) {
    // city is full: share an existing building of the right kind rather than leaving the organisation homeless
    const any = w.buildings.find((x) => x.kind === bkind && x.status !== 'construction') || w.buildings.find((x) => x.kind !== 'residential' && x.status !== 'construction');
    if (!any) return false;
    any.orgs.push(o.id); if (any.status === 'vacant') any.status = 'active'; o.building = any.id; o.district = any.district;
    return true;
  }
  b.orgs.push(o.id); o.building = b.id; o.district = b.district;
  return true;
}

const FOOT: Record<BuildingKind, [number, number]> = { residential: [24, 24], commercial: [27, 23], office: [26, 26], industrial: [30, 28], university: [30, 28], school: [28, 24], hospital: [30, 28], lab: [27, 25], government: [29, 27], utility: [26, 26] };

export function newBuilding(w: World, kind: BuildingKind, districtKinds: DistrictKind[], opts: { nameHint?: string; construction?: boolean; name?: string; units?: number; district?: number } = {}): Building | null {
  let ds = w.districts.filter((d) => (opts.district !== undefined ? d.id === opts.district : districtKinds.includes(d.kind)) && d.lots.some((l) => !l.used));
  if (opts.nameHint) { const h = ds.filter((d) => d.name.includes(opts.nameHint!)); if (h.length) ds = h; }
  if (!ds.length) ds = w.districts.filter((d) => d.kind !== 'park' && d.lots.some((l) => !l.used));
  if (!ds.length) return null;
  const d = ds[Math.floor(rand(w) * ds.length)];
  const free = d.lots.filter((l) => !l.used);
  const lot = free[Math.floor(rand(w) * free.length)];
  lot.used = true;
  const [fw, fd] = FOOT[kind];
  const b: Building = { id: w.buildings.length, district: d.id, x: lot.x, z: lot.z, w: fw * (0.88 + rand(w) * 0.17), d: fd * (0.88 + rand(w) * 0.17), h: 12, kind, status: opts.construction ? 'construction' : 'active', units: opts.units || 0, occupied: 0, orgs: [], built: w.tick, readyAt: opts.construction ? w.tick + 60 : w.tick, name: opts.name || '' };
  w.buildings.push(b);
  return b;
}
