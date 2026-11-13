// Parameter registry: the typed vocabulary of world conditions GOD MODE can change.
// Adding a new entry here makes it available to the LLM interpreter, the deterministic
// interpreter and the validator at once — no command handlers to write.
import type { World, Policy, Sector, Good } from '../sim/types';
import { SECTORS, clamp } from '../sim/types';
import { isActive } from '../sim/world';
import { recomputeTech } from '../sim/technology';

export type Unit = 'currency' | 'rate' | 'index' | 'multiplier' | 'share' | 'level';
export interface ParamDef {
  key: string; label: string; unit: Unit; systems: string[]; min: number; max: number; desc: string; synonyms: string[];
  sectorScoped?: boolean; lock?: keyof Policy;
  get(w: World, sector?: Sector): number;
  set(w: World, v: number, sector?: Sector): void;
}

const P: ParamDef[] = [];
const add = (d: ParamDef) => P.push(d);

function price(good: Good, label: string, syn: string[]) {
  add({ key: `price.${good}`, label, unit: 'index', systems: ['economy', good === 'housing' ? 'housing' : 'business', 'social'], min: 0.05, max: 50, desc: `Price index of ${good} (1.0 = founding level)`, synonyms: syn,
    get: (w) => w.prices[good], set: (w, v) => { w.prices[good] = v; if ((w.sectors as any)[good]) (w.sectors as any)[good].price = v; } });
}
price('food', 'Food prices', ['food prices', 'food price', 'price of food', 'cost of food', 'grocery prices', 'groceries', 'food costs', 'food']);
price('energy', 'Energy prices', ['energy prices', 'energy price', 'electricity prices', 'fuel prices', 'gas prices', 'oil prices', 'power prices', 'energy costs', 'cost of energy', 'fuel']);
price('housing', 'Rents', ['rents', 'rent', 'housing costs', 'housing prices', 'rental prices', 'cost of housing', 'rent prices']);
price('retail', 'Consumer goods prices', ['consumer goods prices', 'retail prices', 'goods prices', 'consumer prices', 'price of goods']);
price('services', 'Service prices', ['service prices', 'services prices', 'price of services']);
price('healthcare', 'Healthcare prices', ['healthcare costs', 'healthcare prices', 'medical costs', 'medicine prices', 'cost of healthcare', 'drug prices']);
add({ key: 'price.all', label: 'General price level', unit: 'index', systems: ['economy', 'social', 'business'], min: 0.05, max: 50, desc: 'All consumer prices at once (the CPI)', synonyms: ['all prices', 'prices', 'price level', 'cost of living', 'living costs', 'consumer price index', 'cpi'],
  get: (w) => w.cpi, set: (w, v) => { const f = v / w.cpi; for (const g of Object.keys(w.prices) as Good[]) { w.prices[g] *= f; if ((w.sectors as any)[g]) (w.sectors as any)[g].price *= f; } w.cpi = v; } });

