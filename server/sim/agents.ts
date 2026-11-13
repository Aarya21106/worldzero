// Individual Agent Engine. Each adult runs a decision cycle once a month (staggered by id):
// Observe -> Evaluate needs -> Evaluate opportunities -> Decide (utility + noise) -> Act -> Remember -> Influence.
// No LLM calls here: behaviour is utility-based and differs by finances, traits, relationships and circumstances.
import type { World, Citizen } from './types';
import { clamp, DAYS_PER_MONTH } from './types';
import { rand } from './rng';
import { isActive, count, remember, eduMult, pct, money, separate } from './world';
import { foundBusiness } from './orgs';
import { spendTarget } from './economy';
import { emigrateHousehold } from './social';

export function dailyAgents(w: World) {
  const day = w.tick % DAYS_PER_MONTH;
  const cs = w.citizens;
  for (let i = day; i < cs.length; i += DAYS_PER_MONTH) { const c = cs[i]; if (c.alive && !c.left && c.age >= 18) decide(w, c); }
}

export function decide(w: World, c: Citizen) {
  const h = w.households[c.hh];
  const pol = w.policy, conf = w.market.confidence, idx = w.market.index / w.market.indexBase;
  // ---- observe ---------------------------------------------------------------
  const pp = h.pp;
  let nAdults = 0; for (const id of h.members) { const m = w.citizens[id]; if (isActive(m) && m.age >= 18) nAdults++; }
  const savingsMonths = c.savings / Math.max(1, h.essential / Math.max(1, nAdults));
  let fTrust = 0, fProtest = 0, nf = 0;
  for (const id of c.friends) { const f = w.citizens[id]; if (!isActive(f)) continue; nf++; fTrust += f.trustGov; if (f.protest) fProtest++; }
  const friendsProtest = nf ? fProtest / nf : 0;
  const u = w.metrics.unemployment ?? 0.06;
  // ---- needs -----------------------------------------------------------------
  const subsistence = clamp(1.25 - pp, 0, 1);
  const security = clamp((c.status === 'unemployed' ? 0.6 : 0) + (3 - Math.min(3, savingsMonths)) * 0.13);
  // ---- continuous adjustment: spending mode ----------------------------------
  const target = spendTarget(c, pp, savingsMonths);
  const prev = c.spendMode;
  c.spendMode = prev + (target - prev) * 0.5;
  if (c.spendMode < prev - 0.07) {
    count(w, `decision.cutback.t${c.tier}`); count(w, 'decision.cutback');
    if (!c.mem.some((m) => m.k === 'cutback' && w.tick - m.t < 90)) remember(w, c, 'cutback', `Cut back on non-essentials — essentials now take ${pct(clamp(1 / Math.max(0.2, pp), 0, 3), 0)} of household income`, -0.4);
  } else if (c.spendMode > prev + 0.07) count(w, `decision.spend_more.t${c.tier}`);
  // ---- opportunities -> utilities ----------------------------------------------
  const opts: [string, number][] = [['none', 0.22]];
  const employer = c.employer >= 0 ? w.orgs[c.employer] : null;
  let erosion = 0;
  if (c.status === 'unemployed') { c.seeking = true; c.goal = 'find_job'; }
  if (c.status === 'employed' && employer) {
    const real = c.wage / w.cpi;
    erosion = c.refRealWage > 0 ? 1 - real / c.refRealWage : 0;
    if (erosion > 0.03) opts.push(['ask_raise', erosion * 5 * (0.4 + c.traits.ambition) + (pp < 1.1 ? 0.2 : 0)]);
    const S = w.sectors[employer.sector];
    const marketWage = S.baseWage * S.wageIdx * eduMult(c.edu) * (0.75 + 0.5 * c.skill);
    const gap = marketWage / Math.max(1, c.wage) - 1;
    if (gap > 0.12 && (w.metrics.openings || 0) > 0) opts.push(['switch_job', gap * 2 * (0.3 + c.traits.ambition)]);
  }
  if (c.age < 40 && c.edu === 2 && !c.wantsUni && (c.status === 'unemployed' || c.status === 'employed')) {
    const burden = (w.tuition * w.prices.education * (1 - pol.tuitionSubsidy)) / Math.max(500, h.income);
    opts.push(['enroll', 0.22 + c.traits.ambition * 0.45 + (c.status === 'unemployed' ? 0.22 : -0.2) - burden * 1.6 - (c.age - 18) * 0.012]);
  }
  if ((c.status === 'employed' || c.status === 'unemployed') && c.age >= 24 && c.age <= 58 && c.savings > 15000 * w.cpi * (1 - pol.startupSubsidy * 0.6)) {
    const boom = c.edu >= 3 ? 1 + (w.mods.techBoom || 0) * 0.25 : 1;
    const crowd = Math.max(0, (w.metrics.businesses || 0) / Math.max(1, w.metrics.population || 1) / (w.mods['base.bizDensity'] || 0.06) - 1);
    opts.push(['start_business', c.traits.ambition * c.traits.risk * 1.3 * clamp(conf, 0.3, 1.4) * (w.mods.startupFormation ?? 1) * boom * clamp(w.market.credit + 0.3, 0.4, 1.3) - 0.62 - crowd * 0.6 + (c.status === 'unemployed' ? 0.1 : 0)]);
  }
  if (c.savings > Math.max(c.income, 1500) * 8 && c.traits.risk > 0.45 && conf > 0.9) opts.push(['invest', 0.26 + c.traits.risk * 0.2]);
  if (c.equity * idx > 1000 && conf < 0.72) opts.push(['panic_sell', (0.86 - conf) * (1.2 - c.traits.risk) * 1.6]);
  const grievance = (1 - c.happy) * 0.6 + (1 - c.trustGov) * 0.5 + clamp(1.1 - pp, 0, 1) * 0.5;
  const uProtest = grievance + 0.5 * friendsProtest + w.social.unrest * 0.2 - 0.86 - c.traits.agree * 0.15 + c.traits.open * 0.05;
  opts.push(['protest', uProtest]);
  opts.push(['emigrate', (c.unempMonths > 5 ? 0.3 + Math.min(0.3, c.unempMonths * 0.012) : 0) + (h.members.length === 1 && c.age < 35 ? 0.06 : 0) + (1 - c.happy) * 0.35 + clamp(1 - pp, 0, 1) * 0.3 + (h.homeless ? 0.3 : 0) + (1 - w.social.stability) * 0.2 - 0.78 - (h.members.length > 2 ? 0.1 : 0) - (h.owns ? 0.15 : 0) - c.age / 200]);
  // ---- decide ----------------------------------------------------------------------
  let best = 'none', bu = -1e9;
  for (const [k, v] of opts) { const s = v + rand(w) * 0.1; if (s > bu) { bu = s; best = k; } }
  if (best !== 'protest' && c.protest && uProtest < -0.08) c.protest = false;
  // ---- act + remember + influence -----------------------------------------------------
  const tag = (k: string) => { count(w, `decision.${k}`); count(w, `decision.${k}.t${c.tier}`); c.lastDecision = k; };
  switch (best) {
    case 'ask_raise': {
      const o = employer!;
      const p = clamp(0.25 + (o.profit > 0 ? 0.3 : -0.12) + (0.07 - u) * 3 + (o.unfilled > 0 ? 0.2 : 0), 0.03, 0.9);
      tag('ask_raise');
      if (rand(w) < p) { const old = c.wage; c.wage = Math.round(c.wage * (1 + erosion * 0.8)); c.refRealWage = c.wage / w.cpi; tag('raise_won'); remember(w, c, 'raise', `Negotiated a raise at ${o.name}: ${money(old)} → ${money(c.wage)} after prices outran my pay`, 0.5); c.happy = clamp(c.happy + 0.04); }
      else { c.refRealWage = (c.refRealWage + c.wage / w.cpi) / 2; c.happy = clamp(c.happy - 0.05); c.trustBiz = clamp(c.trustBiz - 0.05); c.seeking = c.traits.ambition > 0.5; tag('raise_denied'); remember(w, c, 'raise_denied', `${o.name} refused a raise while my real pay fell ${pct(erosion, 0)}`, -0.5); }
      break;
    }
    case 'switch_job': c.seeking = true; c.goal = 'better_job'; tag('job_search'); break;
    case 'enroll': c.wantsUni = true; c.goal = 'get_degree'; tag('apply_university'); remember(w, c, 'apply_uni', pol.tuitionSubsidy >= 0.95 ? 'Applied to university — tuition is free' : 'Applied to university to improve my prospects', 0.3); break;
    case 'start_business': { const o = foundBusiness(w, c); if (o) { tag('start_business'); } break; }
    case 'invest': { const amt = c.savings * 0.15; c.savings -= amt; c.equity += amt / idx; w.market.flow += (amt / Math.max(1, w.metrics.totalEquity || 1e9)) * 0.5; tag('invest'); break; }
    case 'panic_sell': { const units = c.equity * 0.6; const val = units * idx; c.equity -= units; c.savings += val; w.market.flow -= (val / Math.max(1, w.metrics.totalEquity || 1e9)) * 0.5; tag('panic_sell'); remember(w, c, 'panic_sell', `Sold ${money(val)} of investments as markets lost confidence`, -0.5); break; }
    case 'protest': if (!c.protest) { c.protest = true; tag('protest'); remember(w, c, 'protest', pp < 1.05 ? 'Joined a protest — we can no longer afford the basics' : c.trustGov < 0.3 ? 'Joined a protest — I no longer trust the government' : 'Joined a street protest', -0.3); } break;
    case 'emigrate': { tag('emigrate'); emigrateHousehold(w, h, c.unempMonths > 5 ? 'long-term unemployment' : pp < 1 ? 'cost of living' : 'unhappiness with life in the city'); break; }
    default: c.lastDecision = c.spendMode < prev - 0.07 ? 'cutback' : 'none';
  }
  // resign to study handled at intake; mild peer influence on outlook
  if (nf) c.trustGov = clamp(c.trustGov + (fTrust / nf - c.trustGov) * 0.04);
  if (c.status === 'employed' && employer && c.traits.ambition > 0.85 && c.happy < 0.3 && rand(w) < 0.05) { separate(w, employer, c, 'resign'); c.seeking = true; count(w, 'decision.resign'); remember(w, c, 'resign', `Resigned from ${employer.name}`, -0.2); }
}
