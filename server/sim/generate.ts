// Population Generator + procedural city. Produces a coherent synthetic civilisation:
// households -> citizens -> organisations -> jobs -> housing -> relationships -> calibrated economy.
import type { World, Citizen, Household, Org, OrgType, Sector, DistrictKind, District, Policy, SectorState, Good } from './types';
import { SIM_VERSION, SECTORS, clamp } from './types';
import { seedRng, rand, randInt, gauss, weighted, shuffle, pick } from './rng';
import { personName, surnameOf, randomSurname, orgName, GOV_DEPTS } from './names';
import { placeOrg, newBuilding, roleFor, offerWage, buildingHeightFor, emit, isActive } from './world';
import { calibrateEconomy } from './economy';
import { computeMetrics, recordHistory } from './metrics';
import { tick } from './tick';

// 6×6 district grid split by a north–south river (between columns 2 and 3). Downtown sits on the river,
// industry on the western edge, affluent neighbourhoods to the north-east.
const MAP: [string, DistrictKind, number][][] = [
  [['Northgate', 'residential', 0], ['Highlands', 'residential', 2], ['University Hill', 'university', 1], ['Helix Research Campus', 'research', 1], ['Maple Court', 'residential', 1], ['Lakeside', 'residential', 2]],
  [['Riverside', 'residential', 1], ['Old Market', 'commercial', 1], ['Kestrel College Park', 'university', 1], ['Axiom Tech Park', 'business', 2], ['Mercy Medical District', 'medical', 1], ['Birchwood', 'residential', 1]],
  [['Ironworks', 'industrial', 0], ['Civic Center', 'government', 1], ['Downtown Core', 'business', 2], ['Meridian Financial Quarter', 'business', 2], ['Central Commons', 'park', 1], ['Elmhurst', 'residential', 2]],
  [['Foundry Row', 'industrial', 0], ['Southside', 'residential', 0], ['Harbour Exchange', 'commercial', 1], ['Midtown Plaza', 'business', 2], ['St. Ana Medical Campus', 'medical', 1], ['Greenfield', 'residential', 1]],
  [['Westyard', 'industrial', 0], ['Brookvale', 'residential', 0], ['Canal Street', 'commercial', 1], ['Quantum Research Park', 'research', 1], ['Willow Park', 'park', 1], ['Oakridge', 'residential', 1]],
  [['Docklands', 'residential', 0], ['Millbrook', 'residential', 0], ['Market Square', 'commercial', 1], ['Sunset Heights', 'residential', 1], ['Cedar Grove', 'residential', 1], ['Riverbend Park', 'park', 1]],
];
export const PITCH = 360, CELL = 320, LOTN = 8, LOTP = 36, STREET_GAP = 28, RIVER_GAP = 90, RIVER_COL = 3;
export const DEFAULT_POPULATION = 15000;

export const BASE_WAGE: Record<Sector, number> = { food: 2300, retail: 2300, tech: 5200, manufacturing: 3300, finance: 5600, healthcare: 4200, education: 3400, construction: 3200, energy: 4300, media: 3400, services: 2500, government: 3600, research: 4800 };

export function defaultPolicy(): Policy {
  return { minWage: 1700, incomeTax: 0.2, corporateTax: 0.22, salesTax: 0.08, propertyTax: 0.01, interestRate: 0.035, tuitionSubsidy: 0.5, healthSubsidy: 0.6, unemploymentBenefit: 0.5, pension: 1500, childBenefit: 120, ubi: 0, spendEducation: 1, spendHealth: 1, spendAdmin: 1, spendResearch: 1, spendInfrastructure: 1, spendPolice: 1, rentControl: 0, immigration: 1, restrictions: 0, priceControlFood: 0, wealthTax: 0, startupSubsidy: 0 };
}