function policy(k: keyof Policy, label: string, unit: Unit, min: number, max: number, systems: string[], desc: string, syn: string[]) {
  add({ key: `policy.${k}`, label, unit, systems, min, max, desc, synonyms: syn, lock: k, get: (w) => w.policy[k], set: (w, v) => { (w.policy[k] as number) = v; } });
}
policy('minWage', 'Minimum wage', 'currency', 0, 50000, ['labor', 'economy', 'business', 'politics'], 'Monthly minimum wage', ['minimum wages', 'minimum wage', 'min wage', 'wage floor', 'living wage']);
policy('incomeTax', 'Income tax rate', 'rate', 0, 0.9, ['politics', 'economy'], 'Base personal income tax rate', ['income taxes', 'income tax', 'personal taxes', 'personal tax', 'taxes on workers', 'taxes', 'tax']);
policy('corporateTax', 'Corporate tax rate', 'rate', 0, 0.9, ['politics', 'business', 'economy', 'market'], 'Tax on company profits', ['corporate taxes', 'corporate tax', 'company taxes', 'company tax', 'business taxes', 'business tax', 'corporation tax', 'taxes on companies', 'taxes on businesses', 'profit tax']);
policy('salesTax', 'Sales tax rate', 'rate', 0, 0.6, ['politics', 'economy'], 'Tax on consumer purchases', ['sales taxes', 'sales tax', 'vat', 'consumption tax', 'goods tax']);
policy('propertyTax', 'Property tax rate', 'rate', 0, 0.2, ['politics', 'housing'], 'Annual tax on property value', ['property taxes', 'property tax', 'land tax']);
policy('wealthTax', 'Wealth tax rate', 'rate', 0, 0.5, ['politics', 'economy', 'social'], 'Annual tax on fortunes above Ƶ1M', ['wealth tax', 'tax on the rich', 'tax the rich', 'tax on wealth', 'billionaire tax', 'tax on fortunes']);
policy('interestRate', 'Interest rate', 'rate', 0, 0.5, ['economy', 'market', 'housing', 'business'], 'Central bank policy rate', ['interest rates', 'interest rate', 'borrowing costs', 'central bank rate', 'policy rate', 'cost of borrowing']);
policy('tuitionSubsidy', 'Tuition subsidy', 'share', 0, 1, ['education', 'politics', 'economy'], 'Share of university tuition paid by government (1 = free university)', ['tuition subsidy', 'tuition subsidies', 'university subsidy', 'college subsidy']);
policy('healthSubsidy', 'Healthcare subsidy', 'share', 0, 1, ['health', 'politics'], 'Share of healthcare costs paid by government (1 = free healthcare)', ['healthcare subsidy', 'health subsidy', 'public healthcare coverage', 'health coverage', 'medical subsidy']);
policy('unemploymentBenefit', 'Unemployment benefit rate', 'share', 0, 1.5, ['labor', 'politics', 'social'], 'Benefit as a share of previous wage', ['unemployment benefits', 'unemployment benefit', 'jobless benefits', 'unemployment insurance', 'welfare', 'benefits']);
policy('pension', 'State pension', 'currency', 0, 50000, ['politics', 'social'], 'Monthly state pension', ['pensions', 'pension', 'retirement benefits', 'state pension']);
policy('childBenefit', 'Child benefit', 'currency', 0, 20000, ['politics', 'social'], 'Monthly benefit per child', ['child benefits', 'child benefit', 'family benefits', 'family allowance', 'child allowance']);
policy('ubi', 'Universal basic income', 'currency', 0, 50000, ['politics', 'social', 'economy', 'labor'], 'Monthly payment to every adult', ['universal basic income', 'basic income', 'ubi']);
policy('spendEducation', 'Education budget', 'multiplier', 0, 10, ['education', 'politics'], 'Public school/university funding relative to baseline', ['education spending', 'education budget', 'education funding', 'school funding', 'school budgets', 'spending on education', 'funding for schools']);
policy('spendHealth', 'Health budget', 'multiplier', 0, 10, ['health', 'politics'], 'Public hospital funding relative to baseline', ['health spending', 'healthcare spending', 'health budget', 'healthcare budget', 'hospital funding', 'healthcare funding', 'health funding', 'spending on health']);
policy('spendResearch', 'Research budget', 'multiplier', 0, 20, ['technology', 'politics'], 'Public research funding relative to baseline', ['research funding', 'research spending', 'research budget', 'r&d funding', 'science funding', 'r&d spending', 'science budget', 'funding for research']);
policy('spendInfrastructure', 'Infrastructure budget', 'multiplier', 0, 10, ['economy', 'politics', 'housing'], 'Infrastructure investment relative to baseline', ['infrastructure spending', 'infrastructure investment', 'infrastructure budget', 'public works', 'infrastructure', 'transport spending', 'road spending']);
policy('spendPolice', 'Police budget', 'multiplier', 0, 10, ['social', 'politics'], 'Police funding relative to baseline', ['police funding', 'police budget', 'police spending', 'policing', 'law enforcement', 'the police']);
policy('spendAdmin', 'Public administration budget', 'multiplier', 0, 10, ['politics', 'economy'], 'Government department funding relative to baseline', ['government spending', 'public spending', 'public expenditure', 'public administration', 'bureaucracy', 'government budget', 'public sector']);
policy('rentControl', 'Rent control', 'share', 0, 1, ['housing', 'politics'], 'Strength of rent control (1 = rents frozen)', ['rent control', 'rent controls', 'rent cap', 'rent freeze']);
policy('immigration', 'Immigration openness', 'multiplier', 0, 20, ['population', 'politics', 'labor'], 'Inflow of newcomers relative to baseline', ['immigration', 'immigration rate', 'migrant inflow', 'immigration quotas']);
policy('restrictions', 'Public health restrictions', 'share', 0, 1, ['health', 'economy', 'social'], 'Lockdown intensity (0 none, 1 full)', ['lockdown', 'lockdowns', 'public health restrictions', 'quarantine', 'curfew', 'social distancing']);
policy('startupSubsidy', 'Startup subsidy', 'share', 0, 3, ['business', 'technology', 'politics'], 'Government support for new ventures', ['startup subsidies', 'startup subsidy', 'startup grants', 'entrepreneur grants', 'support for startups']);
policy('priceControlFood', 'Food price cap', 'index', 0, 50, ['economy', 'politics'], 'Maximum food price index (0 = no cap)', ['food price cap', 'food price control', 'food price controls', 'cap on food prices']);

