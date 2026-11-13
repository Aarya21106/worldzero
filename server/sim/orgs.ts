// Labour market matching and business formation.
import type { World, Citizen, Org, OrgType, Sector } from './types';
import { clamp } from './types';
import { rand, shuffle } from './rng';
import { isActive, hire, separate, offerWage, count, remember, emit, placeOrg, money, orgLog } from './world';
import { makeOrg } from './generate';

const REQ: Partial<Record<OrgType, number>> = { research_lab: 3, university: 3, hospital: 2, school: 2, bank: 2, investment_firm: 3, media: 2, gov_department: 2 };

/** Weekly matching: organisations with openings interview a sample of job seekers. */
export function labourMarket(w: World) {
  const seekers: Citizen[] = [];
  for (const c of w.citizens) if (isActive(c) && c.age >= 18 && c.age < 65 && (c.status === 'unemployed' || (c.seeking && c.status === 'employed'))) seekers.push(c);
  const orgs = shuffle(w, w.orgs.filter((o) => o.alive && o.openings > 0));
  let open = 0;
  for (const o of orgs) {
    const req = REQ[o.type] ?? (o.sector === 'tech' ? 2 : 0);
    let tries = 0;
    while (o.openings > 0 && seekers.length && tries++ < o.openings + 3) {
      let bi = -1, bs = -1e9;
      const k = Math.min(8, seekers.length);
      for (let j = 0; j < k; j++) {
        const i = Math.floor(rand(w) * seekers.length), c = seekers[i];
        if (c.employer === o.id) continue;
        if (req >= 2 && c.edu < req - 1) continue;
        const s = c.skill + (c.field === o.sector ? 0.15 : 0) - (c.edu < req ? 0.35 : 0) + c.edu * 0.05;
        if (s > bs) { bs = s; bi = i; }
      }
      if (bi < 0) continue;
      const c = seekers[bi];
      const offer = offerWage(w, o, c);
      const accept = c.status === 'employed' ? offer > c.wage * 1.08 : c.unempMonths >= 3 || offer >= c.wage * (0.88 - 0.03 * c.unempMonths) || c.wage === 0;
      if (!accept) continue;
      const was = c.status === 'employed';
      if (was) { const old = w.orgs[c.employer]; separate(w, old, c, 'resign'); count(w, 'decision.switch_job'); count(w, `decision.switch_job.t${c.tier}`); }
      hire(w, o, c, offer);
      remember(w, c, 'hired', `${was ? 'Moved to' : 'Hired by'} ${o.name} as ${c.role} at ${money(offer)}/month`, 0.6);
      c.happy = clamp(c.happy + 0.08); c.goal = 'build_career';
      o.openings--; count(w, 'org.hires'); count(w, `hired.t${c.tier}`);
      seekers[bi] = seekers[seekers.length - 1]; seekers.pop();
    }
    open += o.openings;
  }
  w.metrics.openings = open;
}

const SECTOR_MAP: Partial<Record<Sector, Sector>> = { government: 'services', research: 'tech', education: 'services' };

/** A citizen founds a business with their own savings (and possibly seed capital). */
export function foundBusiness(w: World, c: Citizen, opts: { type?: OrgType; sector?: Sector; name?: string; capital?: number; quiet?: boolean } = {}): Org | null {
  const sector = opts.sector || SECTOR_MAP[c.field] || c.field;
  const type: OrgType = opts.type || (c.edu >= 3 && ['tech', 'healthcare', 'energy', 'finance', 'media'].includes(sector) ? 'startup' : 'small_business');
  const o = makeOrg(w, type, sector, { owner: c, name: opts.name });
  if (!placeOrg(w, o, { nameHint: sector === 'tech' ? 'Tech' : undefined, construction: false })) { o.alive = false; o.closed = w.tick; o.closeReason = 'no premises available'; return null; }
  const capital = opts.capital ?? c.savings * 0.5;
  if (opts.capital === undefined) c.savings -= capital;
  if (c.employer >= 0) separate(w, w.orgs[c.employer], c, 'resign');
  c.employer = o.id; c.status = 'owner'; c.role = type === 'startup' ? 'Founder' : 'Business owner'; c.stakeOrg = o.id; c.goal = 'grow_business'; c.seeking = false; c.unempMonths = 0;
  c.wage = Math.round(offerWage(w, o, c) * 0.9); c.refRealWage = c.wage / w.cpi;
  o.employees.push(c.id);
  o.cash = capital; o.openings = type === 'startup' ? 3 : 2; o.util = 1.05; o.stage = type === 'startup' ? 'Seed' : '';
  o.revAvg = c.wage * 3; o.expenses = c.wage * 1.5;
  if (type === 'startup') {
    const appetite = clamp(w.market.confidence, 0.1, 1.4) * w.market.vc * (1 + w.policy.startupSubsidy);
    if (rand(w) < 0.55 * appetite) { const inv = w.orgs.filter((x) => x.alive && x.type === 'investment_firm' && x.funding > 3e5); if (inv.length) { const i = inv[Math.floor(rand(w) * inv.length)]; const amt = Math.min(i.funding * 0.15, 1.5e5 + rand(w) * 3e5); i.funding -= amt; o.funding += amt; o.partners.push(i.id); orgLog(w, o, `Seed funding ${money(amt)} from ${i.name}`); } }
    o.funding += capital * 0.5 + w.policy.startupSubsidy * 1e5;
  }
  const b = w.buildings[o.building]; if (b.status === 'vacant') b.status = 'active';
  count(w, 'org.founded'); count(w, `org.founded.${type}`);
  remember(w, c, 'founded', `Founded ${o.name}`, 0.8);
  if (!opts.quiet) emit(w, { cat: 'business', type: 'founded', title: `${c.name} founds ${o.name}`, detail: `New ${type === 'startup' ? 'startup' : 'small business'} in ${sector}, ${w.districts[o.district].name}.`, sev: 0.12, district: o.district, entity: `org:${o.id}`, why: `founder ambition ${c.traits.ambition.toFixed(2)}, risk appetite ${c.traits.risk.toFixed(2)}, market confidence ${w.market.confidence.toFixed(2)}` });
  return o;
}
