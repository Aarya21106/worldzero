// WORLDZERO — versioned world-state model. Everything in here is plain JSON so the
// whole world can be cloned, snapshotted, branched and restored deterministically.
export const SIM_VERSION = 4;
export const DAYS_PER_MONTH = 30;
export const DAYS_PER_YEAR = 360;

export const SECTORS = ['food', 'retail', 'tech', 'manufacturing', 'finance', 'healthcare', 'education', 'construction', 'energy', 'media', 'services', 'government', 'research'] as const;
export type Sector = (typeof SECTORS)[number];
export const GOODS = ['food', 'housing', 'energy', 'retail', 'services', 'healthcare', 'education'] as const;
export type Good = (typeof GOODS)[number];

export type OrgType = 'corporation' | 'startup' | 'small_business' | 'bank' | 'investment_firm' | 'university' | 'school' | 'hospital' | 'research_lab' | 'gov_department' | 'media' | 'nonprofit';
export const ORG_TYPES: OrgType[] = ['corporation', 'startup', 'small_business', 'bank', 'investment_firm', 'university', 'school', 'hospital', 'research_lab', 'gov_department', 'media', 'nonprofit'];
export type DistrictKind = 'residential' | 'commercial' | 'business' | 'industrial' | 'university' | 'medical' | 'research' | 'government' | 'park';
export type Status = 'child' | 'student' | 'employed' | 'owner' | 'unemployed' | 'retired' | 'inactive';
export type BuildingKind = 'residential' | 'commercial' | 'office' | 'industrial' | 'university' | 'school' | 'hospital' | 'lab' | 'government' | 'utility';

export interface Memory { t: number; k: string; d: string; v: number }

export interface Citizen {
  id: number; name: string; sex: 'F' | 'M'; age: number; bday: number;
  alive: boolean; left: boolean;
  hh: number;
  traits: { open: number; consc: number; extra: number; agree: number; neuro: number; risk: number; ambition: number; frugal: number };
  edu: number; // 0 none · 1 primary · 2 secondary · 3 degree · 4 postgraduate
  skill: number; field: Sector;
  status: Status; role: string; employer: number; school: number; studyLeft: number; wantsUni: boolean;
  wage: number; income: number; savings: number; debt: number; equity: number;
  stakeOrg: number;
  health: number; inf: number; infDays: number; // inf: 0 susceptible · 1 exposed · 2 infectious · 3 hospitalised · 4 recovered
  happy: number; stress: number;
  trustGov: number; trustMedia: number; trustBiz: number; ideology: number;
  goal: string; spendMode: number;
  friends: number[]; partner: number;
  mem: Memory[]; ltm: Memory[];
  tier: number; // 0 low · 1 middle · 2 high · 3 top 1%
  unempMonths: number; refRealWage: number; protest: boolean; seeking: boolean; lastDecision: string; tenure: number;
  prefs: { food: number; retail: number; services: number };
}

export interface Household {
  id: number; members: number[]; district: number; building: number; alive: boolean;
  owns: boolean; rentBase: number; mortgage: number; arrears: number; hardship: number; homeless: boolean;
  income: number; essential: number; pp: number; foodShare: number; wclass: number;
}

export interface Org {
  id: number; name: string; type: OrgType; sector: Sector; district: number; building: number;
  alive: boolean; founded: number; closed: number; closeReason: string;
  employees: number[]; owner: number; managers: number[];
  cash: number; debt: number; funding: number; stage: string;
  revenue: number; budgetRev: number; expenses: number; profit: number; profitAvg: number; revAvg: number; wageBill: number;
  capacity: number; demand: number; util: number;
  productivity: number; reputation: number; share: number;
  wageLevel: number; openings: number; unfilled: number; freezeUntil: number; lossMonths: number;
  listed: boolean; shares: number; price: number; priceRef: number;
  objective: string; partners: number[];
  log: { t: number; d: string }[];
}

export interface Building {
  id: number; district: number; x: number; z: number; w: number; d: number; h: number;
  kind: BuildingKind; status: 'active' | 'vacant' | 'construction'; units: number; occupied: number;
  orgs: number[]; built: number; readyAt: number; name: string;
}

export interface Lot { x: number; z: number; used: boolean }