add({ key: 'edu.tuition', label: 'University tuition', unit: 'currency', systems: ['education', 'economy'], min: 0, max: 50000, desc: 'Monthly tuition fee per student before subsidy', synonyms: ['tuition fees', 'tuition', 'university fees', 'college fees', 'cost of university', 'cost of college'], get: (w) => w.tuition, set: (w, v) => { w.tuition = v; } });
add({ key: 'market.sharePrices', label: 'Share prices', unit: 'index', systems: ['market', 'business', 'economy'], min: 1, max: 1e6, sectorScoped: true, desc: 'Share prices of listed companies (market index, 1000 = founding level)', synonyms: ['share prices', 'share price', 'stock prices', 'stock price', 'stock market', 'stocks', 'equities', 'shares of every company', 'shares', 'market index', 'the market'],
  get: (w, s) => { if (!s) return w.market.index; let c = 0, n = 0; for (const o of w.orgs) if (o.alive && o.listed && o.sector === s) { c += o.price; n++; } return n ? c / n : 0; },
  set: (w, v, s) => { const cur = P.find((x) => x.key === 'market.sharePrices')!.get(w, s); if (cur <= 0) return; const f = v / cur; for (const o of w.orgs) if (o.alive && o.listed && (!s || o.sector === s)) o.price *= f; if (!s) { w.market.index *= f; w.market.confidence = clamp(w.market.confidence * (f < 1 ? Math.pow(f, 0.6) : Math.pow(f, 0.25)), 0.15, 1.5); } } });
add({ key: 'market.confidence', label: 'Market confidence', unit: 'level', systems: ['market', 'economy', 'business'], min: 0.05, max: 1.6, desc: 'Investor/consumer confidence (1.0 = neutral)', synonyms: ['market confidence', 'investor confidence', 'business confidence', 'consumer confidence', 'economic confidence', 'confidence', 'optimism'], get: (w) => w.market.confidence, set: (w, v) => { w.market.confidence = v; } });
add({ key: 'market.credit', label: 'Credit availability', unit: 'level', systems: ['market', 'business', 'economy'], min: 0.02, max: 1.5, desc: 'How freely banks lend (1.0 = normal)', synonyms: ['credit availability', 'bank lending', 'lending', 'credit', 'access to loans', 'loans'], get: (w) => w.market.credit, set: (w, v) => { w.market.credit = v; } });
add({ key: 'market.vc', label: 'Venture capital appetite', unit: 'multiplier', systems: ['business', 'technology', 'market'], min: 0, max: 20, desc: 'Willingness of investors to fund startups', synonyms: ['venture capital', 'investor appetite', 'vc funding', 'venture funding', 'angel investment'], get: (w) => w.market.vc, set: (w, v) => { w.market.vc = v; } });
add({ key: 'funding.startups', label: 'Startup funding', unit: 'currency', systems: ['business', 'technology', 'labor', 'market'], min: 0, max: 1e13, sectorScoped: true, desc: 'Total funding currently held by startups (scaled proportionally)', synonyms: ['startup funding', 'startups funding', 'funding of every startup', 'funding of startups', 'startup funds', 'startup capital', 'startup investment', 'funding for startups'],
  get: (w, s) => { let f = 0; for (const o of w.orgs) if (o.alive && o.type === 'startup' && (!s || o.sector === s)) f += o.funding; return f; },
  set: (w, v, s) => { const cur = P.find((x) => x.key === 'funding.startups')!.get(w, s); const list = w.orgs.filter((o) => o.alive && o.type === 'startup' && (!s || o.sector === s)); if (cur > 0) { const f = v / cur; for (const o of list) o.funding *= f; } else if (list.length) for (const o of list) o.funding = v / list.length; } });
