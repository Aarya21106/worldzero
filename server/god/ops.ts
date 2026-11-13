// Operation registry + Simulation Plan Validator. Natural language never touches state directly:
// an interpreter emits a typed plan, every operation is validated here, and only then applied by the engine.
// New capabilities = new registry entries (operations, events, parameters). No command list anywhere.
import type { World, Org, Citizen, OrgType, Sector, Household } from '../sim/types';
import { SECTORS, ORG_TYPES, clamp } from '../sim/types';
import { rand, shuffle, pick, randInt } from '../sim/rng';
import { isActive, emit, count, closeOrg, separate, hire, placeOrg, money, pct, typeLabel, remember, buildingHeightFor } from '../sim/world';
import { PARAMS, paramByKey, formatValue } from './params';
import { startDisease } from '../sim/health';
import { createBreakthrough, TECH_DOMAINS } from '../sim/technology';
import { startShock, immigrate, emigrateHousehold, killCitizen } from '../sim/social';
import { election } from '../sim/government';
import { layoff } from '../sim/economy';
import { makeOrg, newCitizen, newHousehold, houseHousehold } from '../sim/generate';
import { evict } from '../sim/housing';
import { personName } from '../sim/names';

export interface PlanOp { op: string; args: Record<string, any>; note?: string }
export interface Plan {
  mode: 'direct' | 'hypothetical' | 'query';
  summary: string; assumptions: string[]; operations: PlanOp[]; horizonDays?: number;
  unsupported: { text: string; reason: string }[]; source: 'llm' | 'fallback'; model?: string;
}
export interface OpResult { op: string; ok: boolean; summary: string; details: string[]; affected: Record<string, any>; systems: string[]; focus?: string; error?: string }
export interface OpCtx { eventId: number }
interface OpDef { name: string; desc: string; args: string; systems(args: any): string[]; validate(w: World, args: any, notes: string[]): string | null; apply(w: World, args: any, ctx: OpCtx): Omit<OpResult, 'op' | 'ok' | 'systems'> }

const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : NaN);
const asSector = (s: any): Sector | undefined => (typeof s === 'string' && (SECTORS as readonly string[]).includes(s.toLowerCase()) ? (s.toLowerCase() as Sector) : undefined);