export function blankWorld(seed: number): World {
  const sectors = {} as Record<Sector, SectorState>;
  for (const s of SECTORS) sectors[s] = { baseOutput: 1, demand: 0, capacity: 0, prod: 1, autom: 0, baseWage: BASE_WAGE[s], wageIdx: 1, exports: 0, importShare: 0, firms: 0, jobs: 0, util: 1, price: 1 };
  const prices = { food: 1, housing: 1, energy: 1, retail: 1, services: 1, healthcare: 1, education: 1 } as Record<Good, number>;
  return {
    v: SIM_VERSION, seed, rng: seedRng(seed), tick: 0, name: 'Aurelia',
    citizens: [], households: [], orgs: [], buildings: [], districts: [],
    prices, cpi: 1, cpiHist: [1], tuition: 900, baseBudgets: {},
    sectors, policy: defaultPolicy(),
    gov: { leader: -1, party: 0, parties: [{ name: 'Civic Progress Union', ideology: -0.35, support: 0.4 }, { name: 'Free Enterprise Alliance', ideology: 0.4, support: 0.36 }, { name: 'Commons & Green Front', ideology: -0.7, support: 0.24 }], debt: 0, revenue: 0, spending: 0, balance: 0, approval: 0.52, nextElection: 720, locks: {}, transfer: 0, rev: {}, out: {}, actions: [] },
    market: { index: 1000, indexBase: 1000, confidence: 1, flow: 0, credit: 1, indexHist: [1000], vc: 1 },
    health: { diseases: [], beds: 0, occupied: 0, load: 0, deathsYear: 0, careQuality: 1 },
    edu: { capacity: 0, enrolled: 0, applicants: 0, rejected: 0, schoolQuality: 1, graduates: 0 },
    tech: { level: 1, progress: 0, nextAt: 100, items: [], output: 0 },
    housing: { vacancy: 0.07, avgRent: 0, homeless: 0, propertyIdx: 1, supplyMult: 1, pipeline: 0 },
    infra: { energyCap: 1, energyUse: 0.85, waterCap: 1, waterUse: 0.8, transport: 1, quality: 1 },
    social: { stability: 0.8, crime: 0.2, protestShare: 0, unrest: 0, migIn: 0, migOut: 0, births: 0, deaths: 0, cohesion: 0.6 },
    ext: { shocks: [], globalDemand: 1 },
    mods: { startupFormation: 1, birthRate: 1, exportDemand: 1, fear: 0, corruption: 0 },
    events: [], nextEventId: 1, interventions: [], counters: {}, metrics: {}, history: { t: [], s: {} },
    nextIds: { shock: 1, disease: 1, tech: 1, intervention: 1 },
  };
}

const EDU_W = [[0.03, 0.22, 0.6, 0.13, 0.02], [0, 0.06, 0.48, 0.36, 0.1], [0, 0.01, 0.2, 0.47, 0.32]];
const FIELD_LO: Sector[] = ['retail', 'food', 'services', 'manufacturing', 'construction', 'energy', 'healthcare', 'government'];
const FIELD_HI: Sector[] = ['tech', 'finance', 'healthcare', 'research', 'education', 'media', 'services', 'government', 'manufacturing', 'energy'];

export function newCitizen(w: World, age: number, sex: 'F' | 'M', wclass: number, surname?: string): Citizen {
  const t = () => clamp(gauss(w, 0.5, 0.18));
  let edu = age < 6 ? 0 : age < 18 ? 1 : age < 23 ? 2 : weighted(w, [0, 1, 2, 3, 4], EDU_W[wclass]);
  if (age >= 18 && age < 23 && edu < 2) edu = 2;
  const skill = age < 18 ? 0.08 + age * 0.008 : clamp(0.22 + edu * 0.12 + gauss(w, 0, 0.1) + Math.min(Math.max(age - 22, 0), 20) * 0.004, 0.05, 1);
  const c: Citizen = {
    id: w.citizens.length, name: personName(w, sex, surname), sex, age, bday: randInt(w, 0, 359), alive: true, left: false, hh: -1,
    traits: { open: t(), consc: t(), extra: t(), agree: t(), neuro: t(), risk: t(), ambition: t(), frugal: t() },
    edu, skill, field: pick(w, edu >= 3 ? FIELD_HI : FIELD_LO),
    status: age < 18 ? 'child' : age >= 65 ? 'retired' : 'unemployed', role: age < 18 ? 'Child' : age >= 65 ? 'Retired' : 'Unemployed', employer: -1, school: -1, studyLeft: 0, wantsUni: false,
    wage: 0, income: 0, savings: 0, debt: 0, equity: 0, stakeOrg: -1,
    health: clamp(gauss(w, 0.93 - Math.max(0, age - 40) * 0.006, 0.06), 0.2, 1), inf: 0, infDays: 0,
    happy: clamp(gauss(w, 0.62, 0.1)), stress: clamp(gauss(w, 0.3, 0.1)),
    trustGov: clamp(gauss(w, 0.55, 0.15)), trustMedia: clamp(gauss(w, 0.5, 0.15)), trustBiz: clamp(gauss(w, 0.5, 0.14)), ideology: clamp(gauss(w, (wclass - 1) * 0.18, 0.4), -1, 1),
    goal: age < 18 ? 'grow_up' : age >= 65 ? 'enjoy_retirement' : 'build_career', spendMode: 1,
    friends: [], partner: -1, mem: [], ltm: [], tier: wclass, unempMonths: 0, refRealWage: 0, protest: false, seeking: false, lastDecision: '', tenure: 0,
    prefs: { food: clamp(gauss(w, 1, 0.12), 0.7, 1.4), retail: clamp(gauss(w, 1, 0.25), 0.4, 1.8), services: clamp(gauss(w, 1, 0.25), 0.4, 1.8) },
  };
  w.citizens.push(c);
  return c;
}