add({ key: 'wages.all', label: 'Wages', unit: 'currency', systems: ['labor', 'business', 'economy'], min: 1, max: 1e7, sectorScoped: true, desc: 'Average monthly wage (all wages scale proportionally)', synonyms: ['employee salaries', 'salaries', 'wages', 'worker pay', 'salary', 'wage', 'paychecks', 'pay of workers', 'earnings'],
  get: (w, s) => { let t = 0, n = 0; for (const c of w.citizens) if (isActive(c) && (c.status === 'employed' || c.status === 'owner') && (!s || (c.employer >= 0 && w.orgs[c.employer].sector === s))) { t += c.wage; n++; } return n ? t / n : 0; },
  set: (w, v, s) => { const cur = P.find((x) => x.key === 'wages.all')!.get(w, s); if (cur <= 0) return; const f = v / cur; for (const c of w.citizens) if (isActive(c) && (c.status === 'employed' || c.status === 'owner') && (!s || (c.employer >= 0 && w.orgs[c.employer].sector === s))) { c.wage = Math.round(c.wage * f); c.refRealWage = c.wage / w.cpi; } for (const k of SECTORS) if (!s || k === s) w.sectors[k].wageIdx *= f; } });

function citizenField(key: string, label: string, field: 'trustGov' | 'trustMedia' | 'trustBiz' | 'happy' | 'health', systems: string[], syn: string[], desc: string) {
  add({ key, label, unit: 'level', systems, min: 0.01, max: 1, desc, synonyms: syn,
    get: (w) => { let t = 0, n = 0; for (const c of w.citizens) if (isActive(c) && c.age >= 18) { t += c[field]; n++; } return n ? t / n : 0; },
    set: (w, v) => { const cur = P.find((x) => x.key === key)!.get(w); for (const c of w.citizens) if (isActive(c)) c[field] = clamp(cur > 0.02 ? v + (c[field] - cur) * Math.min(1, v / cur) * 0.5 : v); } });
}
citizenField('social.trustGov', 'Trust in government', 'trustGov', ['politics', 'social'], ['trust in government', 'trust in the government', 'public trust', 'government trust', 'faith in government', 'trust of the government', 'confidence in government', 'trust in institutions', 'trust in politicians'], 'Average citizen trust in government (0–1)');
citizenField('social.trustMedia', 'Trust in media', 'trustMedia', ['social'], ['trust in media', 'trust in the media', 'trust in news', 'trust in journalists', 'media trust'], 'Average citizen trust in media (0–1)');
citizenField('social.trustBiz', 'Trust in business', 'trustBiz', ['social', 'business'], ['trust in business', 'trust in corporations', 'trust in companies', 'trust in banks'], 'Average citizen trust in business (0–1)');
citizenField('social.happiness', 'Happiness', 'happy', ['social'], ['happiness', 'morale', 'public satisfaction', 'life satisfaction', 'public mood', 'wellbeing', 'well-being'], 'Average citizen happiness (0–1)');
citizenField('health.population', 'Population health', 'health', ['health', 'social'], ['population health', 'public health', 'health of citizens', 'health of the population'], 'Average citizen health (0–1)');
add({ key: 'social.crime', label: 'Crime level', unit: 'level', systems: ['social'], min: 0, max: 1, desc: 'Average district crime level (0–1)', synonyms: ['crime levels', 'crime rate', 'crime', 'criminality'], get: (w) => w.social.crime, set: (w, v) => { const cur = Math.max(0.01, w.social.crime); for (const d of w.districts) d.crime = clamp(d.crime * v / cur); w.social.crime = v; } });
add({ key: 'social.corruption', label: 'Government corruption', unit: 'level', systems: ['politics', 'social'], min: 0, max: 1, desc: 'Perceived corruption (0–1); erodes trust every month', synonyms: ['government corruption', 'corruption', 'political corruption'], get: (w) => w.mods.corruption || 0, set: (w, v) => { w.mods.corruption = v; } });
add({ key: 'social.birthRate', label: 'Birth rate', unit: 'multiplier', systems: ['population'], min: 0, max: 10, desc: 'Births relative to baseline', synonyms: ['birth rate', 'birth rates', 'fertility rate', 'fertility', 'births'], get: (w) => w.mods.birthRate ?? 1, set: (w, v) => { w.mods.birthRate = v; } });
add({ key: 'tech.automation', label: 'Automation level', unit: 'level', systems: ['technology', 'labor', 'business'], min: -0.4, max: 3, sectorScoped: true, desc: 'Extra output per worker from automation (0 = none, 1 = each worker produces double)', synonyms: ['automation level', 'automation', 'robots', 'robotisation', 'robotization', 'ai automation'],
  get: (w, s) => { if (s) return w.sectors[s].autom; let a = 0; for (const k of SECTORS) a += w.sectors[k].autom; return a / SECTORS.length; },
  set: (w, v, s) => { const cur = P.find((x) => x.key === 'tech.automation')!.get(w, s); const d = v - cur; for (const k of SECTORS) if ((!s || k === s) && k !== 'government') w.mods[`autom.${k}`] = (w.mods[`autom.${k}`] ?? 0) + d; recomputeTech(w); } });
