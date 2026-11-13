// Governance Engine: budget, autonomous political leadership, central bank and elections.
// God-mode decrees lock a policy key so the autonomous government will not silently undo them.
import type { World, Policy } from './types';
import { clamp, DAYS_PER_YEAR } from './types';
import { rand } from './rng';
import { isActive, emit, count, pct } from './world';
import type { Flows } from './economy';

const locked = (w: World, k: keyof Policy) => (w.gov.locks[k] || 0) > w.tick;

function act(w: World, d: string, why: string, sev = 0.25) {
  w.gov.actions.push({ t: w.tick, d }); if (w.gov.actions.length > 14) w.gov.actions.shift();
  count(w, 'gov.actions');
  emit(w, { cat: 'politics', type: 'policy', title: d, detail: `Decision by the ${w.gov.parties[w.gov.party].name} administration.`, sev, why, district: w.districts.find((x) => x.kind === 'government')!.id });
}

export function monthlyGovernment(w: World, f: Flows) {
  const g = w.gov, pol = w.policy, B = w.baseBudgets, cpi = w.cpi;
  const trust = w.metrics.publicTrust ?? 0.55;
  const compliance = clamp(0.72 + 0.5 * trust, 0.6, 1);
  g.rev = { incomeTax: f.incomeTax * compliance, salesTax: f.salesTax * compliance, corporateTax: (w.mods['flow.corpTax'] || 0) * compliance, propertyTax: f.propertyTax + f.rentPaid * 0.15, wealthTax: f.wealthTax, transfers: Math.max(0, g.transfer * cpi) };
  g.out = {
    education: B.education * pol.spendEducation * cpi, health: B.health * pol.spendHealth * cpi, administration: B.admin * pol.spendAdmin * cpi, police: B.police * pol.spendPolice * cpi,
    research: B.research * pol.spendResearch * cpi, infrastructure: B.infrastructure * pol.spendInfrastructure * cpi,
    benefits: f.benefits, pensions: f.pensions, tuitionSubsidy: f.tuitionSubsidy, healthSubsidy: f.healthSubsidy, bailouts: w.mods['flow.bailouts'] || 0,
    debtInterest: Math.max(0, g.debt) * (pol.interestRate + 0.008) / 12, externalPayments: Math.max(0, -g.transfer * cpi),
  };
  g.revenue = Object.values(g.rev).reduce((a, b) => a + b, 0);
  g.spending = Object.values(g.out).reduce((a, b) => a + b, 0);
  g.balance = g.revenue - g.spending;
  g.debt -= g.balance;
  w.infra.quality += (clamp(Math.pow(pol.spendInfrastructure, 0.6), 0.4, 1.5) - w.infra.quality) * 0.04;
  w.infra.transport = w.infra.quality;

  // ---- central bank (monthly, gradual) ------------------------------------------
  if (!locked(w, 'interestRate')) {
    const infl = w.metrics.inflation ?? 0.02, u = w.metrics.unemployment ?? 0.06;
    const target = clamp(0.015 + infl + 0.5 * (infl - 0.025) - 0.5 * (u - 0.06), 0.002, 0.2);
    const step = clamp(target - pol.interestRate, -0.0025, 0.004);
    const before = pol.interestRate; pol.interestRate = clamp(pol.interestRate + step, 0.001, 0.25);
    const cum = (w.mods['cb.cum'] || 0) + (pol.interestRate - before); w.mods['cb.cum'] = cum;
    if (Math.abs(cum) >= 0.0075) { emit(w, { cat: 'economy', type: 'rate', title: `Central bank ${cum > 0 ? 'raises' : 'cuts'} interest rate to ${pct(pol.interestRate, 2)}`, sev: 0.3, why: `inflation ${pct(infl)}, unemployment ${pct(u)} (policy rule target ${pct(target, 2)})` }); w.mods['cb.cum'] = 0; }
  }
  // ---- quarterly leadership decisions ---------------------------------------------
  if (w.tick % 90 === 0) {
    const left = g.parties[g.party].ideology < 0;
    const gdpM = Math.max(1, w.mods['flow.output'] || 1);
    const deficit = -g.balance / gdpM, u = w.metrics.unemployment ?? 0.06;
    if (deficit > 0.06) {
      if (left && !locked(w, 'incomeTax') && pol.incomeTax < 0.45) { pol.incomeTax += 0.01; act(w, `Income tax raised to ${pct(pol.incomeTax, 0)} to close the deficit`, `monthly deficit is ${pct(deficit)} of output`); }
      else if (!locked(w, 'spendAdmin') && pol.spendAdmin > 0.6) { pol.spendAdmin *= 0.95; if (!locked(w, 'spendInfrastructure')) pol.spendInfrastructure *= 0.95; act(w, 'Austerity: administration and infrastructure budgets cut 5%', `monthly deficit is ${pct(deficit)} of output`); }
    } else if (deficit < -0.04) {
      if (!left && !locked(w, 'incomeTax') && pol.incomeTax > 0.08) { pol.incomeTax -= 0.01; act(w, `Income tax cut to ${pct(pol.incomeTax, 0)}`, `budget surplus of ${pct(-deficit)} of output`); }
      else if (left && !locked(w, 'spendHealth')) { pol.spendHealth *= 1.03; if (!locked(w, 'spendEducation')) pol.spendEducation *= 1.03; act(w, 'Surplus invested: health and education budgets +3%', `budget surplus of ${pct(-deficit)} of output`); }
    }
    if (u > 0.11 && !locked(w, 'spendInfrastructure') && pol.spendInfrastructure < 2.2) { pol.spendInfrastructure *= 1.12; act(w, 'Public works programme: infrastructure spending +12%', `unemployment at ${pct(u)}`); }
    if (w.health.load > 1 && !locked(w, 'spendHealth') && pol.spendHealth < 2.5) { pol.spendHealth *= 1.12; act(w, 'Emergency health funding +12%', `hospitals at ${pct(w.health.load, 0)} of capacity`); }
    if (w.social.protestShare > 0.05) {
      if (left && !locked(w, 'minWage')) { pol.minWage *= 1.04; act(w, `Concession to protesters: minimum wage +4%`, `${pct(w.social.protestShare)} of adults are protesting`); }
      else if (!locked(w, 'salesTax') && pol.salesTax > 0.02) { pol.salesTax -= 0.01; act(w, `Concession to protesters: sales tax cut to ${pct(pol.salesTax, 0)}`, `${pct(w.social.protestShare)} of adults are protesting`); }
      else if (!locked(w, 'childBenefit')) { pol.childBenefit *= 1.15; act(w, 'Concession to protesters: family benefits +15%', `${pct(w.social.protestShare)} of adults are protesting`); }
    }
    if ((w.metrics.homelessRate || 0) > 0.012 && !locked(w, 'rentControl') && left && pol.rentControl < 0.5) { pol.rentControl = 0.5; act(w, 'Rent stabilisation introduced', `${pct(w.metrics.homelessRate, 1)} of households are homeless`); }
  }
  // ---- epidemic response ------------------------------------------------------------
  if (!locked(w, 'restrictions')) {
    const prev = w.metrics.infectedShare || 0;
    if (prev > 0.04 && pol.restrictions < 0.5) { pol.restrictions = 0.5; act(w, 'Public health restrictions imposed', `${pct(prev)} of the population is currently infected`, 0.5); }
    else if (prev < 0.004 && pol.restrictions > 0) { pol.restrictions = 0; act(w, 'Public health restrictions lifted', `infections fell to ${pct(prev, 2)}`); }
  }
  if (w.tick >= g.nextElection) election(w);
}