export function newHousehold(w: World, members: Citizen[], wclass: number): Household {
  const h: Household = { id: w.households.length, members: members.map((m) => m.id), district: -1, building: -1, alive: true, owns: false, rentBase: 0, mortgage: 0, arrears: 0, hardship: 0, homeless: false, income: 0, essential: 0, pp: 1.5, foodShare: 0.15, wclass };
  for (const m of members) m.hh = h.id;
  w.households.push(h);
  return h;
}

const RENT_BASE = [780, 1250, 2400];

/** Put a household into a residential unit (preferring districts matching its class). */
export function houseHousehold(w: World, h: Household): boolean {
  let best = -1, bestScore = -1e9;
  for (const b of w.buildings) {
    if (b.kind !== 'residential' || b.status !== 'active' || b.occupied >= Math.floor(b.units * w.housing.supplyMult)) continue;
    const d = w.districts[b.district];
    const score = -Math.abs(d.wealth - h.wclass) * 10 - d.rentIdx + rand(w) * 2;
    if (score > bestScore) { bestScore = score; best = b.id; }
  }
  if (best < 0) return false;
  const b = w.buildings[best];
  if (h.building >= 0 && w.buildings[h.building]) w.buildings[h.building].occupied = Math.max(0, w.buildings[h.building].occupied - 1);
  b.occupied++; h.building = b.id; h.district = b.district; h.homeless = false;
  h.rentBase = RENT_BASE[w.districts[b.district].wealth] * (0.85 + rand(w) * 0.3);
  return true;
}

export function makeOrg(w: World, type: OrgType, sector: Sector, opts: { name?: string; owner?: Citizen } = {}): Org {
  const o: Org = {
    id: w.orgs.length, name: '', type, sector, district: -1, building: -1, alive: true, founded: w.tick, closed: -1, closeReason: '',
    employees: [], owner: opts.owner ? opts.owner.id : -1, managers: [], cash: 0, debt: 0, funding: 0, stage: '', revenue: 0, budgetRev: 0, expenses: 0, profit: 0, profitAvg: 0, revAvg: 0, wageBill: 0,
    capacity: 0, demand: 0, util: 0.95, productivity: clamp(gauss(w, 1, 0.08), 0.75, 1.35), reputation: clamp(gauss(w, 0.6, 0.15), 0.15, 1), share: 0,
    wageLevel: clamp(gauss(w, 1, 0.07), 0.82, 1.25), openings: 0, unfilled: 0, freezeUntil: 0, lossMonths: 0, listed: false, shares: 0, price: 0, priceRef: 0,
    objective: type === 'startup' ? 'growth' : type === 'corporation' || type === 'bank' || type === 'investment_firm' ? 'profit' : type === 'small_business' ? 'livelihood' : 'public_service', partners: [], log: [],
  };
  o.name = opts.name || orgName(w, type, sector, opts.owner ? surnameOf(opts.owner.name) : undefined);
  w.orgs.push(o);
  return o;
}