// ---------------------------------------------------------------- filters
export function matchOrgs(w: World, f: any = {}): Org[] {
  const types: string[] | null = f.type ? (Array.isArray(f.type) ? f.type : [f.type]) : null;
  const dn = f.district ? String(f.district).toLowerCase() : null, nm = f.name ? String(f.name).toLowerCase() : null;
  return w.orgs.filter((o) => o.alive && (!types || types.includes(o.type)) && (!f.sector || o.sector === f.sector) && (!dn || w.districts[o.district].name.toLowerCase().includes(dn)) && (!nm || o.name.toLowerCase().includes(nm)) && (f.listed === undefined || o.listed === !!f.listed) && (f.minEmployees === undefined || o.employees.length >= f.minEmployees) && (f.maxEmployees === undefined || o.employees.length <= f.maxEmployees));
}
const GROUP: Record<string, number> = { low: 0, poor: 0, middle: 1, high: 2, rich: 2, top: 3 };
export function matchCitizens(w: World, f: any = {}): Citizen[] {
  const g = f.group && f.group !== 'all' ? GROUP[String(f.group).toLowerCase()] : undefined;
  const dn = f.district ? String(f.district).toLowerCase() : null, oc = f.occupation ? String(f.occupation).toLowerCase() : null, nm = f.name ? String(f.name).toLowerCase() : null;
  return w.citizens.filter((c) => {
    if (!isActive(c)) return false;
    if (g !== undefined && (g === 2 ? c.tier < 2 : c.tier !== g)) return false;
    if (f.status && c.status !== f.status) return false;
    if (oc && !c.role.toLowerCase().includes(oc)) return false;
    if (nm && !c.name.toLowerCase().includes(nm)) return false;
    if (dn && !w.districts[w.households[c.hh].district]?.name.toLowerCase().includes(dn)) return false;
    if (f.minAge !== undefined && c.age < f.minAge) return false;
    if (f.maxAge !== undefined && c.age > f.maxAge) return false;
    if (f.minEducation !== undefined && c.edu < f.minEducation) return false;
    if (f.sector && !(c.employer >= 0 && w.orgs[c.employer].sector === f.sector)) return false;
    if (f.employerType && !(c.employer >= 0 && w.orgs[c.employer].type === f.employerType)) return false;
    return true;
  });
}
const describeFilter = (f: any) => { const p = Object.entries(f || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`); return p.length ? p.join(', ') : 'all'; };

function applyMode(before: number, mode: string, value: number): number { return mode === 'multiply' ? before * value : mode === 'add' ? before + value : value; }

// ---------------------------------------------------------------- events
interface EvDef { desc: string; args: string; systems: string[]; run(w: World, a: any, ctx: OpCtx): Omit<OpResult, 'op' | 'ok' | 'systems'> }
const COUNTRIES = ['Valdoria', 'the Kestrel Republic', 'Ostmark', 'the Sunder Union', 'Nareth', 'Calvessa', 'the Ilyrian League', 'Tarsis'];
const sevOf = (a: any, d = 0.5) => clamp(isNaN(num(a?.severity)) ? d : num(a.severity), 0.05, 1);

export const EVENTS: Record<string, EvDef> = {
  disease_outbreak: { desc: 'A fictional infectious disease starts spreading through households, workplaces and districts', args: '{name?, severity 0-1 (how dangerous), contagion 0-1 (how fast it spreads), seeds? (initial cases)}', systems: ['health', 'economy', 'social', 'labor', 'business', 'politics'],
    run(w, a, ctx) { const seeds = isNaN(num(a.seeds)) ? Math.round(12 * (w.mods.scale ?? 1)) : clamp(Math.round(num(a.seeds)), 1, 5000);
      const d = startDisease(w, { name: a.name, severity: sevOf(a), contagion: isNaN(num(a.contagion)) ? 0.5 : clamp(num(a.contagion), 0.05, 1), seeds });
      emit(w, { cat: 'health', type: 'outbreak_start', title: `${d.name} detected`, detail: `First cases confirmed. Estimated hospitalisation rate ${pct(d.severity)}, case fatality among severe cases up to ${pct(d.mortality * 1.5, 0)}.`, sev: 0.6, causes: [ctx.eventId], district: w.districts.find((x) => x.kind === 'medical')!.id });
      return { summary: `Fictional disease “${d.name}” introduced (${seeds} initial cases)`, details: [`transmissibility β=${d.beta.toFixed(2)}, incubation ${d.incubation} days, infectious ${d.duration} days`, `hospitalisation rate ${pct(d.severity)}, hospital beds available: ${w.health.beds}`], affected: { citizens: w.metrics.population, hospitals: w.orgs.filter((o) => o.alive && o.type === 'hospital').length } }; } },
  tech_breakthrough: { desc: 'A new technology emerges and starts diffusing (changes productivity, automation, health or energy use)', args: `{name?, domain? one of ${TECH_DOMAINS.join('|')}, magnitude? 0.2-3 (1 = major)}`, systems: ['technology', 'business', 'labor', 'economy', 'market'],
    run(w, a) { const t = createBreakthrough(w, { name: a.name, domain: a.domain, magnitude: isNaN(num(a.magnitude)) ? 1 : num(a.magnitude), origin: 'intervention', adoption: isNaN(num(a.adoption)) ? undefined : num(a.adoption) });
      return { summary: `Technology “${t.name}” (${t.domain}) emerges`, details: [`productivity effects at full adoption: ${Object.entries(t.productivity).map(([s, v]) => `${s} +${pct(v as number, 0)}`).join(', ') || 'none'}`, `automation effects: ${Object.entries(t.automation).map(([s, v]) => `${s} +${pct(v as number, 0)} output/worker`).join(', ') || 'none'}`, `starting adoption ${pct(t.adoption, 0)}, diffusion speed ${t.speed.toFixed(2)}/month`], affected: { sectors: Object.keys(t.productivity).length, technologies: 1 } }; } },
  market_crash: { desc: 'Share prices fall sharply and confidence collapses', args: '{severity 0-1 (0.5 ≈ -40%)}', systems: ['market', 'business', 'economy', 'labor'],
    run(w, a) { const s = sevOf(a), drop = 0.15 + 0.5 * s; const def = paramByKey('market.sharePrices')!; const before = def.get(w); def.set(w, before * (1 - drop)); w.market.vc *= 1 - 0.5 * s; w.market.credit = clamp(w.market.credit * (1 - 0.3 * s), 0.05, 1.5);
      const holders = w.citizens.filter((c) => isActive(c) && c.equity > 0).length;
      return { summary: `Stock market crash: index ${before.toFixed(0)} → ${w.market.index.toFixed(0)} (−${pct(drop, 0)})`, details: [`confidence now ${w.market.confidence.toFixed(2)}`, `venture appetite ×${(1 - 0.5 * s).toFixed(2)}, credit ${w.market.credit.toFixed(2)}`], affected: { listedCompanies: w.orgs.filter((o) => o.alive && o.listed).length, shareholders: holders } }; } },
  war: { desc: 'A war between two fictional foreign countries disrupts trade, raises import prices and displaces refugees toward the city', args: '{countries? [a,b], severity 0-1, days? duration}', systems: ['external', 'economy', 'business', 'market', 'population', 'social'],
    run(w, a, ctx) { const s = sevOf(a, 0.6); const cs: string[] = Array.isArray(a.countries) && a.countries.length >= 2 ? a.countries.map(String) : shuffle(w, [...COUNTRIES]).slice(0, 2); const days = isNaN(num(a.days)) ? 540 : clamp(Math.round(num(a.days)), 30, 3600);
      const sh = startShock(w, { name: `war between ${cs[0]} and ${cs[1]}`, kind: 'war', days, severity: s, exportMult: 1 - 0.4 * s, importPrice: { energy: 1 + 0.5 * s, food: 1 + 0.25 * s }, confidence: -0.3 * s, migrants: Math.round(90 * s * (w.mods.scale ?? 1)), note: 'trade disruption' });
      emit(w, { cat: 'external', type: 'war', title: `War breaks out between ${cs[0]} and ${cs[1]}`, detail: `Export orders fall ${pct(0.4 * s, 0)}, energy imports cost ${pct(0.5 * s, 0)} more, food ${pct(0.25 * s, 0)} more. Refugees expected.`, sev: 0.5 + s * 0.4, causes: [ctx.eventId] });
      return { summary: `War between ${cs[0]} and ${cs[1]} (fictional) — lasts ~${Math.round(days / 30)} months`, details: [`export demand ×${sh.exportMult.toFixed(2)}`, `energy prices ×${(1 + 0.5 * s).toFixed(2)}, food prices ×${(1 + 0.25 * s).toFixed(2)}`, `~${sh.migrants} refugee households expected`], affected: { exporters: w.orgs.filter((o) => o.alive && w.sectors[o.sector].exports > 0).length, households: w.metrics.households } }; } },
  natural_disaster: { desc: 'A natural disaster damages buildings, businesses and infrastructure in a district', args: '{kind? e.g. earthquake/flood, severity 0-1, district? name}', systems: ['housing', 'business', 'social', 'economy', 'health', 'population'],
    run(w, a, ctx) { const s = sevOf(a, 0.6); const dn = a.district ? String(a.district).toLowerCase() : ''; const d = w.districts.find((x) => dn && x.name.toLowerCase().includes(dn)) || pick(w, w.districts.filter((x) => x.kind === 'residential' || x.kind === 'commercial'));
      let damaged = 0, closed = 0, evicted = 0, deaths = 0;
      for (const b of w.buildings) { if (b.district !== d.id || rand(w) > s * 0.6) continue; damaged++;
        if (b.kind === 'residential') { const lost = Math.ceil(b.units * 0.5); b.units = Math.max(1, b.units - lost); b.h = buildingHeightFor(w, b); const hs = w.households.filter((h) => h.alive && h.building === b.id); for (const h of hs.slice(0, Math.max(0, b.occupied - b.units))) { evict(w, h, `${a.kind || 'disaster'} destroyed the home`); evicted++; } }
        else for (const id of b.orgs) { const o = w.orgs[id]; if (!o.alive) continue; o.cash -= o.expenses * (1 + rand(w) * 3) * s; if (rand(w) < s * 0.35 && (o.type === 'small_business' || o.type === 'startup')) { closeOrg(w, o, `premises destroyed by the ${a.kind || 'disaster'}`); closed++; } } }
      for (const c of w.citizens) if (isActive(c) && w.households[c.hh].district === d.id && rand(w) < s * 0.006) { killCitizen(w, c, a.kind || 'disaster'); deaths++; }
      w.infra.quality = clamp(w.infra.quality - 0.25 * s, 0.2, 1.5);
      emit(w, { cat: 'social', type: 'disaster', title: `${(a.kind || 'Disaster').replace(/^./, (x: string) => x.toUpperCase())} strikes ${d.name}`, detail: `${damaged} buildings damaged, ${closed} businesses destroyed, ${evicted} households displaced, ${deaths} deaths.`, sev: 0.5 + s * 0.45, district: d.id, causes: [ctx.eventId] });
      return { summary: `${a.kind || 'Natural disaster'} hits ${d.name}: ${damaged} buildings damaged`, details: [`${evicted} households displaced, ${closed} businesses destroyed, ${deaths} deaths`, `infrastructure quality now ${w.infra.quality.toFixed(2)}`], affected: { buildings: damaged, households: evicted, orgs: closed, citizens: d.pop }, focus: `district:${d.id}` }; } },
  housing_crisis: { desc: 'Homes are withdrawn from the market and rents jump', args: '{severity 0-1}', systems: ['housing', 'social', 'economy', 'population'],
    run(w, a) { const s = sevOf(a, 0.6); const H = w.housing; const b0 = H.supplyMult, r0 = w.prices.housing; H.supplyMult = clamp(H.supplyMult * (1 - 0.22 * s), 0.2, 3); w.prices.housing *= 1 + 0.6 * s; H.propertyIdx *= 1 + 0.4 * s;
      const renters = w.households.filter((h) => h.alive && !h.owns).length;
      return { summary: `Housing crisis: usable housing stock ${pct(b0, 0)} → ${pct(H.supplyMult, 0)}, rents ×${(1 + 0.6 * s).toFixed(2)}`, details: [`rent index ${r0.toFixed(2)} → ${w.prices.housing.toFixed(2)}`, `${renters} renting households exposed`], affected: { households: renters, buildings: w.buildings.filter((b) => b.kind === 'residential').length } }; } },
  financial_crisis: { desc: 'Banks lose capital, credit freezes, markets fall', args: '{severity 0-1}', systems: ['market', 'business', 'economy', 'labor'],
    run(w, a) { const s = sevOf(a, 0.6); const banks = w.orgs.filter((o) => o.alive && o.type === 'bank'); for (const b of banks) b.cash -= Math.abs(b.cash) * 0.8 * s + b.expenses * 2 * s; const c0 = w.market.credit; w.market.credit = clamp(w.market.credit * (1 - 0.8 * s), 0.03, 1.5); const def = paramByKey('market.sharePrices')!; const i0 = def.get(w); def.set(w, i0 * (1 - 0.3 * s)); w.market.vc *= 1 - 0.6 * s;
      return { summary: `Financial crisis: credit availability ${c0.toFixed(2)} → ${w.market.credit.toFixed(2)}, index −${pct(0.3 * s, 0)}`, details: [`${banks.length} banks lost most of their capital buffers`, `venture appetite ×${(1 - 0.6 * s).toFixed(2)}`], affected: { banks: banks.length, borrowers: w.orgs.filter((o) => o.alive && o.debt > 0).length } }; } },
  energy_crisis: { desc: 'Energy supply drops and energy prices spike', args: '{severity 0-1}', systems: ['economy', 'business', 'social'],
    run(w, a) { const s = sevOf(a, 0.6); const c0 = w.infra.energyCap; w.infra.energyCap = clamp(c0 * (1 - 0.5 * s), 0.05, 20); const def = paramByKey('price.energy')!; const p0 = def.get(w); def.set(w, p0 * (1 + s));
      return { summary: `Energy crisis: supply ×${(1 - 0.5 * s).toFixed(2)}, energy prices ${p0.toFixed(2)} → ${w.prices.energy.toFixed(2)}`, details: [`grid load now ${pct(w.infra.energyUse * c0 / w.infra.energyCap, 0)} of capacity`], affected: { households: w.metrics.households, orgs: w.metrics.organisations } }; } },
  corruption_scandal: { desc: 'A government corruption scandal erodes public trust', args: '{severity 0-1}', systems: ['politics', 'social'],
    run(w, a, ctx) { const s = sevOf(a, 0.6); w.mods.corruption = clamp((w.mods.corruption || 0) + 0.7 * s, 0, 1); const def = paramByKey('social.trustGov')!; const t0 = def.get(w); def.set(w, t0 * (1 - 0.45 * s));
      emit(w, { cat: 'politics', type: 'scandal', title: 'Corruption scandal engulfs the government', detail: `Public trust falls from ${pct(t0, 0)} to ${pct(def.get(w), 0)}.`, sev: 0.5 + s * 0.3, causes: [ctx.eventId], district: w.districts.find((x) => x.kind === 'government')!.id });
      return { summary: `Corruption scandal: trust in government ${pct(t0, 0)} → ${pct(def.get(w), 0)}`, details: [`perceived corruption ${pct(w.mods.corruption, 0)} (keeps eroding trust monthly)`], affected: { citizens: w.metrics.adults } }; } },
  migration_wave: { desc: 'A wave of newcomers arrives', args: '{households (count), skilled? boolean}', systems: ['population', 'labor', 'housing'],
    run(w, a) { const n = isNaN(num(a.households)) ? Math.round(150 * (w.mods.scale ?? 1)) : clamp(Math.round(num(a.households)), 1, 3000); const people = immigrate(w, n, { skilled: !!a.skilled, reason: a.reason });
      return { summary: `${people} newcomers settled (${n} households attempted${a.skilled ? ', skilled' : ''})`, details: [people < n ? `only ${people} people found housing — vacancy is ${pct(w.housing.vacancy)}` : `housing vacancy now being absorbed`], affected: { citizens: people } }; } },
  exodus: { desc: 'A share of households leaves the city', args: '{fraction 0-1, group? low|middle|high|top}', systems: ['population', 'labor', 'housing', 'business'],
    run(w, a) { const f = isNaN(num(a.fraction)) ? 0.1 : clamp(num(a.fraction), 0.001, 0.95); let hs = w.households.filter((h) => h.alive); if (a.group && GROUP[a.group] !== undefined) hs = hs.filter((h) => h.members.some((id) => w.citizens[id].tier === GROUP[a.group] || (GROUP[a.group] === 2 && w.citizens[id].tier >= 2))); const n = Math.round(hs.length * f); const before = w.social.migOut; for (const h of shuffle(w, hs).slice(0, n)) emigrateHousehold(w, h, 'exodus');
      return { summary: `${w.social.migOut - before} people in ${n} households left the city`, details: [], affected: { households: n, citizens: w.social.migOut - before } }; } },
  snap_election: { desc: 'An election is held immediately', args: '{}', systems: ['politics'],
    run(w) { const before = w.gov.parties[w.gov.party].name; election(w); const p = w.gov.parties[w.gov.party]; return { summary: `Snap election: ${p.name} ${p.name === before ? 're-elected' : `defeats ${before}`}`, details: w.gov.parties.map((x) => `${x.name}: ${pct(x.support, 0)}`), affected: { citizens: w.metrics.adults } }; } },
};

// ---------------------------------------------------------------- operations
const ORG_FIELDS = ['cash', 'funding', 'debt', 'sharePrice', 'wages', 'productivity', 'reputation', 'headcount'];
const CIT_FIELDS = ['savings', 'debt', 'wage', 'health', 'trustGov', 'happiness', 'skill', 'equity', 'income'];
const DEFAULT_STAFF: Record<OrgType, number> = { corporation: 60, startup: 6, small_business: 4, bank: 18, investment_firm: 8, university: 45, school: 18, hospital: 70, research_lab: 16, gov_department: 25, media: 12, nonprofit: 6 };

export const OPS: Record<string, OpDef> = {
  adjust_parameter: { name: 'adjust_parameter', desc: 'Change a world parameter (prices, taxes, policies, markets, trust, technology, infrastructure...)', args: '{target: <parameter key>, mode: "multiply"|"add"|"set", value: number, sector?: <sector>}  — rates/shares are fractions (0.05 = 5 percentage points); multiply 1.2 = +20%, 3 = +200%',
    systems: (a) => paramByKey(a.target)?.systems || [],
    validate(w, a, notes) {
      const def = paramByKey(a.target); if (!def) return `unknown parameter “${a.target}”`;
      if (!['multiply', 'add', 'set'].includes(a.mode)) return `mode must be multiply, add or set`;
      a.value = num(a.value); if (isNaN(a.value)) return 'value must be a number';
      if (a.mode === 'multiply' && a.value < 0) return 'cannot multiply by a negative number';
      if (a.sector) { const s = asSector(a.sector); if (!s) { notes.push(`Unknown sector “${a.sector}” ignored for ${def.label}.`); delete a.sector; } else if (!def.sectorScoped) { notes.push(`${def.label} is not sector-specific; applied city-wide.`); delete a.sector; } else a.sector = s; }
      const before = def.get(w, a.sector), raw = applyMode(before, a.mode, a.value);
      if ((def.unit === 'rate' || def.unit === 'share') && a.mode !== 'multiply' && Math.abs(a.value) > 1.5) { a.value = a.value / 100; notes.push(`${def.label}: interpreted ${a.value * 100} as a percentage.`); }
      if (raw < def.min || raw > def.max) notes.push(`${def.label}: requested ${formatValue(def.unit, raw)} is outside the engine’s range and was limited to ${formatValue(def.unit, clamp(raw, def.min, def.max))}.`);
      return null; },
    apply(w, a) {
      const def = paramByKey(a.target)!; const before = def.get(w, a.sector);
      const belowMin = a.target === 'policy.minWage' ? 0 : 0;
      const after = clamp(applyMode(before, a.mode, a.value), def.min, def.max);
      let lifted = belowMin;
      if (a.target === 'policy.minWage') lifted = w.citizens.filter((c) => isActive(c) && c.status === 'employed' && c.wage < after).length;
      def.set(w, after, a.sector);
      if (def.lock) w.gov.locks[def.lock] = w.tick + 720;
      const now = def.get(w, a.sector);
      const affected: Record<string, number> = {};
      if (a.target.startsWith('price.')) { affected.households = w.metrics.households; const g = a.target.slice(6); affected.orgs = w.orgs.filter((o) => o.alive && (g === 'all' || o.sector === g)).length; }
      else if (a.target === 'policy.minWage') affected.workers = lifted;
      else if (a.target === 'funding.startups') affected.startups = w.orgs.filter((o) => o.alive && o.type === 'startup' && (!a.sector || o.sector === a.sector)).length;
      else if (a.target === 'market.sharePrices') { affected.listedCompanies = w.orgs.filter((o) => o.alive && o.listed && (!a.sector || o.sector === a.sector)).length; affected.shareholders = w.citizens.filter((c) => isActive(c) && c.equity > 0).length; }
      else if (a.target === 'wages.all') affected.workers = w.citizens.filter((c) => isActive(c) && (c.status === 'employed' || c.status === 'owner') && (!a.sector || (c.employer >= 0 && w.orgs[c.employer].sector === a.sector))).length;
      else if (a.target === 'policy.corporateTax') affected.orgs = w.metrics.businesses;
      else if (a.target === 'policy.tuitionSubsidy' || a.target === 'edu.tuition') { affected.students = w.metrics.students; affected.universities = w.orgs.filter((o) => o.alive && o.type === 'university').length; }
      else affected.citizens = w.metrics.population;
      const details: string[] = [];
      if (a.target === 'policy.minWage') details.push(`${lifted} workers currently earn less than the new minimum and will be lifted to it`);
      if (def.lock) details.push('decree locked for 2 years: the autonomous government will not reverse it');
      return { summary: `${def.label}${a.sector ? ` (${a.sector})` : ''}: ${formatValue(def.unit, before)} → ${formatValue(def.unit, now)}`, details, affected }; } },

  adjust_entities: { name: 'adjust_entities', desc: 'Bulk-modify a field of a filtered set of organisations or citizens', args: `{entity: "orgs"|"citizens", filter: {orgs: type?, sector?, district?, name?, listed?, minEmployees?, maxEmployees? | citizens: group? low|middle|high|top, status?, occupation?, district?, minAge?, maxAge?, minEducation? (0-4), sector?, employerType?, name?}, field: orgs→ ${ORG_FIELDS.join('|')} ; citizens→ ${CIT_FIELDS.join('|')}, mode: "multiply"|"add"|"set", value: number}`,
    systems: (a) => (a.entity === 'orgs' ? ['business', 'labor', 'market', 'economy'] : ['social', 'economy', 'labor']),
    validate(w, a, notes) {
      if (a.entity !== 'orgs' && a.entity !== 'citizens') return 'entity must be "orgs" or "citizens"';
      if (!(a.entity === 'orgs' ? ORG_FIELDS : CIT_FIELDS).includes(a.field)) return `field “${a.field}” is not adjustable for ${a.entity} (available: ${(a.entity === 'orgs' ? ORG_FIELDS : CIT_FIELDS).join(', ')})`;
      if (!['multiply', 'add', 'set'].includes(a.mode)) return 'mode must be multiply, add or set';
      a.value = num(a.value); if (isNaN(a.value)) return 'value must be a number';
      a.filter = a.filter || {};
      if (a.filter.sector) { const s = asSector(a.filter.sector); if (!s) return `unknown sector “${a.filter.sector}”`; a.filter.sector = s; }
      const n = a.entity === 'orgs' ? matchOrgs(w, a.filter).length : matchCitizens(w, a.filter).length;
      if (!n) return `no ${a.entity} match the filter (${describeFilter(a.filter)})`;
      if (a.field === 'income') { a.field = 'wage'; notes.push('“income” applied to wages (the engine derives income from wages, benefits and capital).'); }
      return null; },
    apply(w, a) {
      const m = (v: number) => applyMode(v, a.mode, a.value);
      if (a.entity === 'orgs') {
        const list = matchOrgs(w, a.filter); let tb = 0, ta = 0, jobs = 0;
        for (const o of list) {
          switch (a.field) {
            case 'cash': tb += o.cash; o.cash = m(o.cash); ta += o.cash; break;
            case 'funding': tb += o.funding; o.funding = Math.max(0, m(o.funding)); ta += o.funding; break;
            case 'debt': tb += o.debt; o.debt = Math.max(0, m(o.debt)); ta += o.debt; break;
            case 'sharePrice': if (o.listed) { tb += o.price; o.price = Math.max(0.1, m(o.price)); ta += o.price; } break;
            case 'productivity': tb += o.productivity; o.productivity = clamp(m(o.productivity), 0.1, 10); ta += o.productivity; break;
            case 'reputation': tb += o.reputation; o.reputation = clamp(m(o.reputation), 0.01, 1); ta += o.reputation; break;
            case 'wages': { for (const id of o.employees) { const c = w.citizens[id]; tb += c.wage; c.wage = Math.max(0, Math.round(m(c.wage))); c.refRealWage = c.wage / w.cpi; ta += c.wage; } o.wageLevel = clamp(a.mode === 'multiply' ? o.wageLevel * a.value : o.wageLevel, 0.3, 5); break; }
            case 'headcount': { const n0 = o.employees.length, target = Math.max(o.owner >= 0 ? 1 : 0, Math.round(m(n0))); tb += n0; if (target < n0) { layoff(w, o, n0 - target, 'GOD MODE intervention'); jobs += n0 - target; } else o.openings += target - n0; ta += target; break; }
          }
        }
        const fmt = (v: number) => (a.field === 'headcount' ? Math.round(v).toLocaleString('en-US') : ['productivity', 'reputation'].includes(a.field) ? (v / list.length).toFixed(2) : a.field === 'sharePrice' ? (v / Math.max(1, list.filter((o) => o.listed).length)).toFixed(2) : money(v));
        let emp = 0; for (const o of list) emp += o.employees.length;
        return { summary: `${list.length} organisations (${describeFilter(a.filter)}): ${a.field} ${fmt(tb)} → ${fmt(ta)}`, details: jobs ? [`${jobs} employees laid off immediately`] : [], affected: { orgs: list.length, employees: emp }, focus: list.length === 1 ? `org:${list[0].id}` : undefined };
      }
      const list = matchCitizens(w, a.filter); let tb = 0, ta = 0;
      const F: Record<string, keyof Citizen> = { savings: 'savings', debt: 'debt', wage: 'wage', health: 'health', trustGov: 'trustGov', happiness: 'happy', skill: 'skill', equity: 'equity' };
      const k = F[a.field], unit = ['health', 'trustGov', 'happiness', 'skill'].includes(a.field);
      for (const c of list) { const v = c[k] as number; tb += v; let nv = m(v); nv = unit ? clamp(nv, 0.01, 1) : Math.max(0, nv); (c[k] as number) = nv; ta += nv; if (a.field === 'wage') c.refRealWage = c.wage / w.cpi; }
      return { summary: `${list.length.toLocaleString('en-US')} citizens (${describeFilter(a.filter)}): ${a.field} ${unit ? (tb / list.length).toFixed(2) : money(tb)} → ${unit ? (ta / list.length).toFixed(2) : money(ta)}${unit ? ' (average)' : ' (total)'}`, details: [], affected: { citizens: list.length }, focus: list.length === 1 ? `citizen:${list[0].id}` : undefined }; } },

  create_entity: { name: 'create_entity', desc: 'Create a new citizen (e.g. a billionaire) or new organisation(s) (company, startup, university, hospital, school, bank, lab...) with real premises on the map', args: `{kind: "citizen", name?, wealth?: number, age?, foundsInvestmentFirm?: boolean} | {kind: "organisation", orgType: ${ORG_TYPES.join('|')}, sector?: ${SECTORS.join('|')}, name?, count?: number, employees?: number (posts to fill), funding?: number}`,
    systems: (a) => (a.kind === 'citizen' ? ['population', 'economy', 'market', 'business'] : ['business', 'labor', 'economy', a.orgType === 'university' || a.orgType === 'school' ? 'education' : a.orgType === 'hospital' ? 'health' : a.orgType === 'research_lab' ? 'technology' : 'market']),
    validate(w, a, notes) {
      if (a.kind === 'citizen' || a.kind === 'person') { a.kind = 'citizen'; a.wealth = isNaN(num(a.wealth)) ? 1e9 : Math.max(0, num(a.wealth)); if (a.age !== undefined) a.age = clamp(Math.round(num(a.age)) || 45, 18, 95); return null; }
      if (a.kind === 'organisation' || a.kind === 'organization' || a.kind === 'org' || a.kind === 'company') {
        a.kind = 'organisation';
        if (!ORG_TYPES.includes(a.orgType)) return `unknown organisation type “${a.orgType}” (available: ${ORG_TYPES.join(', ')})`;
        const fixed: Partial<Record<OrgType, Sector>> = { bank: 'finance', investment_firm: 'finance', university: 'education', school: 'education', hospital: 'healthcare', research_lab: 'research', gov_department: 'government', media: 'media' };
        const s = fixed[a.orgType as OrgType] || asSector(a.sector);
        if (!s) { a.sector = a.orgType === 'startup' ? 'tech' : 'services'; notes.push(`No sector given for the new ${typeLabel(a.orgType)}; assumed ${a.sector}.`); } else a.sector = s;
        a.count = isNaN(num(a.count)) ? 1 : clamp(Math.round(num(a.count)), 1, 60);
        if (a.employees !== undefined) a.employees = clamp(Math.round(num(a.employees)) || DEFAULT_STAFF[a.orgType as OrgType], 1, 600);
        const lots = w.districts.reduce((n, d) => n + d.lots.filter((l) => !l.used).length, 0);
        if (lots < 1) notes.push('The city has no free building lots; new organisations will share existing premises where possible.');
        return null;
      }
      return 'kind must be "citizen" or "organisation"'; },
    apply(w, a, ctx) {
      if (a.kind === 'citizen') {
        const sex = rand(w) < 0.5 ? 'F' : 'M';
        const c = newCitizen(w, a.age ?? randInt(w, 38, 62), sex, 2);
        if (a.name) c.name = String(a.name).slice(0, 60);
        const idx = w.market.index / w.market.indexBase;
        c.edu = 4; c.skill = 0.9; c.traits.ambition = 0.95; c.traits.risk = 0.8; c.tier = 3; c.status = 'inactive'; c.role = a.wealth >= 1e9 ? 'Billionaire investor' : a.wealth >= 1e6 ? 'Wealthy investor' : 'Newcomer'; c.goal = 'grow_wealth'; c.happy = 0.8;
        const h = newHousehold(w, [c], 2); const housed = houseHousehold(w, h); if (housed) { h.owns = true; h.mortgage = 0; }
        let firm: Org | null = null; let stake = 0;
        if (a.foundsInvestmentFirm !== false && a.wealth >= 5e7) {
          firm = makeOrg(w, 'investment_firm', 'finance', { owner: c, name: `${c.name.split(' ').slice(-1)[0]} Capital` }); placeOrg(w, firm, { nameHint: 'Financial' });
          stake = a.wealth * 0.12; firm.funding = stake; firm.cash = a.wealth * 0.005; firm.openings = 6; firm.employees.push(c.id); c.employer = firm.id; c.status = 'owner'; c.stakeOrg = firm.id; c.wage = 20000; firm.util = 1; firm.revAvg = 2e5; firm.expenses = 5e4;
          w.market.vc = Math.min(20, w.market.vc * 1.25);
        }
        c.savings = (a.wealth - stake) * 0.3; c.equity = ((a.wealth - stake) * 0.7) / idx;
        remember(w, c, 'arrived', `Arrived in ${w.name} with a fortune of ${money(a.wealth)}`, 0.9);
        emit(w, { cat: 'population', type: 'new_citizen', title: `${c.name} arrives with a fortune of ${money(a.wealth)}`, detail: firm ? `Founds ${firm.name} with ${money(stake)} of venture capital.` : 'Settles in the city.', sev: 0.45, entity: `citizen:${c.id}`, district: h.district, causes: [ctx.eventId] });
        return { summary: `Created ${c.name}, net worth ${money(a.wealth)}${housed ? `, living in ${w.districts[h.district].name}` : ''}`, details: [`${money(c.savings)} in cash, ${money(c.equity * idx)} invested in the stock market`, ...(firm ? [`founded ${firm.name} with ${money(stake)} to invest in startups (venture appetite ×1.25)`] : [])], affected: { citizens: 1, orgs: firm ? 1 : 0 }, focus: `citizen:${c.id}` };
      }
      const type = a.orgType as OrgType, names: string[] = []; let posts = 0, first = -1;
      for (let i = 0; i < a.count; i++) {
        const o = makeOrg(w, type, a.sector, { name: a.count === 1 && a.name ? String(a.name).slice(0, 60) : undefined });
        if (!placeOrg(w, o, { nameHint: a.sector === 'tech' ? 'Tech' : undefined })) { o.alive = false; o.closed = w.tick; o.closeReason = 'no premises available'; continue; }
        const staff = a.employees ?? DEFAULT_STAFF[type]; const payroll = staff * w.sectors[o.sector].baseWage * w.sectors[o.sector].wageIdx * 1.15;
        o.openings = staff; o.util = 1.05; o.revAvg = payroll * 1.3; o.expenses = payroll; posts += staff;
        const fund = isNaN(num(a.funding)) ? payroll * (type === 'startup' ? 18 : 8) : num(a.funding);
        if (type === 'startup') { o.funding = fund; o.stage = 'Seed'; o.cash = payroll; } else if (type === 'investment_firm') { o.funding = fund; o.cash = payroll * 3; } else o.cash = fund;
        if (type === 'corporation' || type === 'bank') { o.listed = true; o.shares = 1e6; o.price = Math.max(4, fund / 1e6); o.priceRef = o.price; }
        const B = w.baseBudgets, need = (payroll * 1.3) / w.cpi;
        if (type === 'school') B.education += need; else if (type === 'university') { B.education += need * 0.25; B.research += need * 0.15; } else if (type === 'hospital') B.health += need * 0.5; else if (type === 'research_lab') B.research += need * 0.8; else if (type === 'gov_department' || type === 'nonprofit') B.admin += need;
        const b = w.buildings[o.building]; b.built = w.tick; b.h = buildingHeightFor(w, b); if (b.status === 'vacant') b.status = 'active';
        names.push(o.name); if (first < 0) first = o.id; count(w, 'org.founded'); count(w, `org.founded.${type}`);
        emit(w, { cat: type === 'university' || type === 'school' ? 'education' : type === 'hospital' ? 'health' : type === 'research_lab' ? 'technology' : 'business', type: 'founded', title: `${o.name} opens in ${w.districts[o.district].name}`, detail: `New ${typeLabel(type).toLowerCase()} recruiting ${staff} staff.`, sev: 0.4, district: o.district, entity: `org:${o.id}`, causes: [ctx.eventId] });
      }
      if (!names.length) return { summary: `Could not create the ${typeLabel(type).toLowerCase()}: no premises available`, details: [], affected: {} };
      return { summary: `Created ${names.length} ${typeLabel(type).toLowerCase()}${names.length > 1 ? 's' : ''}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`, details: [`${posts} posts opened for recruitment`, ...(['school', 'university', 'hospital', 'research_lab', 'gov_department'].includes(type) ? ['public budget extended to fund it (assumption)'] : [])], affected: { orgs: names.length, buildings: names.length, openings: posts }, focus: `org:${first}` }; } },

  close_organisations: { name: 'close_organisations', desc: 'Close / bankrupt a filtered set of organisations (their employees lose their jobs)', args: '{filter: {type?, sector?, district?, name?, listed?, minEmployees?, maxEmployees?}, fraction?: 0-1 (default 1), reason?}',
    systems: () => ['business', 'labor', 'economy', 'market'],
    validate(w, a) { a.filter = a.filter || {}; if (a.filter.sector) { const s = asSector(a.filter.sector); if (!s) return `unknown sector “${a.filter.sector}”`; a.filter.sector = s; } a.fraction = isNaN(num(a.fraction)) ? 1 : clamp(num(a.fraction), 0.001, 1); if (!Object.keys(a.filter).length) return 'refusing to close every organisation without a filter — specify which organisations'; if (!matchOrgs(w, a.filter).length) return `no organisations match the filter (${describeFilter(a.filter)})`; return null; },
    apply(w, a) { const list = shuffle(w, matchOrgs(w, a.filter)); const n = Math.max(1, Math.round(list.length * a.fraction)); let jobs = 0; for (const o of list.slice(0, n)) { jobs += o.employees.length; closeOrg(w, o, a.reason || 'closed by GOD MODE intervention'); }
      return { summary: `${n} organisations closed (${describeFilter(a.filter)}), ${jobs.toLocaleString('en-US')} jobs lost`, details: [], affected: { orgs: n, employees: jobs } }; } },

  trigger_event: { name: 'trigger_event', desc: 'Trigger a world event', args: `{event: <one of the events below>, ...event args}\n${Object.entries(EVENTS).map(([k, e]) => `      · ${k} ${e.args} — ${e.desc}`).join('\n')}`,
    systems: (a) => EVENTS[a.event]?.systems || [],
    validate(_w, a) { if (!EVENTS[a.event]) return `unknown event “${a.event}” (available: ${Object.keys(EVENTS).join(', ')})`; return null; },
    apply(w, a, ctx) { return EVENTS[a.event].run(w, a, ctx); } },

  set_unemployment: { name: 'set_unemployment', desc: 'Force the unemployment rate to a level by laying off (or placing) workers across organisations', args: '{rate: fraction 0-0.95}',
    systems: () => ['labor', 'business', 'economy', 'social'],
    validate(_w, a, notes) { a.rate = num(a.rate); if (isNaN(a.rate)) return 'rate must be a number'; if (a.rate > 1) { a.rate /= 100; notes.push(`Unemployment target interpreted as ${a.rate * 100}%.`); } a.rate = clamp(a.rate, 0, 0.95); return null; },
    apply(w, a) {
      const lf = w.citizens.filter((c) => isActive(c) && c.age >= 18 && (c.status === 'employed' || c.status === 'owner' || c.status === 'unemployed'));
      const un = lf.filter((c) => c.status === 'unemployed'); const u0 = un.length / Math.max(1, lf.length); const target = Math.round(a.rate * lf.length);
      let moved = 0;
      if (target > un.length) { const emp = shuffle(w, lf.filter((c) => c.status === 'employed')); for (const c of emp.slice(0, target - un.length)) { separate(w, w.orgs[c.employer], c, 'layoff'); count(w, 'org.layoffs'); count(w, `layoff.t${c.tier}`); moved++; } }
      else { const orgs = w.orgs.filter((o) => o.alive && o.employees.length > 0); for (const c of shuffle(w, un).slice(0, un.length - target)) { hire(w, pick(w, orgs), c); count(w, 'org.hires'); moved++; } }
      w.metrics.unemployment = target / Math.max(1, lf.length);
      return { summary: `Unemployment forced from ${pct(u0)} to ${pct(target / Math.max(1, lf.length))}: ${moved.toLocaleString('en-US')} workers ${target > un.length ? 'laid off' : 'placed in jobs'}`, details: ['organisations keep their order books — they will re-hire or shed staff according to demand'], affected: { workers: moved, orgs: w.orgs.filter((o) => o.alive).length } }; } },
};

/** Machine-readable capability catalogue (used in the LLM prompt and shown in the UI help). */
export function opCatalogue(): string {
  return Object.values(OPS).map((o) => `- ${o.name}: ${o.desc}\n    args: ${o.args}`).join('\n');
}

export interface Validation { plan: Plan; notes: string[]; rejected: { op: PlanOp; error: string }[] }

/** Validate a plan against the current world. Never silently drops anything: rejected parts are reported. */
export function validatePlan(w: World, plan: Plan): Validation {
  const notes: string[] = [], rejected: { op: PlanOp; error: string }[] = [], ok: PlanOp[] = [];
  const seen = new Map<string, number>();
  for (const p of (plan.operations || []).slice(0, 16)) {
    if (!p || typeof p.op !== 'string') continue;
    p.args = p.args && typeof p.args === 'object' ? p.args : {};
    if (p.op === 'simulate') { const d = num(p.args.days); if (!isNaN(d)) plan.horizonDays = Math.max(plan.horizonDays || 0, d); continue; }
    if (p.op === 'query') { ok.push(p); continue; }
    const def = OPS[p.op];
    if (!def) { rejected.push({ op: p, error: `unknown operation “${p.op}”` }); continue; }
    const err = def.validate(w, p.args, notes);
    if (err) { rejected.push({ op: p, error: err }); continue; }
    if (p.op === 'adjust_parameter' && p.args.mode === 'set') { const k = `${p.args.target}|${p.args.sector || ''}`; if (seen.has(k) && seen.get(k) !== p.args.value) notes.push(`Conflicting instructions for ${paramByKey(p.args.target)!.label}: the later value (${p.args.value}) is used.`); seen.set(k, p.args.value); }
    ok.push(p);
  }
  if ((plan.operations || []).length > 16) notes.push('Only the first 16 operations were considered.');
  if (plan.horizonDays !== undefined) { const h = clamp(Math.round(num(plan.horizonDays) || 0), 0, 3600); if (h !== plan.horizonDays) notes.push(`Simulation horizon limited to ${h} days.`); plan.horizonDays = h; }
  plan.operations = ok;
  return { plan, notes, rejected };
}

export function applyOp(w: World, p: PlanOp, ctx: OpCtx): OpResult {
  const def = OPS[p.op];
  try { const r = def.apply(w, p.args, ctx); count(w, 'god.operations'); return { op: p.op, ok: true, systems: def.systems(p.args), ...r }; }
  catch (e: any) { return { op: p.op, ok: false, systems: [], summary: `Operation ${p.op} failed`, details: [], affected: {}, error: String(e?.message || e) }; }
}

export function paramSuggestions(text: string, n = 4): string[] {
  const words = text.toLowerCase().split(/[^a-z]+/).filter((x) => x.length > 3);
  return PARAMS.map((p) => ({ p, s: words.reduce((a, wd) => a + (p.synonyms.some((y) => y.includes(wd)) || p.label.toLowerCase().includes(wd) ? 1 : 0), 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p.label);
}
export type { Household };
