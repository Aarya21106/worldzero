// Economic Simulation Engine: household budgets -> sector demand -> firm accounting ->
// firm decisions -> prices, wages, credit and the stock market. Nothing here is scripted:
// every number is derived from individual citizens and organisations.
import type { World, Household, Org, Sector, Good, Citizen } from './types';
import { SECTORS, clamp, DAYS_PER_MONTH } from './types';
import { rand, gauss } from './rng';
import { isActive, isMarketOrg, isPrivateFirm, count, emit, remember, orgLog, closeOrg, separate, money, pct } from './world';

export const FOOD_Q = 265, ENERGY_Q = 95, HEALTH_Q = 60, EDU_UNI = 0.1, RES_UNI = 0.15;

/** Desired discretionary-spending mode given purchasing power and savings cushion. */
export function spendTarget(c: Citizen, pp: number, savingsMonths: number): number {
  const security = clamp((c.status === 'unemployed' ? 0.6 : 0) + (3 - Math.min(3, savingsMonths)) * 0.13);
  return clamp(0.4 + (pp - 0.9) * 0.75 + Math.min(savingsMonths, 12) * 0.02 - c.traits.frugal * 0.15 - security * 0.15, 0.3, 1.15);
}
export const INPUT: Record<Sector, number> = { food: 0.45, retail: 0.5, tech: 0.2, manufacturing: 0.5, finance: 0.2, healthcare: 0.25, education: 0.15, construction: 0.5, energy: 0.45, media: 0.25, services: 0.25, government: 0.12, research: 0.2 };
export const CPI_W: Record<Good, number> = { food: 0.2, housing: 0.28, energy: 0.08, retail: 0.17, services: 0.17, healthcare: 0.06, education: 0.04 };
const TAXED: Good[] = ['food', 'energy', 'retail', 'services'];
const GOOD_SECTOR: Partial<Record<Good, Sector>> = { food: 'food', retail: 'retail', services: 'services', healthcare: 'healthcare', education: 'education', energy: 'energy' };

export interface Flows { cons: Record<Good, number>; incomeTax: number; salesTax: number; benefits: number; pensions: number; tuitionSubsidy: number; healthSubsidy: number; propertyTax: number; interest: number; landlord: number; rentPaid: number; wealthTax: number }

export function equivSize(w: World, h: Household): number {
  let adults = 0, kids = 0;
  for (const id of h.members) { const c = w.citizens[id]; if (!isActive(c)) continue; if (c.age >= 14) adults++; else kids++; }
  return adults === 0 ? 0.5 * kids : 1 + (adults - 1) * 0.7 + kids * 0.5;
}

export function taxWedge(w: World) { return (1 + w.policy.salesTax) / 1.08; }

export function housingCost(w: World, h: Household): number {
  if (h.homeless) return 0;
  const d = w.districts[h.district];
  if (h.owns) return h.mortgage * (w.policy.interestRate + 0.015) / 12 + h.rentBase * 0.22 * w.prices.housing + h.rentBase * 150 * w.housing.propertyIdx * w.policy.propertyTax / 12;
  return h.rentBase * d.rentIdx * w.prices.housing;
}

/** Essential monthly cost of living for a household at current prices (full needs, no coping). */
export function essentialCost(w: World, h: Household): { food: number; housing: number; energy: number; health: number; healthFull: number; edu: number; eduFull: number; total: number } {
  const P = w.prices, tw = taxWedge(w), eq = equivSize(w, h);
  let fp = 0, n = 0, health = 0, edu = 0;
  for (const id of h.members) {
    const c = w.citizens[id]; if (!isActive(c)) continue;
    fp += c.prefs.food; n++;
    health += HEALTH_Q * (1 + (1 - c.health) * 4 + Math.max(0, c.age - 60) * 0.03) * (c.inf >= 2 && c.inf <= 3 ? 3 : 1);
    if (c.status === 'student') edu += w.tuition;
  }
  const food = eq * FOOD_Q * P.food * tw * (n ? fp / n : 1);
  const housing = housingCost(w, h);
  const energy = eq * ENERGY_Q * P.energy * tw;
  const healthFull = health * P.healthcare, eduFull = edu * P.education;
  const hs = healthFull * (1 - w.policy.healthSubsidy), es = eduFull * (1 - w.policy.tuitionSubsidy);
  return { food, housing, energy, health: hs, healthFull, edu: es, eduFull, total: food + housing + energy + hs + es };
}

export function grossIncome(w: World, c: Citizen): { earned: number; transfer: number; capital: number } {
  const pol = w.policy;
  let earned = 0, transfer = 0;
  if (c.status === 'employed' || c.status === 'owner') earned = c.wage;
  else if (c.status === 'unemployed') transfer = pol.unemploymentBenefit * Math.max(c.wage, 1900 * w.cpi) * (c.unempMonths > 18 ? 0.75 : 1);
  else if (c.status === 'retired') { transfer = pol.pension * w.cpi; earned = c.wage * w.cpi; } // c.wage = private pension for retirees
  else if (c.status === 'student') earned = 1300 * w.cpi; // part-time work and family support
  if (c.age >= 18) transfer += pol.ubi * w.cpi; else transfer += pol.childBenefit * w.cpi;
  const idx = w.market.index / w.market.indexBase;
  const capital = c.equity * idx * 0.0025 * clamp(w.market.confidence, 0.3, 1.2) + c.savings * Math.max(0, pol.interestRate - 0.012) / 12;
  return { earned, transfer, capital };
}