export interface District {
  id: number; name: string; kind: DistrictKind; wealth: number; x: number; z: number; w: number; d: number;
  lots: Lot[];
  rentIdx: number; crime: number; unemp: number; pop: number; infected: number; avgIncome: number; protest: number; activity: number; happy: number;
}

export interface Disease {
  id: number; name: string; beta: number; incubation: number; duration: number; severity: number; mortality: number;
  started: number; active: boolean; totalInfected: number; deaths: number; peak: number;
}

export interface TechItem {
  id: number; name: string; domain: string; emerged: number; adoption: number; speed: number;
  productivity: Partial<Record<Sector, number>>; automation: Partial<Record<Sector, number>>; healthBoost: number; energyEff: number; origin: string;
}

export interface Shock {
  id: number; name: string; kind: string; start: number; until: number; severity: number;
  exportMult: number; importPrice: Partial<Record<Good, number>>; confidence: number; migrants: number; note: string;
}

export interface SimEvent {
  id: number; t: number; cat: string; type: string; title: string; detail: string;
  sev: number; district: number; entity: string; causes: number[]; why: string; data?: Record<string, number | string>;
}

export interface Intervention { id: number; t: number; text: string; systems: string[]; eventId: number }

export interface SectorState { baseOutput: number; demand: number; capacity: number; prod: number; autom: number; baseWage: number; wageIdx: number; exports: number; importShare: number; firms: number; jobs: number; util: number; price: number }

export interface Party { name: string; ideology: number; support: number }

export interface Policy {
  minWage: number; incomeTax: number; corporateTax: number; salesTax: number; propertyTax: number; interestRate: number;
  tuitionSubsidy: number; healthSubsidy: number; unemploymentBenefit: number; pension: number; childBenefit: number; ubi: number;
  spendEducation: number; spendHealth: number; spendAdmin: number; spendResearch: number; spendInfrastructure: number; spendPolice: number;
  rentControl: number; immigration: number; restrictions: number; priceControlFood: number; wealthTax: number; startupSubsidy: number;
}

export interface World {
  v: number; seed: number; rng: number[]; tick: number; name: string;
  citizens: Citizen[]; households: Household[]; orgs: Org[]; buildings: Building[]; districts: District[];
  prices: Record<Good, number>; cpi: number; cpiHist: number[]; tuition: number; baseBudgets: Record<string, number>;
  sectors: Record<Sector, SectorState>;
  policy: Policy;
  gov: { leader: number; party: number; parties: Party[]; debt: number; revenue: number; spending: number; balance: number; approval: number; nextElection: number; locks: Record<string, number>; transfer: number; rev: Record<string, number>; out: Record<string, number>; actions: { t: number; d: string }[] };
  market: { index: number; indexBase: number; confidence: number; flow: number; credit: number; indexHist: number[]; vc: number };
  health: { diseases: Disease[]; beds: number; occupied: number; load: number; deathsYear: number; careQuality: number };
  edu: { capacity: number; enrolled: number; applicants: number; rejected: number; schoolQuality: number; graduates: number };
  tech: { level: number; progress: number; nextAt: number; items: TechItem[]; output: number };
  housing: { vacancy: number; avgRent: number; homeless: number; propertyIdx: number; supplyMult: number; pipeline: number };
  infra: { energyCap: number; energyUse: number; waterCap: number; waterUse: number; transport: number; quality: number };
  social: { stability: number; crime: number; protestShare: number; unrest: number; migIn: number; migOut: number; births: number; deaths: number; cohesion: number };
  ext: { shocks: Shock[]; globalDemand: number };
  mods: Record<string, number>;
  events: SimEvent[]; nextEventId: number; interventions: Intervention[];
  counters: Record<string, number>;
  metrics: Record<string, number>;
  history: { t: number[]; s: Record<string, number[]> };
  nextIds: { shock: number; disease: number; tech: number; intervention: number };
}

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function dateOf(tick: number): string {
  const y = 2040 + Math.floor(tick / DAYS_PER_YEAR);
  const m = Math.floor((tick % DAYS_PER_YEAR) / DAYS_PER_MONTH) + 1;
  const d = (tick % DAYS_PER_MONTH) + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