export function election(w: World) {
  const g = w.gov, votes = g.parties.map(() => 0);
  let n = 0;
  for (const c of w.citizens) {
    if (!isActive(c) || c.age < 18) continue;
    const approve = 0.55 * c.trustGov + 0.45 * c.happy;
    let best = 0, bu = -1e9;
    g.parties.forEach((p, i) => { const util = -Math.abs(c.ideology - p.ideology) + (i === g.party ? (approve - 0.5) * 2.4 : 0) + rand(w) * 0.35; if (util > bu) { bu = util; best = i; } });
    votes[best]++; n++;
  }
  let win = 0; votes.forEach((v, i) => { g.parties[i].support = v / Math.max(1, n); if (v > votes[win]) win = i; });
  const changed = win !== g.party, pol = w.policy, p = g.parties[win];
  g.party = win; g.nextElection = w.tick + 4 * DAYS_PER_YEAR;
  if (changed) {
    const set = (k: keyof Policy, fn: (v: number) => number) => { if (!locked(w, k)) (pol[k] as number) = fn(pol[k] as number); };
    if (p.ideology > 0) { set('corporateTax', (v) => Math.max(0.08, v - 0.03)); set('incomeTax', (v) => Math.max(0.08, v - 0.02)); set('spendAdmin', (v) => v * 0.95); }
    else if (p.ideology < -0.5) { set('spendResearch', (v) => v * 1.1); set('spendInfrastructure', (v) => v * 1.1); set('incomeTax', (v) => Math.min(0.45, v + 0.015)); }
    else { set('incomeTax', (v) => Math.min(0.45, v + 0.02)); set('spendEducation', (v) => v * 1.06); set('spendHealth', (v) => v * 1.06); set('minWage', (v) => v * 1.05); }
    const council = w.orgs.find((o) => o.name === 'City Council');
    if (council) { const cands = council.employees.map((id) => w.citizens[id]).filter(isActive).sort((a, b) => Math.abs(a.ideology - p.ideology) - Math.abs(b.ideology - p.ideology)); if (cands[0]) { const old = w.citizens[g.leader]; if (old && old.role === 'Mayor') old.role = 'Councillor'; cands[0].role = 'Mayor'; g.leader = cands[0].id; } }
    for (const c of w.citizens) if (isActive(c)) c.trustGov = clamp(c.trustGov + 0.05);
  }
  count(w, 'gov.elections');
  emit(w, { cat: 'politics', type: 'election', title: changed ? `Election: ${p.name} takes power` : `Election: ${p.name} re-elected`, detail: g.parties.map((x) => `${x.name} ${pct(x.support, 0)}`).join(' · '), sev: changed ? 0.7 : 0.4, why: `incumbent approval was ${pct(g.approval, 0)}`, district: w.districts.find((x) => x.kind === 'government')!.id });
}