export function incomeTaxOn(w: World, taxable: number): number {
  return w.policy.incomeTax * Math.max(0, taxable - 800 * w.cpi) + 0.1 * Math.max(0, taxable - 9000 * w.cpi);
}

/** Household budget cycle. With dry=true nothing is mutated except derived household fields. */
export function householdBudgets(w: World, dry = false): Flows {
  const f: Flows = { cons: { food: 0, housing: 0, energy: 0, retail: 0, services: 0, healthcare: 0, education: 0 }, incomeTax: 0, salesTax: 0, benefits: 0, pensions: 0, tuitionSubsidy: 0, healthSubsidy: 0, propertyTax: 0, interest: 0, landlord: 0, rentPaid: 0, wealthTax: 0 };
  const pol = w.policy, conf = w.market.confidence, fear = w.mods.fear || 0, idx = w.market.index / w.market.indexBase;
  const tw = taxWedge(w), tauShare = pol.salesTax / (1 + pol.salesTax);
  const taxed = (good: Good, paid: number) => { const t = paid * tauShare; f.salesTax += t; f.cons[good] += paid - t; };
  for (const h of w.households) {
    if (!h.alive) continue;
    const adults: Citizen[] = [];
    let income = 0, liquid = 0, wealth = 0, mode = 0, tier = 0, pr = 0, ps = 0, students = 0;
    for (const id of h.members) {
      const c = w.citizens[id]; if (!isActive(c)) continue;
      const g = grossIncome(w, c);
      const tax = c.age >= 18 ? incomeTaxOn(w, g.earned + g.capital) : 0;
      const debtCost = c.debt * (pol.interestRate + 0.045) / 12;
      const wtax = pol.wealthTax > 0 ? Math.max(0, c.savings + c.equity * idx - 1e6) * pol.wealthTax / 12 : 0;
      const net = g.earned + g.transfer + g.capital - tax - debtCost - wtax;
      income += net;
      if (!dry) c.income = net;
      f.incomeTax += tax; f.interest += debtCost; f.wealthTax += wtax;
      if (c.status === 'retired') f.pensions += g.transfer; else f.benefits += g.transfer;
      if (c.age >= 18) { adults.push(c); liquid += c.savings; wealth += c.savings + c.equity * idx; mode += c.spendMode; tier = Math.max(tier, c.tier); pr += c.prefs.retail; ps += c.prefs.services; }
      if (c.status === 'student') students++;
    }
    if (!adults.length) { h.income = income; continue; }
    const na = adults.length; mode /= na; pr /= na; ps /= na;
    const e = essentialCost(w, h);
    let foodQ = 1, energyQ = 1, healthQ = 1, payHousing = e.housing;
    const creditRoom = Math.max(0, income * 5 * w.market.credit - adults.reduce((s, c) => s + c.debt, 0));
    if (income + liquid < e.total) {
      foodQ = 0.75; energyQ = 0.7; healthQ = 0.3;
      const minimal = e.food * foodQ + e.housing + e.energy * energyQ + e.health * healthQ + e.edu;
      if (income + liquid + creditRoom < minimal && !h.owns && !h.homeless) { payHousing = 0; if (!dry) h.arrears++; }
      if (!dry) { h.hardship++; count(w, `hardship.t${tier}`); }
    } else {
      if (income < e.total && liquid < 3 * e.total) { foodQ = 0.92; healthQ = 0.7; }
      if (!dry) { h.hardship = Math.max(0, h.hardship - 1); if (h.arrears > 0) h.arrears--; }
    }
    const paidFood = e.food * foodQ, paidEnergy = e.energy * energyQ, paidHealth = e.health * healthQ;
    const essentialPaid = paidFood + payHousing + paidEnergy + paidHealth + e.edu;
    h.income = income; h.essential = e.total; h.pp = income / Math.max(1, e.total); h.foodShare = Math.min(1.5, e.food / Math.max(300, income));
    // discretionary spending
    const free = Math.max(0, income - essentialPaid);
    const prop = [0.9, 0.74, 0.52, 0.22][tier] * mode * (0.7 + 0.3 * clamp(conf, 0.2, 1.4)) * (1 - fear * 0.3) * clamp(1 - (pol.interestRate - 0.035) * 1.5, 0.7, 1.08);
    const disc = free * clamp(prop, 0, 1) + Math.max(0, wealth - income * 3) * 0.0016 * mode * clamp(conf, 0.3, 1.3);
    const avoid = clamp(1 - pol.restrictions * 0.55 - fear * 0.45, 0.15, 1);
    let sR = 0.42 * pr, sS = 0.4 * ps * avoid;
    const sF = 0.08, sH = 0.04, sE = 0.02, sN = 0.04;
    const sum = sR + sS + sF + sH + sE + sN;
    const dscale = disc * (0.85 + 0.15 * avoid) / sum;
    taxed('food', paidFood + sF * dscale); taxed('energy', paidEnergy + sN * dscale); taxed('retail', sR * dscale); taxed('services', sS * dscale);
    f.cons.healthcare += paidHealth + sH * dscale; f.healthSubsidy += e.healthFull * pol.healthSubsidy * healthQ;
    f.cons.education += e.edu + sE * dscale; f.tuitionSubsidy += e.eduFull * pol.tuitionSubsidy;
    if (h.owns) { const ptax = h.rentBase * 150 * w.housing.propertyIdx * pol.propertyTax / 12; f.propertyTax += ptax; f.interest += h.mortgage * (pol.interestRate + 0.015) / 12; f.cons.housing += h.rentBase * 0.22 * w.prices.housing; }
    else { f.rentPaid += payHousing; f.cons.housing += payHousing; }
    if (dry) continue;
    const spent = essentialPaid + dscale * sum;
    const netEach = (income - spent) / na;
    for (const c of adults) {
      // each adult's own income share already counted in household income; settle by equal split of the surplus
      c.savings += netEach;
      if (c.savings < 0) { c.debt += -c.savings; c.savings = 0; }
      else if (c.debt > 0 && c.savings > c.income * 2) { const pay = Math.min(c.debt, c.savings * 0.1); c.debt -= pay; c.savings -= pay; }
    }
    // physical consequences of coping
    if (foodQ < 0.9 || healthQ < 0.9) for (const id of h.members) { const c = w.citizens[id]; if (!isActive(c)) continue; c.health = clamp(c.health - (foodQ < 0.8 ? 0.02 : 0.006) - (healthQ < 0.5 ? 0.012 : 0)); c.happy = clamp(c.happy - 0.04); c.stress = clamp(c.stress + 0.06); }
    if (h.hardship === 2) for (const c of adults) remember(w, c, 'hardship', `Could not cover essentials — food alone takes ${pct(h.foodShare, 0)} of our income`, -0.7);
    if (h.hardship >= 2 && students > 0 && e.edu > 0) for (const id of h.members) { const c = w.citizens[id]; if (c.status === 'student' && isActive(c) && rand(w) < 0.35) { c.status = 'unemployed'; c.role = 'Unemployed'; c.school = -1; c.studyLeft = 0; c.goal = 'find_job'; c.seeking = true; count(w, 'decision.dropout'); count(w, `decision.dropout.t${tier}`); remember(w, c, 'dropout', 'Dropped out of university — my family could not afford tuition', -0.8); } }
  }
  return f;
}