add({ key: 'tech.productivity', label: 'Productivity', unit: 'multiplier', systems: ['technology', 'economy', 'business'], min: 0.1, max: 20, sectorScoped: true, desc: 'Sector productivity multiplier (1 = founding level)', synonyms: ['worker productivity', 'labour productivity', 'labor productivity', 'productivity', 'efficiency'],
  get: (w, s) => { if (s) return w.sectors[s].prod; let a = 0; for (const k of SECTORS) a += w.sectors[k].prod; return a / SECTORS.length; },
  set: (w, v, s) => { const cur = P.find((x) => x.key === 'tech.productivity')!.get(w, s); const f = v / Math.max(0.01, cur); for (const k of SECTORS) if (!s || k === s) w.mods[`prod.${k}`] = (w.mods[`prod.${k}`] ?? 1) * f; recomputeTech(w); } });
add({ key: 'infra.energyCap', label: 'Energy supply', unit: 'multiplier', systems: ['economy', 'business', 'social'], min: 0.05, max: 20, desc: 'Generating capacity relative to baseline', synonyms: ['energy supply', 'power supply', 'electricity supply', 'energy capacity', 'power generation', 'energy production', 'electricity'], get: (w) => w.infra.energyCap, set: (w, v) => { w.infra.energyCap = v; } });
add({ key: 'infra.waterCap', label: 'Water supply', unit: 'multiplier', systems: ['social', 'health'], min: 0.05, max: 20, desc: 'Water supply relative to baseline', synonyms: ['water supply', 'water availability', 'water resources', 'water'], get: (w) => w.infra.waterCap, set: (w, v) => { w.infra.waterCap = v; } });
add({ key: 'housing.supply', label: 'Housing supply', unit: 'multiplier', systems: ['housing', 'social'], min: 0.2, max: 3, desc: 'Share of existing homes available (1 = all units usable)', synonyms: ['housing supply', 'housing stock', 'available housing', 'homes available', 'number of homes', 'housing availability'], get: (w) => w.housing.supplyMult, set: (w, v) => { w.housing.supplyMult = v; } });
add({ key: 'housing.propertyValues', label: 'Property values', unit: 'index', systems: ['housing', 'economy'], min: 0.05, max: 50, desc: 'Property price index', synonyms: ['property values', 'property prices', 'house prices', 'home prices', 'real estate prices', 'home values', 'real estate values'], get: (w) => w.housing.propertyIdx, set: (w, v) => { w.housing.propertyIdx = v; } });
add({ key: 'health.hospitalCapacity', label: 'Hospital capacity', unit: 'multiplier', systems: ['health'], min: 0.05, max: 20, desc: 'Hospital bed capacity relative to staffing baseline', synonyms: ['hospital capacity', 'hospital beds', 'healthcare capacity', 'medical capacity', 'number of hospital beds'], get: (w) => w.mods['health.capMult'] ?? 1, set: (w, v) => { const cur = w.mods['health.capMult'] ?? 1; w.mods['health.capMult'] = v; w.health.beds = Math.round(w.health.beds * v / cur); } });
add({ key: 'ext.exportDemand', label: 'Export demand', unit: 'multiplier', systems: ['economy', 'business', 'external'], min: 0, max: 20, sectorScoped: true, desc: 'Foreign demand for the city’s goods and services', synonyms: ['export demand', 'exports', 'foreign demand', 'global demand', 'international trade', 'foreign trade', 'trade with other countries'],
  get: (w, s) => (s ? w.mods[`export.${s}`] ?? 1 : w.mods.exportDemand ?? 1),
  set: (w, v, s) => { if (s) { const cur = w.mods[`export.${s}`] ?? 1; w.mods[`export.${s}`] = v; w.sectors[s].exports *= v / Math.max(0.001, cur); if (w.sectors[s].exports < 1 && v > cur) w.sectors[s].exports = (w.sectors[s].demand * w.sectors[s].price) * 0.2 * (v - cur); } else w.mods.exportDemand = v; } });
