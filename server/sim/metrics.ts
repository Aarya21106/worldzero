// Analytics: every headline number is computed from the underlying entities — never stored decoratively.
import type { World } from './types';
import { isActive, isPrivateFirm } from './world';
import { INPUT } from './economy';

export function computeMetrics(w: World) {
  const m = w.metrics, idx = w.market.index / w.market.indexBase;
  let pop = 0, adults = 0, lf = 0, emp = 0, unemp = 0, trust = 0, happy = 0, health = 0, edu = 0, wageSum = 0, wageN = 0, students = 0, infected = 0, totalEquity = 0, children = 0, retired = 0, protesters = 0;
  for (const c of w.citizens) {
    if (!isActive(c)) continue;
    pop++; health += c.health;
    if (c.inf === 2 || c.inf === 3) infected++;
    if (c.age < 18) { children++; continue; }
    adults++; trust += c.trustGov; happy += c.happy; edu += c.edu; totalEquity += c.equity * idx;
    if (c.protest) protesters++;
    if (c.status === 'student') students++;
    if (c.status === 'retired') retired++;
    if (c.status === 'employed' || c.status === 'owner') { emp++; lf++; wageSum += c.wage; wageN++; } else if (c.status === 'unemployed') { unemp++; lf++; }
  }
  const incomes: number[] = [], pps: number[] = [];
  let wealth = 0, hh = 0, poor = 0, foodLow = 0, nLow = 0, homeless = 0, ppLow = 0, ppHigh = 0, nHigh = 0;
  for (const h of w.households) {
    if (!h.alive) continue;
    hh++; incomes.push(h.income); pps.push(h.pp);
    if (h.pp < 1) poor++;
    if (h.homeless) homeless++;
    let tier = 0;
    for (const id of h.members) { const c = w.citizens[id]; if (!isActive(c) || c.age < 18) continue; wealth += c.savings + c.equity * idx - c.debt; tier = Math.max(tier, c.tier); }
    if (h.owns) wealth += h.rentBase * 150 * w.housing.propertyIdx - h.mortgage;
    if (tier === 0) { foodLow += h.foodShare; ppLow += h.pp; nLow++; } else if (tier >= 2) { ppHigh += h.pp; nHigh++; }
  }
  incomes.sort((a, b) => a - b); pps.sort((a, b) => a - b);
  let gini = 0; const n = incomes.length; if (n) { let cum = 0, tot = 0; for (let i = 0; i < n; i++) { const v = Math.max(0, incomes[i]); cum += (i + 1) * v; tot += v; } gini = tot > 0 ? (2 * cum) / (n * tot) - (n + 1) / n : 0; }
  let businesses = 0, startups = 0, funding = 0, corporations = 0, small = 0, output = 0, orgsAlive = 0, profitSum = 0;
  for (const o of w.orgs) { if (!o.alive) continue; orgsAlive++; output += o.revenue * (1 - INPUT[o.sector]); if (isPrivateFirm(o)) { businesses++; profitSum += o.profit; } if (o.type === 'startup') { startups++; funding += o.funding; } else if (o.type === 'corporation') corporations++; else if (o.type === 'small_business') small++; }
  const H = w.cpiHist, L = H.length;
  const inflation = L >= 13 ? w.cpi / H[L - 13] - 1 : L > 1 ? w.cpi / H[0] - 1 : 0; // 12-month change (since founding in year one)
  let autom = 0, ns = 0; for (const s of Object.values(w.sectors)) { autom += s.autom; ns++; }
  m.population = pop; m.households = hh; m.adults = adults; m.children = children; m.retired = retired; m.labourForce = lf; m.employed = emp; m.unemployed = unemp;
  m.unemployment = lf ? unemp / lf : 0;
  m.gdp = (w.mods['flow.output'] || output) * 12; m.gdpReal = m.gdp / w.cpi; m.gdpPerCapita = m.gdpReal / Math.max(1, pop);
  m.inflation = inflation; m.cpi = w.cpi;
  m.avgHouseholdWealth = hh ? wealth / hh : 0; m.medianIncome = n ? incomes[Math.floor(n / 2)] : 0; m.gini = gini;
  m.publicTrust = adults ? trust / adults : 0; m.happiness = adults ? happy / adults : 0; m.stability = w.social.stability; m.approval = w.gov.approval;
  m.marketIndex = w.market.index; m.confidence = w.market.confidence; m.credit = w.market.credit; m.interestRate = w.policy.interestRate;
  m.businesses = businesses; m.startups = startups; m.corporations = corporations; m.smallBusinesses = small; m.organisations = orgsAlive; m.startupFunding = funding; m.corporateProfits = profitSum * 12;
  m.avgRent = w.housing.avgRent; m.vacancy = w.housing.vacancy; m.homelessRate = hh ? homeless / hh : 0; m.propertyIndex = w.housing.propertyIdx;
  m.crime = w.social.crime; m.protestShare = adults ? protesters / adults : 0; m.unrest = w.social.unrest;
  m.health = pop ? health / pop : 0; m.infected = infected; m.infectedShare = pop ? infected / pop : 0; m.hospitalLoad = w.health.load; m.hospitalBeds = w.health.beds;
  m.students = students; m.uniCapacity = w.edu.capacity; m.avgEducation = adults ? edu / adults : 0; m.schoolQuality = w.edu.schoolQuality;
  m.techLevel = w.tech.level; m.automation = ns ? autom / ns : 0; m.researchOutput = w.tech.output; m.technologies = w.tech.items.length;
  m.govBalance = w.gov.balance * 12; m.govDebt = w.gov.debt; m.govRevenue = w.gov.revenue * 12; m.govSpending = w.gov.spending * 12;
  m.minWage = w.policy.minWage; m.avgWage = wageN ? wageSum / wageN : 0; m.realWage = m.avgWage / w.cpi;
  m.povertyRate = hh ? poor / hh : 0; m.purchasingPower = pps.length ? pps[Math.floor(pps.length / 2)] : 0; m.purchasingPowerLow = nLow ? ppLow / nLow : 0; m.purchasingPowerHigh = nHigh ? ppHigh / nHigh : 0; m.foodShareLow = nLow ? foodLow / nLow : 0;
  m.priceFood = w.prices.food; m.priceEnergy = w.prices.energy; m.priceHousing = w.prices.housing; m.priceRetail = w.prices.retail; m.priceServices = w.prices.services; m.priceHealthcare = w.prices.healthcare;
  m.totalEquity = totalEquity; m.energyLoad = w.infra.energyUse; m.infrastructure = w.infra.quality;
  m.openings = m.openings || 0;
}

export function recordHistory(w: World) {
  const h = w.history;
  h.t.push(w.tick);
  for (const k of Object.keys(w.metrics)) { (h.s[k] ||= new Array(h.t.length - 1).fill(w.metrics[k])).push(w.metrics[k]); }
  if (h.t.length > 240) { h.t.shift(); for (const k of Object.keys(h.s)) h.s[k].shift(); }
}

/** Cheap daily refresh of the fast-moving headline numbers. */
export function refreshDaily(w: World) {
  const m = w.metrics;
  m.marketIndex = w.market.index; m.confidence = w.market.confidence;
  if (w.tick % 7 === 0) {
    let lf = 0, un = 0, pop = 0;
    for (const c of w.citizens) { if (!isActive(c)) continue; pop++; if (c.age < 18) continue; if (c.status === 'employed' || c.status === 'owner') lf++; else if (c.status === 'unemployed') { lf++; un++; } }
    m.population = pop; m.labourForce = lf; m.unemployed = un; m.employed = lf - un; m.unemployment = lf ? un / lf : 0;
  }
}