function capacityRaw(w: World, o: Org): number {
  let cap = 0;
  for (const id of o.employees) { const c = w.citizens[id]; cap += (0.55 + 0.9 * c.skill) * (c.inf >= 2 && c.inf <= 3 ? 0 : c.health < 0.4 ? 0.5 : 1); }
  return cap * o.productivity;
}
const overheadOf = (w: World, o: Org) => 120 * o.employees.length * w.prices.housing;

function shockExportMult(w: World): number { let m = 1; for (const s of w.ext.shocks) if (w.tick < s.until) m *= s.exportMult; return m; }

/** One-time calibration so the freshly generated economy starts near equilibrium. */
export function calibrateEconomy(w: World) {
  computeTiers(w);
  for (const o of w.orgs) { o.wageLevel = clamp(Math.pow(o.productivity, 0.8) * (0.97 + rand(w) * 0.06), 0.8, 1.3); }
  for (const o of w.orgs) for (const id of o.employees) { const c = w.citizens[id]; const base = w.sectors[o.sector].baseWage * o.wageLevel * (c.edu >= 4 ? 1.5 : c.edu === 3 ? 1.22 : c.edu === 2 ? 1 : 0.88) * (0.75 + 0.5 * c.skill); const mgr = o.managers.includes(id) ? 1.35 : id === o.owner ? 1.3 : 1; c.wage = Math.round(Math.max(w.policy.minWage, base * mgr)); c.refRealWage = c.wage; }
  const need = new Map<number, number>();
  const sumBy = (pred: (o: Org) => boolean) => w.orgs.filter(pred).reduce((s, o) => s + need.get(o.id)!, 0);
  for (const o of w.orgs) { let wages = 0; for (const id of o.employees) wages += w.citizens[id].wage; o.wageBill = wages; need.set(o.id, (wages + overheadOf(w, o)) / (1 - INPUT[o.sector] - 0.045)); }
  const B = w.baseBudgets;
  B.education = sumBy((o) => o.type === 'school') / (1 - EDU_UNI);
  B.research = (sumBy((o) => o.type === 'research_lab') * 0.75) / (1 - RES_UNI);
  B.health = sumBy((o) => o.type === 'hospital') * 0.5;
  B.police = sumBy((o) => o.name === 'Police Service');
  B.admin = Math.max(sumBy((o) => o.type === 'gov_department' && o.name !== 'Police Service') / 0.88, sumBy((o) => o.type === 'nonprofit') / 0.12);
  let totalWages = 0; for (const o of w.orgs) totalWages += o.wageBill;
  B.infrastructure = totalWages * 0.04;
  const students = w.citizens.filter((c) => c.status === 'student').length;
  const uniNeed = sumBy((o) => o.type === 'university') * 1.04;
  w.tuition = Math.round(clamp((uniNeed - EDU_UNI * B.education - RES_UNI * B.research) / Math.max(1, students), 350, 2600));
  householdBudgets(w, true);
  for (const c of w.citizens) if (c.age >= 18) { const h = w.households[c.hh]; let na = 0; for (const id of h.members) if (w.citizens[id].age >= 18) na++; c.spendMode = spendTarget(c, h.pp, c.savings / Math.max(1, h.essential / Math.max(1, na))); }
  const flows = householdBudgets(w, true);
  // estimated domestic demand per sector
  const b2b = w.orgs.reduce((s, o) => s + INPUT[o.sector] * need.get(o.id)!, 0);
  const invest = totalWages * 0.02, rnd = sumBy((o) => o.sector === 'tech' && isPrivateFirm(o)) * 0.04;
  w.mods['flow.b2b'] = b2b; w.mods['flow.invest'] = invest; w.mods['flow.rnd'] = rnd;
  const D = domesticDemand(w, flows);
  for (const s of SECTORS) {
    const S = w.sectors[s];
    const orgs = w.orgs.filter((o) => o.sector === s && isMarketOrg(o));
    S.firms = orgs.length;
    if (!orgs.length) continue;
    let req = 0, capRaw = 0;
    for (const o of orgs) { req += need.get(o.id)! * 1.065; capRaw += capacityRaw(w, o); }
    req -= budgetFor(w, s);
    req = Math.max(req, 1);
    if (D[s] < req) { S.exports = req - D[s]; S.importShare = 0; } else { S.exports = 0; S.importShare = 1 - req / D[s]; }
    S.baseOutput = req / 0.95 / Math.max(1e-6, capRaw);
    S.demand = req; S.capacity = req / 0.95; S.util = 0.95;
  }
  for (const o of w.orgs) {
    const n = need.get(o.id)!;
    o.revenue = n; o.revAvg = n; o.expenses = n * 0.94; o.profit = n * 0.05; o.profitAvg = n * 0.04; o.util = 0.95;
    o.cash = o.wageBill * (1.5 + rand(w) * 3);
    if (o.type === 'startup') { o.funding = o.wageBill * (8 + rand(w) * 14); o.cash = o.wageBill * 1.2; }
    if (o.type === 'investment_firm') o.funding = 2e6 + rand(w) * 6e6;
    if (o.listed) { o.price = Math.max(4, (o.profitAvg * 12 * 13 + o.cash * 0.6) / o.shares); o.priceRef = o.price; }
  }
  let cap = 0; for (const o of w.orgs) if (o.listed) cap += o.price * o.shares;
  w.mods['market.baseCap'] = cap;
  // fiscal closure: the external transfer balances the initial budget (≈1% deficit)
  const corpTaxEst = w.orgs.filter(isPrivateFirm).reduce((s, o) => s + o.profit, 0) * w.policy.corporateTax;
  const revenue = flows.incomeTax + flows.salesTax + flows.propertyTax + corpTaxEst + flows.rentPaid * 0.15;
  const spending = B.education + B.research + B.health + B.police + B.admin + B.infrastructure + flows.benefits + flows.pensions + flows.tuitionSubsidy + flows.healthSubsidy;
  w.gov.transfer = spending * 0.99 - revenue;
  w.gov.debt = spending * 14;
  w.infra.energyUse = 0.85; w.infra.waterUse = 0.8;
  let beds = 0; for (const o of w.orgs) if (o.type === 'hospital') beds += o.employees.length * 0.55;
  w.health.beds = Math.round(beds);
}