add({ key: 'population.savings', label: 'Household savings', unit: 'currency', systems: ['economy', 'social'], min: 0, max: 1e14, desc: 'Total citizen savings (scaled proportionally)', synonyms: ['household savings', 'personal savings', 'savings', 'household wealth', 'bank accounts', 'everyone’s money', "everyone's money", 'bank deposits'],
  get: (w) => { let t = 0; for (const c of w.citizens) if (isActive(c)) t += c.savings; return t; }, set: (w, v) => { const cur = P.find((x) => x.key === 'population.savings')!.get(w); const f = cur > 0 ? v / cur : 0; for (const c of w.citizens) if (isActive(c)) c.savings *= f; } });
add({ key: 'population.debt', label: 'Household debt', unit: 'currency', systems: ['economy', 'social'], min: 0, max: 1e14, desc: 'Total citizen debt (scaled proportionally)', synonyms: ['household debt', 'personal debt', 'consumer debt', 'student debt', 'debts', 'debt'],
  get: (w) => { let t = 0; for (const c of w.citizens) if (isActive(c)) t += c.debt; return t; }, set: (w, v) => { const cur = P.find((x) => x.key === 'population.debt')!.get(w); const f = cur > 0 ? v / cur : 0; for (const c of w.citizens) if (isActive(c)) c.debt *= f; } });
add({ key: 'gov.debt', label: 'Government debt', unit: 'currency', systems: ['politics', 'economy'], min: 0, max: 1e14, desc: 'Outstanding public debt', synonyms: ['government debt', 'public debt', 'national debt', 'sovereign debt'], get: (w) => w.gov.debt, set: (w, v) => { w.gov.debt = v; } });

export const PARAMS: ParamDef[] = P;
export const paramByKey = (k: string) => P.find((p) => p.key === k);

export function formatValue(unit: Unit, v: number): string {
  if (!isFinite(v)) return '—';
  switch (unit) {
    case 'currency': { const a = Math.abs(v); return (v < 0 ? '-' : '') + 'Ƶ' + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : Math.round(a).toLocaleString('en-US')); }
    case 'rate': case 'share': return (v * 100).toFixed(1) + '%';
    case 'index': return v >= 100 ? v.toFixed(0) : v.toFixed(2);
    default: return v.toFixed(2) + (unit === 'multiplier' ? '×' : '');
  }
}

/** Compact catalogue for the LLM interpreter prompt. */
export function paramCatalogue(w: World): string {
  return P.map((p) => `${p.key} [${p.unit}${p.sectorScoped ? ', sector-scopable' : ''}] = ${formatValue(p.unit, p.get(w))} — ${p.desc}`).join('\n');
}