function layoutDistricts(w: World) {
  let id = 0;
  const R = MAP.length, C = MAP[0].length;
  // lots are arranged in four blocks per district, separated by a cross street through the district centre
  const off = (k: number) => (k - (LOTN - 1) / 2) * LOTP + (k >= LOTN / 2 ? STREET_GAP / 2 : -STREET_GAP / 2);
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const [name, kind, wealth] = MAP[r][c];
    const x = (c - (C - 1) / 2) * PITCH + (c >= RIVER_COL ? RIVER_GAP / 2 : -RIVER_GAP / 2), z = (r - (R - 1) / 2) * PITCH;
    const lots = [];
    for (let i = 0; i < LOTN; i++) for (let j = 0; j < LOTN; j++) {
      if (kind === 'park' && !((i === 0 || i === LOTN - 1) && (j === 0 || j === LOTN - 1))) continue;
      lots.push({ x: x + off(i), z: z + off(j), used: false });
    }
    const d: District = { id: id++, name, kind, wealth, x, z, w: CELL, d: CELL, lots, rentIdx: 1, crime: 0.2, unemp: 0.06, pop: 0, infected: 0, avgIncome: 0, protest: 0, activity: 1, happy: 0.6 };
    w.districts.push(d);
  }
}

function rebase(w: World, d: number) {
  w.tick = 0; w.events = []; w.nextEventId = 1; w.counters = {}; w.history = { t: [], s: {} }; w.interventions = [];
  w.cpiHist = [w.cpi];
  let cap = 0; for (const o of w.orgs) { o.founded = Math.min(0, o.founded - d); if (o.closed >= 0) o.closed -= d; o.freezeUntil = Math.max(0, o.freezeUntil - d); o.log = []; if (o.listed && o.alive) { cap += o.price * o.shares; o.priceRef = o.price; } }
  w.mods['market.baseCap'] = cap; w.market.index = w.market.indexBase; w.market.indexHist = [w.market.indexBase]; w.market.confidence = 1; w.market.flow = 0;
  for (const b of w.buildings) { b.built = Math.min(0, b.built - d); b.readyAt = Math.max(0, b.readyAt - d); }
  for (const c of w.citizens) { for (const m of c.mem) m.t -= d; for (const m of c.ltm) m.t -= d; c.protest = false; }
  w.gov.nextElection = 720; w.gov.actions = []; w.gov.locks = {};
  w.mods['base.u'] = w.metrics.unemployment; w.mods['base.stability'] = w.social.stability; w.mods['social.protestT'] = -999; w.mods['cb.cum'] = 0;
  w.mods['base.bizDensity'] = w.orgs.filter((o) => o.alive && (o.type === 'startup' || o.type === 'small_business' || o.type === 'corporation' || o.type === 'bank' || o.type === 'investment_firm' || o.type === 'media')).length / Math.max(1, w.metrics.population);
  w.mods['base.pop'] = w.metrics.population; w.mods['base.output'] = (w.mods['flow.output'] || 1) / w.cpi;
  w.social.migIn = 0; w.social.migOut = 0; w.social.births = 0; w.social.deaths = 0;
  w.tech.progress = 0;
}