function budgetFor(w: World, s: Sector): number {
  const B = w.baseBudgets;
  if (s === 'education') return EDU_UNI * B.education + RES_UNI * B.research;
  if (s === 'healthcare') return B.health;
  if (s === 'research') return (1 - RES_UNI) * B.research;
  return 0;
}

function domesticDemand(w: World, f: Flows): Record<Sector, number> {
  const D = {} as Record<Sector, number>;
  for (const s of SECTORS) D[s] = 0;
  const b2b = w.mods['flow.b2b'] || 0, inv = w.mods['flow.invest'] || 0, rnd = w.mods['flow.rnd'] || 0;
  const infra = (w.baseBudgets.infrastructure || 0) * w.policy.spendInfrastructure * w.cpi;
  D.food = f.cons.food; D.retail = f.cons.retail; D.energy = f.cons.energy + b2b * 0.12;
  D.services = f.cons.services * 0.78 + b2b * 0.1; D.media = f.cons.services * 0.1 + b2b * 0.06;
  D.finance = f.cons.services * 0.12 + f.interest + f.rentPaid * 0.3 + b2b * 0.1;
  D.healthcare = f.cons.healthcare + f.healthSubsidy;
  D.education = f.cons.education + f.tuitionSubsidy;
  D.construction = f.cons.housing * 0.2 + infra * 0.7 + inv * 0.4 + b2b * 0.1 + (w.housing.pipeline || 0);
  D.tech = b2b * 0.22 + inv * 0.4 + infra * 0.15;
  D.manufacturing = b2b * 0.3 + inv * 0.2 + infra * 0.15 + f.cons.retail * 0.0;
  D.research = rnd;
  return D;
}

export function computeTiers(w: World) {
  const inc: { h: Household; v: number }[] = [];
  for (const h of w.households) { if (!h.alive) continue; let i = 0; for (const id of h.members) { const c = w.citizens[id]; if (isActive(c)) { const g = grossIncome(w, c); i += g.earned + g.transfer + g.capital; } } inc.push({ h, v: i / Math.max(0.5, equivSize(w, h)) }); }
  inc.sort((a, b) => a.v - b.v);
  const n = inc.length;
  inc.forEach((x, i) => { const t = i < n * 0.35 ? 0 : i < n * 0.8 ? 1 : 2; for (const id of x.h.members) { const c = w.citizens[id]; c.tier = t; } });
  const idx = w.market.index / w.market.indexBase;
  const wealth = w.citizens.filter((c) => isActive(c) && c.age >= 18).map((c) => ({ c, v: c.savings + c.equity * idx })).sort((a, b) => b.v - a.v);
  const top = Math.max(1, Math.round(wealth.length * 0.01));
  for (let i = 0; i < top; i++) wealth[i].c.tier = 3;
}

/** Monthly economy cycle. Returns flows for the government engine. */
export function monthlyEconomy(w: World): Flows {
  const pol = w.policy;
  // minimum wage is binding immediately
  for (const o of w.orgs) if (o.alive) for (const id of o.employees) { const c = w.citizens[id]; if (c.wage < pol.minWage && id !== o.owner) { c.wage = Math.round(pol.minWage); } }
  computeTiers(w);
  const flows = householdBudgets(w, false);
  // landlords receive part of rent
  const rich = w.citizens.filter((c) => isActive(c) && c.tier >= 2 && c.age >= 18);
  if (rich.length) { const pool = flows.rentPaid * 0.35; let ws = 0; for (const c of rich) ws += c.tier === 3 ? 6 : 1; for (const c of rich) c.savings += pool * (c.tier === 3 ? 6 : 1) / ws; }
  const D = domesticDemand(w, flows);
  const expMult = shockExportMult(w) * w.ext.globalDemand * (w.mods.exportDemand ?? 1);
  let b2b = 0, invest = 0, rnd = 0, corpTax = 0, bailouts = 0;
  const B = w.baseBudgets, idxn = w.cpi;
  const budgets = { education: B.education * pol.spendEducation * idxn, research: B.research * pol.spendResearch * idxn, health: B.health * pol.spendHealth * idxn, admin: B.admin * pol.spendAdmin * idxn, police: B.police * pol.spendPolice * idxn };
  const infraFactor = clamp(0.9 + 0.1 * w.infra.quality, 0.7, 1.08) * (w.infra.energyUse > 1 ? clamp(1 / w.infra.energyUse, 0.6, 1) : 1);
  // wage-bill shares for public budgets
  const wb = { school: 0, university: 0, hospital: 0, lab: 0, gov: 0, np: 0 };
  for (const o of w.orgs) { if (!o.alive) continue; let wages = 0; for (const id of o.employees) wages += w.citizens[id].wage; o.wageBill = wages; if (o.type === 'school') wb.school += wages; else if (o.type === 'university') wb.university += wages; else if (o.type === 'hospital') wb.hospital += wages; else if (o.type === 'research_lab') wb.lab += wages; else if (o.type === 'gov_department' && o.name !== 'Police Service') wb.gov += wages; else if (o.type === 'nonprofit') wb.np += wages; }
  let totalOutput = 0;
  const mInfl = w.cpiHist.length > 3 ? Math.pow(w.cpi / w.cpiHist[w.cpiHist.length - 4], 1 / 3) - 1 : 0;
  const u = w.metrics.unemployment ?? 0.06;
  // external competitiveness: outside buyers shift orders toward (away from) a city with labour slack (shortage)
  const slack = clamp(0.0025 + 0.1 * (u - 0.055), -0.005, 0.015);
  for (const s of SECTORS) {
    const S = w.sectors[s];
    S.exports *= 1 + slack; S.importShare = clamp(S.importShare * (1 - slack), 0, 0.95);
    const orgs = w.orgs.filter((o) => o.alive && o.sector === s);
    const market = orgs.filter(isMarketOrg);
    S.firms = market.length; S.jobs = orgs.reduce((n, o) => n + o.employees.length, 0);
    const mult = S.baseOutput * S.prod * (1 + S.autom) * infraFactor;
    let capSum = 0, wsum = 0;
    for (const o of orgs) { o.capacity = capacityRaw(w, o) * mult; if (isMarketOrg(o)) { capSum += o.capacity; wsum += o.capacity * (0.85 + 0.3 * o.reputation); } }
    const exportsNom = S.exports * Math.pow(S.price, -0.5) * Math.pow(S.prod * (1 + S.autom * 0.5), 0.9) * expMult * Math.pow(1.02, w.tick / 360);
    const nominal = D[s] * (1 - S.importShare) + exportsNom;
    S.demand = nominal / S.price; S.capacity = capSum; S.util = capSum > 0 ? S.demand / capSum : 0.95;
    for (const o of orgs) {
      let rev = 0;
      if (isMarketOrg(o) && wsum > 0) {
        o.share = o.capacity * (0.85 + 0.3 * o.reputation) / wsum;
        const real = (nominal * o.share) / S.price;
        o.demand = real; o.util = o.capacity > 0 ? real / o.capacity : 0;
        rev = Math.min(real, o.capacity * 1.02) * S.price;
      } else { o.share = 0; o.demand = 0; }
      let bud = 0;
      if (o.type === 'school') bud = wb.school ? budgets.education * (1 - EDU_UNI) * o.wageBill / wb.school : 0;
      else if (o.type === 'university') bud = wb.university ? (budgets.education * EDU_UNI + budgets.research * RES_UNI) * o.wageBill / wb.university : 0;
      else if (o.type === 'hospital') bud = wb.hospital ? budgets.health * o.wageBill / wb.hospital : 0;
      else if (o.type === 'research_lab') bud = wb.lab ? budgets.research * (1 - RES_UNI) * o.wageBill / wb.lab : 0;
      else if (o.type === 'gov_department') bud = o.name === 'Police Service' ? budgets.police : wb.gov ? budgets.admin * 0.88 * o.wageBill / wb.gov : 0;
      else if (o.type === 'nonprofit') bud = wb.np ? budgets.admin * 0.12 * o.wageBill / wb.np : 0;
      if (!isMarketOrg(o)) o.util = o.wageBill > 0 ? clamp(bud / ((o.wageBill + overheadOf(w, o)) / (1 - INPUT[s] - 0.045)), 0, 1.5) * 0.95 : 0.95;
      o.budgetRev = bud; o.revenue = rev + bud;
      const inputs = INPUT[s] * o.revenue * Math.pow(w.prices.energy, 0.25);
      const overhead = overheadOf(w, o);
      const interest = o.debt * (pol.interestRate + 0.03) / 12;
      const rd = (s === 'tech' || o.type === 'startup') && isPrivateFirm(o) ? 0.04 * o.revenue : 0;
      o.expenses = o.wageBill + inputs + overhead + interest + rd;
      o.profit = o.revenue - o.expenses;
      b2b += inputs; rnd += rd;
      totalOutput += o.revenue - inputs;
      let tax = 0;
      if (isPrivateFirm(o) && o.profit > 0) { tax = o.profit * pol.corporateTax; corpTax += tax; }
      o.cash += o.profit - tax;
      o.profitAvg = o.profitAvg * 0.7 + (o.profit - tax) * 0.3; o.revAvg = o.revAvg * 0.7 + o.revenue * 0.3;
      o.lossMonths = o.profit < 0 ? o.lossMonths + 1 : Math.max(0, o.lossMonths - 1);
      const r = orgDecisions(w, o, S.util);
      invest += r.invest; bailouts += r.bailout;
    }
    // sector price + wage dynamics
    // sticky prices: neutral inside the normal utilisation band, with a 2%/yr expectation anchor
    const gap = S.util > 0.98 ? S.util - 0.98 : S.util < 0.82 ? S.util - 0.82 : 0;
    const pressure = 0.00165 + clamp(0.16 * gap, -0.006, 0.035);
    const bargaining = clamp(1.25 - u * 6, 0.25, 1.1);
    const wageGrowth = clamp(0.55 * Math.max(0, mInfl) * bargaining + clamp(0.06 * (S.util - 0.92), -0.002, 0.004) + (u < 0.04 ? 0.002 : 0) - clamp((u - 0.09) * 0.02, 0, 0.003), -0.004, 0.03);
    S.wageIdx *= 1 + wageGrowth;
    if (wageGrowth !== 0) for (const o of orgs) for (const id of o.employees) { const c = w.citizens[id]; const nw = Math.round(c.wage * (1 + wageGrowth * 0.7)); c.wage = id === o.owner ? nw : Math.max(Math.round(pol.minWage), nw); } // the legal minimum binds after wage drift too
    S.price = Math.max(0.15, S.price * (1 + pressure + 0.3 * wageGrowth));
  }
  // energy & import price pass-through on goods
  for (const g of Object.keys(GOOD_SECTOR) as Good[]) {
    let p = w.sectors[GOOD_SECTOR[g]!].price;
    if (g === 'food' && pol.priceControlFood > 0) p = Math.min(p, pol.priceControlFood);
    w.sectors[GOOD_SECTOR[g]!].price = p; w.prices[g] = p;
  }
  w.mods['flow.b2b'] = b2b; w.mods['flow.invest'] = invest; w.mods['flow.rnd'] = rnd;
  w.mods['flow.output'] = totalOutput; w.mods['flow.corpTax'] = corpTax; w.mods['flow.bailouts'] = bailouts;
  // CPI
  let rent = 0, nr = 0; for (const d of w.districts) if (d.kind === 'residential') { rent += d.rentIdx; nr++; }
  const tw = taxWedge(w);
  let cpi = 0; for (const g of Object.keys(CPI_W) as Good[]) cpi += CPI_W[g] * w.prices[g] * (TAXED.includes(g) ? tw : 1) * (g === 'housing' ? rent / Math.max(1, nr) : 1);
  w.cpi = cpi; w.cpiHist.push(cpi); if (w.cpiHist.length > 40) w.cpiHist.shift();
  // credit conditions
  let bankCash = 0, bankExp = 0; for (const o of w.orgs) if (o.alive && o.type === 'bank') { bankCash += o.cash; bankExp += o.expenses; }
  const target = clamp(0.45 + 0.35 * clamp(bankCash / Math.max(1, bankExp * 3), 0, 1.5) + 0.3 * (w.market.confidence - 0.6) - (pol.interestRate - 0.035) * 4, 0.1, 1.5);
  w.market.credit += (target - w.market.credit) * 0.3;
  return flows;
}