export function generateWorld(seed = 20400101, targetPop = DEFAULT_POPULATION): World {
  const w = blankWorld(seed);
  const K = targetPop / 5200; // scale relative to the v1 calibration city
  w.mods.scale = K;
  w.mods['geo.riverX'] = (RIVER_COL - 0.5 - (MAP[0].length - 1) / 2) * PITCH; w.mods['geo.riverW'] = PITCH - CELL + RIVER_GAP;
  layoutDistricts(w);

  // ---- households & citizens -------------------------------------------------
  const sexOf = () => (rand(w) < 0.5 ? 'F' : 'M') as 'F' | 'M';
  while (w.citizens.length < targetPop) {
    const wclass = weighted(w, [0, 1, 2], [0.42, 0.44, 0.14]);
    const type = weighted(w, ['single', 'couple', 'family', 'single_parent', 'retired', 'students'], [0.22, 0.2, 0.31, 0.08, 0.145, 0.045]);
    const sn = randomSurname(w);
    const mem: Citizen[] = [];
    const couple = (lo: number, hi: number) => {
      const a = newCitizen(w, randInt(w, lo, hi), 'F', wclass, sn);
      const b = newCitizen(w, clamp(a.age + randInt(w, -4, 6), lo, hi + 6), rand(w) < 0.92 ? 'M' : 'F', wclass, sn);
      a.partner = b.id; b.partner = a.id; mem.push(a, b);
      return a;
    };
    const kids = (n: number, parentAge: number) => {
      for (let i = 0; i < n; i++) {
        const age = randInt(w, 0, Math.max(0, Math.min(22, parentAge - 20)));
        const k = newCitizen(w, age, sexOf(), wclass, sn);
        if (age >= 18 && rand(w) < [0.25, 0.5, 0.75][wclass]) { k.status = 'student'; k.role = 'University student'; k.studyLeft = randInt(w, 4, 46); k.goal = 'get_degree'; }
        mem.push(k);
      }
    };
    if (type === 'single') mem.push(newCitizen(w, randInt(w, 22, 64), sexOf(), wclass, sn));
    else if (type === 'couple') couple(24, 64);
    else if (type === 'family') { const p = couple(28, 56); kids(weighted(w, [1, 2, 3], [0.4, 0.42, 0.18]), p.age); }
    else if (type === 'single_parent') { const p = newCitizen(w, randInt(w, 26, 50), rand(w) < 0.75 ? 'F' : 'M', wclass, sn); mem.push(p); kids(weighted(w, [1, 2], [0.6, 0.4]), p.age); }
    else if (type === 'retired') { if (rand(w) < 0.5) couple(65, 86); else mem.push(newCitizen(w, randInt(w, 65, 90), sexOf(), wclass, sn)); }
    else { const n = randInt(w, 2, 3); for (let i = 0; i < n; i++) { const s = newCitizen(w, randInt(w, 18, 23), sexOf(), 1); s.status = 'student'; s.role = 'University student'; s.studyLeft = randInt(w, 4, 46); s.goal = 'get_degree'; mem.push(s); } }
    newHousehold(w, mem, type === 'students' ? 0 : wclass);
  }

  // ---- housing ----------------------------------------------------------------
  const unitsTarget = [14, 10, 4];
  for (let cls = 0; cls < 3; cls++) {
    const ds = w.districts.filter((d) => d.kind === 'residential' && d.wealth === cls);
    const hhs = w.households.filter((h) => h.wclass === cls);
    const per = Math.ceil(hhs.length / ds.length);
    ds.forEach((d, di) => {
      const mine = hhs.slice(di * per, (di + 1) * per);
      const nb = Math.min(48, Math.ceil(mine.length / unitsTarget[cls]));
      const units = Math.ceil((mine.length * 1.08) / nb);
      const bs = [];
      for (let i = 0; i < nb; i++) {
        const b = newBuilding(w, 'residential', ['residential'], { district: d.id, units: Math.max(1, units + randInt(w, -1, 1)) })!;
        b.name = `${d.name} ${cls === 2 ? 'Residences' : cls === 1 ? 'Apartments' : 'Housing Block'} ${i + 1}`;
        bs.push(b);
      }
      let bi = 0;
      for (const h of mine) {
        let guard = 0;
        while (bs[bi % nb].occupied >= bs[bi % nb].units && guard++ < nb) bi++;
        const b = bs[bi % nb]; bi++;
        b.occupied++; h.building = b.id; h.district = d.id;
        h.rentBase = RENT_BASE[cls] * (0.85 + rand(w) * 0.3);
        h.owns = rand(w) < [0.18, 0.52, 0.85][cls];
        if (h.owns) h.mortgage = rand(w) < 0.3 ? 0 : RENT_BASE[cls] * randInt(w, 40, 160);
      }
    });
  }
  for (const b of w.buildings) b.h = buildingHeightFor(w, b);

  // ---- organisations -----------------------------------------------------------
  const target = new Map<number, number>();
  const add = (type: OrgType, sector: Sector, lo: number, hi: number, name?: string, hint?: string) => {
    const o = makeOrg(w, type, sector, { name });
    placeOrg(w, o, { nameHint: hint });
    target.set(o.id, randInt(w, lo, hi));
    return o;
  };
  // organisation counts scale with population so per-organisation headcounts stay realistic
  const N = (base: number) => Math.max(1, Math.round(base * K));
  const corpSectors: [Sector, string?][] = [['tech', 'Tech'], ['tech', 'Tech'], ['tech', 'Downtown'], ['manufacturing'], ['manufacturing'], ['retail'], ['retail'], ['food'], ['food'], ['energy'], ['construction'], ['services', 'Downtown']];
  for (let i = 0; i < N(12); i++) { const [s, hint] = corpSectors[i % corpSectors.length]; add('corporation', s, 50, 130, undefined, hint); }
  for (let i = 0; i < N(4); i++) add('bank', 'finance', 15, 30, undefined, 'Financial');
  for (let i = 0; i < N(4); i++) add('investment_firm', 'finance', 6, 14, undefined, 'Financial');
  for (let i = 0; i < N(2); i++) add('university', 'education', 55, 85);
  const resDistricts = w.districts.filter((d) => d.kind === 'residential');
  for (const d of resDistricts) { const o = makeOrg(w, 'school', 'education'); const b = newBuilding(w, 'school', ['residential'], { district: d.id, name: o.name })!; b.orgs.push(o.id); o.building = b.id; o.district = d.id; target.set(o.id, Math.round((randInt(w, 16, 26) * K * 8) / resDistricts.length)); }
  for (let i = 0; i < N(3); i++) add('hospital', 'healthcare', 70, 110);
  for (let i = 0; i < N(5); i++) add('research_lab', 'research', 12, 26);
  for (const n of GOV_DEPTS) add('gov_department', 'government', Math.round(18 * K), Math.round(45 * K), n);
  for (let i = 0; i < N(4); i++) add('media', 'media', 10, 20);
  for (let i = 0; i < N(8); i++) add('nonprofit', 'services', 4, 10);

  // owners for startups and small businesses
  const lf = w.citizens.filter((c) => c.age >= 18 && c.age < 65 && c.status !== 'student');
  for (const c of lf) if (rand(w) < 0.09) { c.status = 'inactive'; c.role = 'Homemaker'; c.goal = 'care_for_family'; }
  const workers = lf.filter((c) => c.status !== 'inactive');
  const founders = [...workers].sort((a, b) => b.traits.ambition + b.traits.risk - (a.traits.ambition + a.traits.risk));
  const isOwner = new Set<number>();
  let fp = 0;
  const takeFounder = (needDegree: boolean): Citizen => {
    for (let i = fp; i < founders.length; i++) { const c = founders[i]; if (isOwner.has(c.id) || c.age < 24) continue; if (needDegree && c.edu < 3) continue; isOwner.add(c.id); if (i === fp) fp++; return c; }
    const c = founders.find((x) => !isOwner.has(x.id))!; isOwner.add(c.id); return c;
  };
  for (let i = 0; i < N(42); i++) {
    const s = weighted(w, ['tech', 'healthcare', 'energy', 'finance', 'services', 'media'] as Sector[], [0.55, 0.1, 0.08, 0.1, 0.1, 0.07]);
    const f = takeFounder(true);
    const o = makeOrg(w, 'startup', s, { owner: f }); placeOrg(w, o, { nameHint: s === 'tech' ? 'Tech' : undefined }); target.set(o.id, randInt(w, 3, 14));
    o.stage = pick(w, ['Seed', 'Seed', 'Series A', 'Series A', 'Series B']);
  }
  for (let i = 0; i < N(240); i++) {
    const s = weighted(w, ['food', 'retail', 'services', 'construction', 'manufacturing', 'healthcare', 'tech'] as Sector[], [0.25, 0.27, 0.28, 0.07, 0.05, 0.05, 0.03]);
    const f = takeFounder(false);
    const o = makeOrg(w, 'small_business', s, { owner: f }); placeOrg(w, o); target.set(o.id, randInt(w, 2, 9));
  }

  // ---- labour assignment -------------------------------------------------------
  const pool = workers.filter((c) => !isOwner.has(c.id));
  shuffle(w, pool);
  const unemployed = new Set<number>();
  const wantU = Math.round(workers.length * 0.062);
  for (const c of pool) { if (unemployed.size >= wantU) break; if (rand(w) < (c.edu <= 2 ? 0.1 : 0.04)) unemployed.add(c.id); }
  const avail = pool.filter((c) => !unemployed.has(c.id)).sort((a, b) => b.edu + b.skill * 0.9 - (a.edu + a.skill * 0.9));
  let tot = 0;
  for (const o of w.orgs) tot += target.get(o.id)! - (o.owner >= 0 ? 1 : 0);
  const factor = avail.length / tot;
  const NEED: Partial<Record<OrgType, number[]>> = { research_lab: [0, 0, 0.1, 0.4, 0.5], university: [0, 0, 0.25, 0.3, 0.45], hospital: [0, 0, 0.3, 0.5, 0.2], school: [0, 0, 0.25, 0.7, 0.05], bank: [0, 0, 0.3, 0.6, 0.1], investment_firm: [0, 0, 0.2, 0.6, 0.2], gov_department: [0, 0, 0.5, 0.42, 0.08], media: [0, 0, 0.4, 0.55, 0.05] };
  const slots: { org: number; need: number }[] = [];
  for (const o of w.orgs) {
    const n = Math.max(o.owner >= 0 ? 0 : 1, Math.round((target.get(o.id)! - (o.owner >= 0 ? 1 : 0)) * factor));
    const dist = NEED[o.type] || (o.sector === 'tech' ? [0, 0, 0.3, 0.6, 0.1] : [0, 0.33, 0.55, 0.1, 0.02]);
    for (let i = 0; i < n; i++) slots.push({ org: o.id, need: weighted(w, [0, 1, 2, 3, 4], dist) + rand(w) * 0.5 });
  }
  slots.sort((a, b) => b.need - a.need);
  const nAssign = Math.min(slots.length, avail.length);
  // if rounding produced more slots than workers, drop random low-need slots; if fewer, the rest stay unemployed
  for (let i = 0; i < nAssign; i++) { const c = avail[i], o = w.orgs[slots[i].org]; o.employees.push(c.id); c.employer = o.id; c.status = 'employed'; c.field = o.sector; }
  for (const o of w.orgs) if (o.owner >= 0) { const c = w.citizens[o.owner]; o.employees.push(c.id); c.employer = o.id; c.status = 'owner'; c.field = o.sector; c.stakeOrg = o.id; c.goal = 'grow_business'; }
  for (const o of w.orgs) {
    const emps = o.employees.map((id) => w.citizens[id]);
    for (const c of emps) { c.role = roleFor(o, c); c.wage = offerWage(w, o, c); c.tenure = randInt(w, 1, 120); }
    const ranked = [...emps].sort((a, b) => b.skill - a.skill);
    const nm = Math.min(ranked.length, 1 + Math.floor(emps.length / 15));
    for (let i = 0; i < nm; i++) { const c = ranked[i]; if (c.id === o.owner) continue; o.managers.push(c.id); c.wage = Math.round(c.wage * 1.35); c.role = o.type === 'gov_department' ? 'Director' : i === 0 && emps.length > 30 ? 'Chief Executive' : 'Manager'; }
    if (o.owner >= 0) { const c = w.citizens[o.owner]; c.role = o.type === 'startup' ? 'Founder' : 'Business owner'; c.wage = Math.round(offerWage(w, o, c) * 1.3); }
    if (o.name === 'City Council') { const top = ranked.slice(0, 6); top.forEach((c, i) => { c.role = i === 0 ? 'Mayor' : 'Councillor'; }); if (top[0]) w.gov.leader = top[0].id; }
    o.openings = 0;
  }
  for (const c of w.citizens) { if (c.status === 'unemployed') { c.unempMonths = randInt(w, 0, 8); c.goal = 'find_job'; c.seeking = true; } c.refRealWage = c.wage; }

  // ---- schools & universities ------------------------------------------------------
  const unis = w.orgs.filter((o) => o.type === 'university');
  for (const c of w.citizens) {
    if (c.status === 'student') c.school = pick(w, unis).id;
    else if (c.age >= 6 && c.age < 18) { const sc = w.orgs.find((o) => o.type === 'school' && o.district === w.households[c.hh].district); c.school = sc ? sc.id : w.orgs.find((o) => o.type === 'school')!.id; c.role = 'School pupil'; }
  }

  // ---- wealth ------------------------------------------------------------------------
  for (const c of w.citizens) {
    if (c.age < 18) continue;
    const cls = w.households[c.hh].wclass;
    const base = Math.max(c.wage, c.status === 'retired' ? 1600 : 900);
    const months = Math.exp(gauss(w, [0.2, 1.7, 3.3][cls], 0.8)) * clamp(c.age / 40, 0.4, 1.8) * (0.6 + c.traits.frugal * 0.8);
    c.savings = Math.round(base * months);
    if (c.status === 'student') c.savings = Math.round(c.savings * 0.2);
    if (c.status === 'retired') c.wage = Math.round([150, 650, 2400][cls] * (0.6 + rand(w) * 0.8));
    c.debt = rand(w) < [0.55, 0.4, 0.2][cls] ? Math.round(base * rand(w) * [5, 4, 3][cls]) : 0;
    if (cls === 2 || (cls === 1 && rand(w) < 0.25)) c.equity = Math.round(c.savings * (0.3 + rand(w) * 1.6) * (0.4 + c.traits.risk));
  }
  const rich = shuffle(w, w.citizens.filter((c) => c.age >= 35 && w.households[c.hh].wclass === 2)).slice(0, Math.round(w.citizens.length * 0.011));
  for (const c of rich) { c.savings = Math.round((0.3 + rand(w) * 3.5) * 1e6); c.equity = Math.round(Math.exp(gauss(w, 14.6, 1.0))); c.tier = 3; c.goal = 'grow_wealth'; }
  const majors = w.orgs.filter((o) => o.type === 'corporation' || o.type === 'bank');
  majors.forEach((o, i) => { const c = rich[i % rich.length]; if (c.stakeOrg < 0) c.stakeOrg = o.id; o.listed = true; o.shares = 1e6; });

  // ---- relationships ---------------------------------------------------------------------
  const byDistrict: number[][] = w.districts.map(() => []);
  for (const c of w.citizens) if (c.age >= 6) byDistrict[w.households[c.hh].district].push(c.id);
  const link = (a: Citizen, bId: number) => { if (bId === a.id || a.friends.includes(bId) || a.friends.length >= 8) return; const b = w.citizens[bId]; if (b.friends.length >= 8 || b.hh === a.hh) return; if (Math.abs(a.age - b.age) > 25 && rand(w) < 0.7) return; a.friends.push(bId); b.friends.push(a.id); };
  for (const c of w.citizens) {
    if (c.age < 6) continue;
    const peers = c.employer >= 0 ? w.orgs[c.employer].employees : null;
    const n = 1 + Math.round(c.traits.extra * 3);
    for (let i = 0; i < n; i++) {
      const r = rand(w);
      if (peers && peers.length > 1 && r < 0.45) link(c, pick(w, peers));
      else if (r < 0.9) link(c, pick(w, byDistrict[w.households[c.hh].district]));
      else link(c, randInt(w, 0, w.citizens.length - 1));
    }
  }
  const firms = w.orgs.filter((o) => o.type === 'corporation' || o.type === 'small_business' || o.type === 'startup');
  for (const o of firms) { const n = randInt(w, 1, 3); for (let i = 0; i < n; i++) { const p = pick(w, firms); if (p.id !== o.id && !o.partners.includes(p.id)) { o.partners.push(p.id); if (!p.partners.includes(o.id) && p.partners.length < 6) p.partners.push(o.id); } } }

  // ---- finance + calibration ----------------------------------------------------------------
  for (const b of w.buildings) b.h = buildingHeightFor(w, b);
  calibrateEconomy(w);
  computeMetrics(w);
  // warm-up: let wages, spending, opinions and the labour market settle, then re-base the clock
  const WARM = 180;
  for (let i = 0; i < WARM; i++) tick(w);
  rebase(w, WARM);
  computeMetrics(w);
  recordHistory(w);
  emit(w, { cat: 'population', type: 'genesis', title: `The city of ${w.name} is founded`, detail: `${w.citizens.filter(isActive).length.toLocaleString('en-US')} citizens, ${w.households.length.toLocaleString('en-US')} households and ${w.orgs.length} organisations begin their lives.`, sev: 0.2, causes: [] });
  return w;
}