/** Organisation Engine: each organisation reacts to its own books. */
function orgDecisions(w: World, o: Org, sectorUtil: number): { invest: number; bailout: number } {
  const emp = o.employees.length, priv = isPrivateFirm(o);
  let invest = 0, bailout = 0;
  if (o.type === 'startup' && o.cash < 0) { const draw = Math.min(o.funding, -o.cash); o.funding -= draw; o.cash += draw; }
  // small-business owners absorb losses from their own pay
  if (o.type === 'small_business' && o.owner >= 0) {
    const ow = w.citizens[o.owner], normal = Math.max(w.policy.minWage, w.sectors[o.sector].baseWage * w.sectors[o.sector].wageIdx * 1.3);
    if (o.profit < 0 && ow.wage > normal * 0.4) { const cut = Math.min(-o.profit, ow.wage - normal * 0.4); ow.wage = Math.round(ow.wage - cut * 0.6); o.cash += cut * 0.6; }
    else if (o.profitAvg > 0.08 * o.revAvg && ow.wage < normal * 1.6) ow.wage = Math.round(ow.wage + Math.min(o.profit * 0.2, normal * 0.04));
  }
  // dividends / owner draws
  if (priv && o.profit > 0 && o.cash > o.expenses * 4) {
    const div = o.profit * 0.4; o.cash -= div;
    if (o.owner >= 0 && isActive(w.citizens[o.owner])) w.citizens[o.owner].savings += div * 0.8;
  }
  const frozen = w.tick < o.freezeUntil;
  // staffing
  const runway = o.type === 'startup' ? (o.funding + o.cash) / Math.max(1, -o.profit) : 99;
  const healthy = o.profitAvg >= -0.02 * o.revAvg || (o.type === 'startup' && runway > 9);
  if (o.util > 1.0 && healthy && !frozen && o.cash > -o.expenses * 0.5) {
    const want = Math.max(1, Math.round(emp * Math.min(0.12, o.util - 0.96)));
    if (o.openings < want) { o.openings = want; orgLog(w, o, `Opened ${want} position(s): demand at ${pct(o.util, 0)} of capacity`); }
  } else if (emp > (o.owner >= 0 ? 1 : 2) && (o.util < 0.8 || (o.lossMonths >= 3 && o.cash < o.expenses * 1.2) || (o.type === 'startup' && runway < 3))) {
    const frac = clamp((0.9 - o.util) * 0.6 + (o.lossMonths >= 3 ? 0.07 : 0) + (o.type === 'startup' && runway < 3 ? 0.2 : 0), 0.04, 0.3);
    const n = Math.min(emp - 1, Math.max(1, Math.round(emp * frac)));
    layoff(w, o, n, o.util < 0.8 ? `demand covers only ${pct(o.util, 0)} of capacity` : o.type === 'startup' && runway < 3 ? `only ${Math.max(0, runway).toFixed(1)} months of funding left` : `${o.lossMonths} consecutive loss-making months`);
    o.openings = 0;
  } else if (o.util < 0.86) o.openings = 0;
  else if (!frozen && o.openings === 0 && o.util > 0.9) {
    // growth-seeking: profitable firms expand to win share; funded public bodies fill posts
    const u = w.metrics.unemployment ?? 0.06;
    if (priv && o.profitAvg > 0.05 * o.revAvg && o.cash > o.expenses && rand(w) < 0.26 * clamp(w.market.confidence, 0.2, 1.3) * (u > 0.045 ? 1 + (u - 0.045) * 10 : 0.3)) o.openings = 1 + Math.round(emp * 0.04);
    else if (!priv && o.cash > o.expenses * 2.5 && rand(w) < 0.3) o.openings = 1;
  }
  // wage policy
  if (o.openings > 0) { o.unfilled++; if (o.unfilled >= 2 && o.cash > 0) { o.wageLevel = Math.min(1.6, o.wageLevel * 1.02); count(w, 'org.wage_raise'); } } else o.unfilled = 0;
  if (o.lossMonths >= 3) { o.wageLevel = Math.max(0.75, o.wageLevel * 0.992); o.productivity = Math.min(1.8, o.productivity * 1.004); }
  // investment
  if (priv && o.profit > 0 && w.market.confidence > 0.75 && o.cash > o.expenses * 3 && !frozen) {
    invest = o.profit * 0.2 * clamp(1.3 - (w.policy.interestRate - 0.035) * 8, 0.2, 1.5); o.cash -= invest;
    o.productivity = Math.min(1.8, o.productivity * (1 + 0.0025 * clamp(invest / Math.max(1, o.revenue) * 20, 0, 2))); count(w, 'org.investments');
  }
  o.reputation = clamp(o.reputation + (clamp(0.55 + (o.productivity - 1) * 0.6 + (o.wageLevel - 1) * 0.4, 0.1, 1) - o.reputation) * 0.05);
  // listed firms: a collapsing share price raises the cost of capital
  if (o.listed && o.priceRef > 0 && o.price < o.priceRef * 0.72 && !frozen) { o.freezeUntil = w.tick + 120; o.openings = 0; orgLog(w, o, `Hiring and investment frozen: shares down ${pct(1 - o.price / o.priceRef, 0)} in 90 days`); count(w, 'org.freeze'); }
  // solvency
  if (o.cash < 0) {
    if (!priv) { if (o.cash < -o.expenses) { bailout = -o.cash; o.cash = 0; if (emp > 3 && o.util < 0.9) layoff(w, o, Math.max(1, Math.round(emp * clamp((0.95 - o.util) * 0.5, 0.02, 0.15))), 'public budget no longer covers payroll'); } }
    else {
      const limit = 5 * o.revAvg * w.market.credit, worthy = o.lossMonths < 5 && w.market.credit > 0.35;
      if (worthy && o.debt - o.cash <= limit) { o.debt += -o.cash; o.cash = 0; count(w, 'org.loans'); }
      else if (o.cash < -o.expenses * 1.2 || o.lossMonths >= 6) {
        closeOrg(w, o, o.type === 'startup' ? `funding exhausted after ${o.lossMonths} loss-making months (credit conditions ${w.market.credit.toFixed(2)})` : `insolvent: ${o.lossMonths} loss-making months, cash ${money(o.cash)}, sector running at ${pct(sectorUtil, 0)} of capacity`);
        count(w, 'org.bankrupt');
        return { invest, bailout };
      }
    }
  } else if (o.debt > 0 && o.cash > o.expenses * 3) { const pay = Math.min(o.debt, o.cash * 0.15); o.debt -= pay; o.cash -= pay; }
  // startups: funding rounds and graduation
  if (o.type === 'startup') {
    if (runway < 7 && o.employees.length > 0) {
      const appetite = clamp(w.market.confidence, 0.1, 1.4) * w.market.vc * clamp(1 - (w.policy.interestRate - 0.035) * 6, 0.2, 1.4) * (1 + w.policy.startupSubsidy);
      if (rand(w) < 0.16 * appetite * (o.revAvg > 0 && o.util > 0.9 ? 1.3 : 0.8)) {
        const investors = w.orgs.filter((x) => x.alive && x.type === 'investment_firm' && x.funding > 2e5);
        if (investors.length) {
          const inv = investors[Math.floor(rand(w) * investors.length)];
          const amt = Math.min(inv.funding * 0.25, Math.max(1.5e5, -o.profit * (12 + rand(w) * 8)));
          inv.funding -= amt; o.funding += amt;
          o.stage = o.stage === 'Seed' ? 'Series A' : o.stage === 'Series A' ? 'Series B' : 'Growth';
          if (!o.partners.includes(inv.id)) o.partners.push(inv.id);
          orgLog(w, o, `Raised ${money(amt)} from ${inv.name}`); count(w, 'org.funding_round');
          emit(w, { cat: 'business', type: 'funding', title: `${o.name} raises ${money(amt)}`, detail: `${o.stage} round led by ${inv.name}.`, sev: 0.15, district: o.district, entity: `org:${o.id}`, why: `investor appetite ${appetite.toFixed(2)} (confidence ${w.market.confidence.toFixed(2)})` });
        }
      }
    }
    if (o.profitAvg > 0 && o.employees.length >= 40) { o.type = 'corporation'; o.listed = true; o.shares = 1e6; o.price = Math.max(4, (o.profitAvg * 12 * 14 + o.cash * 0.6) / o.shares); o.priceRef = o.price; o.objective = 'profit'; emit(w, { cat: 'market', type: 'ipo', title: `${o.name} goes public`, detail: `The former startup lists with ${o.employees.length} employees.`, sev: 0.4, district: o.district, entity: `org:${o.id}` }); count(w, 'org.ipo'); }
  }
  if (o.type === 'investment_firm') o.funding += Math.max(0, o.profit) * 0.6 + o.funding * 0.004 * clamp(w.market.confidence, 0, 1.3);
  return { invest, bailout };
}

export function layoff(w: World, o: Org, n: number, why: string) {
  const emps = o.employees.filter((id) => id !== o.owner).map((id) => w.citizens[id]).sort((a, b) => a.skill + a.tenure / 240 - (b.skill + b.tenure / 240));
  n = Math.min(n, emps.length);
  if (n <= 0) return;
  for (let i = 0; i < n; i++) { separate(w, o, emps[i], 'layoff'); count(w, `layoff.t${emps[i].tier}`); }
  count(w, 'org.layoffs', n); count(w, 'org.layoff_rounds');
  orgLog(w, o, `Laid off ${n}: ${why}`);
  if (n >= 8) emit(w, { cat: 'labor', type: 'layoffs', title: `${o.name} lays off ${n} workers`, detail: `${o.employees.length} employees remain.`, sev: clamp(0.2 + n / 80), district: o.district, entity: `org:${o.id}`, why, data: { jobs: n } });
}

/** Daily stock market: prices chase fundamentals under confidence, rates and order flow. */
export function dailyMarkets(w: World) {
  const m = w.market, rate = w.policy.interestRate;
  const pe = 13 * clamp(m.confidence, 0.15, 1.6) * clamp(1 - (rate - 0.035) * 6, 0.35, 1.5);
  let cap = 0;
  const flow = clamp(m.flow, -0.03, 0.03);
  for (const o of w.orgs) {
    if (!o.listed || !o.alive) continue;
    const ann = o.profitAvg * 12;
    const target = Math.max(0.5, ann > 0 ? (ann * pe + Math.max(0, o.cash) * 0.6 - o.debt * 0.4) / o.shares : (Math.max(0, o.cash) * 0.6 + o.revAvg * 3 * clamp(m.confidence, 0.2, 1.2)) / o.shares);
    o.price = Math.max(0.2, o.price + (target - o.price) * 0.02 + o.price * (gauss(w, 0, 0.011) + flow));
    cap += o.price * o.shares;
    if (w.tick % 90 === 0) o.priceRef = o.price;
  }
  m.flow *= 0.8;
  const base = w.mods['market.baseCap'] || cap || 1;
  m.index = (cap / base) * m.indexBase;
  m.indexHist.push(m.index); if (m.indexHist.length > 400) m.indexHist.shift();
  const h = m.indexHist, past = h[Math.max(0, h.length - 31)];
  const u = w.metrics.unemployment ?? 0.06;
  const target = clamp(1 + 0.7 * (m.index / past - 1) - 2.5 * (u - (w.mods['base.u'] ?? 0.06)) + (w.social.stability - (w.mods['base.stability'] ?? 0.7)) * 0.8 - (w.mods.fear || 0) * 0.5 + shockConfidence(w), 0.15, 1.5);
  m.confidence += (target - m.confidence) * 0.012;
  if (w.tick % DAYS_PER_MONTH === 0 && h.length > 31 && m.index < past * 0.8) { emit(w, { cat: 'market', type: 'crash', title: `Markets fall ${pct(1 - m.index / past, 0)} in a month`, detail: `Index at ${m.index.toFixed(0)}, confidence ${m.confidence.toFixed(2)}.`, sev: 0.7, why: `price/earnings multiple compressed to ${pe.toFixed(1)}` }); }
}
function shockConfidence(w: World): number { let c = 0; for (const s of w.ext.shocks) if (w.tick < s.until) c += s.confidence; return c; }
