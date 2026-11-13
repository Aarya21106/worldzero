// Social stability, opinion dynamics, relationships, demography, migration and external shocks.
import type { World, Citizen, Household, Shock, Good } from './types';
import { clamp, DAYS_PER_MONTH } from './types';
import { rand, randInt, weighted, pick } from './rng';
import { isActive, emit, count, remember, closeOrg, separate, pct } from './world';
import { newCitizen, newHousehold, houseHousehold } from './generate';
import { randomSurname } from './names';

function leaveOrg(w: World, c: Citizen, reason: string) {
  if (c.employer >= 0) {
    const o = w.orgs[c.employer];
    if (o.owner === c.id && o.alive) {
      const heir = o.employees.map((id) => w.citizens[id]).filter((x) => x.id !== c.id && isActive(x)).sort((a, b) => b.skill - a.skill)[0];
      if (heir && o.employees.length > 2) { o.owner = heir.id; heir.status = 'owner'; heir.role = o.type === 'startup' ? 'Founder' : 'Business owner'; heir.stakeOrg = o.id; const i = o.employees.indexOf(c.id); if (i >= 0) o.employees.splice(i, 1); }
      else closeOrg(w, o, `owner ${reason}`);
    } else separate(w, o, c, 'resign');
  }
  c.employer = -1; c.school = -1;
}

export function killCitizen(w: World, c: Citizen, cause: string) {
  if (!c.alive) return;
  leaveOrg(w, c, 'died');
  c.alive = false; c.status = 'inactive'; c.role = `Deceased (${cause})`; c.inf = 0; c.protest = false;
  const h = w.households[c.hh];
  const heirs = h.members.map((id) => w.citizens[id]).filter((x) => isActive(x));
  const adults = heirs.filter((x) => x.age >= 18);
  if (adults.length) { for (const a of adults) { a.savings += c.savings / adults.length; a.equity += c.equity / adults.length; a.happy = clamp(a.happy - 0.2); remember(w, a, 'bereavement', `${c.name} died (${cause})`, -0.95); } }
  c.savings = 0; c.equity = 0;
  if (c.partner >= 0) w.citizens[c.partner].partner = -1;
  if (!heirs.length) dissolve(w, h);
  w.social.deaths++; count(w, 'pop.deaths');
}

function dissolve(w: World, h: Household) {
  h.alive = false;
  if (h.building >= 0) { const b = w.buildings[h.building]; b.occupied = Math.max(0, b.occupied - 1); }
  h.building = -1;
}

export function emigrateHousehold(w: World, h: Household, why: string) {
  if (!h.alive) return;
  let n = 0;
  for (const id of h.members) { const c = w.citizens[id]; if (!isActive(c)) continue; leaveOrg(w, c, 'emigrated'); c.left = true; c.status = 'inactive'; c.role = `Emigrated (${why})`; c.protest = false; n++; }
  dissolve(w, h);
  w.social.migOut += n; count(w, 'pop.emigrated', n); count(w, 'pop.emigrated_households');
}

export function immigrate(w: World, households: number, opts: { skilled?: boolean; wclass?: number; reason?: string } = {}): number {
  let people = 0;
  for (let i = 0; i < households; i++) {
    const wclass = opts.wclass ?? (opts.skilled ? weighted(w, [1, 2], [0.6, 0.4]) : weighted(w, [0, 1, 2], [0.5, 0.4, 0.1]));
    const sn = randomSurname(w), mem: Citizen[] = [];
    const a = newCitizen(w, randInt(w, 22, 45), rand(w) < 0.5 ? 'F' : 'M', wclass, sn);
    if (opts.skilled) { a.edu = Math.max(a.edu, 3); a.skill = clamp(a.skill + 0.2, 0, 1); a.field = pick(w, ['tech', 'tech', 'research', 'finance', 'healthcare'] as const); }
    mem.push(a);
    if (rand(w) < 0.5) { const b = newCitizen(w, clamp(a.age + randInt(w, -4, 5), 20, 60), a.sex === 'F' ? 'M' : 'F', wclass, sn); a.partner = b.id; b.partner = a.id; mem.push(b); if (rand(w) < 0.5) mem.push(newCitizen(w, randInt(w, 0, 14), rand(w) < 0.5 ? 'F' : 'M', wclass, sn)); }
    const h = newHousehold(w, mem, wclass);
    if (!houseHousehold(w, h)) { for (const m of mem) { m.left = true; m.status = 'inactive'; m.role = 'Did not settle (no housing)'; } h.alive = false; count(w, 'pop.turned_away', mem.length); continue; }
    for (const m of mem) {
      if (m.age >= 18) { m.status = 'unemployed'; m.role = 'Newcomer seeking work'; m.seeking = true; m.goal = 'find_job'; m.savings = Math.round((2000 + rand(w) * 9000) * (1 + wclass * 2) * w.cpi); remember(w, m, 'arrived', `Moved to ${w.name}${opts.reason ? ` (${opts.reason})` : ''}`, 0.6); }
      else if (m.age >= 6) { const sc = w.orgs.find((o) => o.alive && o.type === 'school' && o.district === h.district) || w.orgs.find((o) => o.alive && o.type === 'school'); m.school = sc ? sc.id : -1; m.role = 'School pupil'; }
    }
    people += mem.length;
  }
  w.social.migIn += people; count(w, 'pop.immigrated', people);
  return people;
}

export function startShock(w: World, s: Partial<Shock> & { name: string; kind: string; days: number }): Shock {
  const sh: Shock = { id: w.nextIds.shock++, name: s.name, kind: s.kind, start: w.tick, until: w.tick + s.days, severity: s.severity ?? 0.5, exportMult: s.exportMult ?? 1, importPrice: s.importPrice || {}, confidence: s.confidence ?? 0, migrants: s.migrants ?? 0, note: s.note || '' };
  w.ext.shocks.push(sh);
  for (const g of Object.keys(sh.importPrice) as Good[]) { const m = sh.importPrice[g]!; w.prices[g] *= m; if ((w.sectors as any)[g]) (w.sectors as any)[g].price *= m; }
  return sh;
}

export function dailyShocks(w: World) {
  for (const s of w.ext.shocks) {
    if (s.until > 0 && w.tick === s.until) {
      for (const g of Object.keys(s.importPrice) as Good[]) { const m = 1 + (s.importPrice[g]! - 1) * 0.7; w.prices[g] /= m; if ((w.sectors as any)[g]) (w.sectors as any)[g].price /= m; }
      emit(w, { cat: 'external', type: 'shock_end', title: `${s.name} ends`, detail: 'Trade routes and import prices begin to normalise.', sev: 0.4 });
    }
    if (s.migrants > 0 && w.tick < s.until && (w.tick - s.start) % 30 === 15) { const n = immigrate(w, Math.round(s.migrants / Math.max(1, (s.until - s.start) / 30)), { reason: `fleeing the ${s.name}` }); if (n) emit(w, { cat: 'population', type: 'refugees', title: `${n} refugees arrive`, detail: `Displaced by the ${s.name}.`, sev: 0.35 }); }
  }
}

export function monthlySocial(w: World) {
  const S = w.social, pol = w.policy;
  const month = Math.floor(w.tick / DAYS_PER_MONTH) % 12;
  const fear = w.mods.fear || 0, corruption = w.mods.corruption || 0;
  const rulingIdeo = w.gov.parties[w.gov.party].ideology;
  const services = clamp(0.4 * w.infra.quality + 0.3 * w.edu.schoolQuality + 0.3 * w.health.careQuality, 0.2, 1.3);
  const nd = w.districts.length;
  const dPop = new Array(nd).fill(0), dLf = new Array(nd).fill(0), dU = new Array(nd).fill(0), dInc = new Array(nd).fill(0), dHappy = new Array(nd).fill(0), dProt = new Array(nd).fill(0), dAd = new Array(nd).fill(0);
  let adults = 0, protesters = 0, trustSum = 0, happySum = 0, approve = 0;
  // ---- per-citizen wellbeing, opinions, ageing --------------------------------------------
  for (const c of w.citizens) {
    if (!isActive(c)) continue;
    const h = w.households[c.hh];
    if (Math.floor(c.bday / DAYS_PER_MONTH) === month) birthday(w, c, h);
    if (c.status === 'unemployed') c.unempMonths++;
    if (c.status === 'employed' || c.status === 'owner') c.tenure++;
    const d = h.district >= 0 ? h.district : 0;
    dPop[d]++;
    const crime = w.districts[d].crime;
    const happyT = clamp(0.22 + 0.3 * clamp(h.pp / 2, 0, 1) + 0.15 * c.health + (c.status === 'unemployed' ? -0.1 : c.status === 'employed' || c.status === 'owner' ? 0.08 : 0.04) + 0.1 * Math.min(c.friends.length, 5) / 5 + 0.1 * services - crime * 0.12 - (h.homeless ? 0.25 : 0) - fear * 0.1 - S.unrest * 0.06 - c.traits.neuro * 0.06 + 0.03);
    c.happy += (happyT - c.happy) * 0.25;
    if (c.age < 18) continue;
    adults++; dAd[d]++;
    const align = 1 - Math.abs(c.ideology - rulingIdeo) / 2;
    const trustT = clamp(0.1 + 0.3 * c.happy + 0.22 * clamp(h.pp / 1.3, 0, 1) + 0.16 * services + 0.14 * align - 0.3 * corruption - 0.12 * S.unrest - (c.status === 'unemployed' ? 0.06 : 0) + 0.06 * (c.trustMedia - 0.5));
    c.trustGov += (trustT - c.trustGov) * 0.07;
    c.trustMedia = clamp(c.trustMedia + (0.5 - c.trustMedia) * 0.02 - corruption * 0.005);
    c.trustBiz += (clamp(0.3 + 0.25 * w.market.confidence + (c.status === 'employed' ? 0.1 : -0.05)) - c.trustBiz) * 0.05;
    trustSum += c.trustGov; happySum += c.happy; approve += 0.55 * c.trustGov + 0.45 * c.happy;
    if (c.protest) { protesters++; dProt[d]++; }
    if (c.age < 65 && c.status !== 'student' && c.status !== 'inactive') { dLf[d]++; if (c.status === 'unemployed') dU[d]++; }
    dInc[d] += c.income; dHappy[d] += c.happy;
    // relationships evolve
    if (c.friends.length < 8 && rand(w) < 0.03) { let cand = -1; if (c.employer >= 0 && rand(w) < 0.7) cand = pick(w, w.orgs[c.employer].employees); else if (c.friends.length) { const f = w.citizens[pick(w, c.friends)]; if (f.friends.length) cand = pick(w, f.friends); } if (cand >= 0 && cand !== c.id) { const o = w.citizens[cand]; if (isActive(o) && o.friends.length < 8 && !c.friends.includes(cand) && o.hh !== c.hh) { c.friends.push(cand); o.friends.push(c.id); count(w, 'social.friendships'); } } }
    if (c.friends.length && rand(w) < 0.02) { const i = Math.floor(rand(w) * c.friends.length); const f = w.citizens[c.friends[i]]; if (!isActive(f) || rand(w) < 0.3) { c.friends.splice(i, 1); const j = f.friends.indexOf(c.id); if (j >= 0) f.friends.splice(j, 1); } }
    // couples
    if (c.partner < 0 && c.age >= 22 && c.age <= 48 && c.friends.length && rand(w) < 0.006) { const f = w.citizens[pick(w, c.friends)]; if (isActive(f) && f.partner < 0 && f.age >= 22 && Math.abs(f.age - c.age) < 12 && f.hh !== c.hh) marry(w, c, f); }
    // births
    if (c.sex === 'F' && c.partner >= 0 && c.age >= 21 && c.age <= 42 && h.members.length < 6 && rand(w) < 0.0075 * (w.mods.birthRate ?? 1) * (h.pp > 1.1 ? 1 : 0.45) * (0.6 + c.happy * 0.7)) {
      const baby = newCitizen(w, 0, rand(w) < 0.5 ? 'F' : 'M', h.wclass, c.name.split(' ').slice(1).join(' '));
      baby.hh = h.id; h.members.push(baby.id); baby.bday = w.tick % 360; S.births++; count(w, 'pop.births');
      remember(w, c, 'birth', `Our child ${baby.name.split(' ')[0]} was born`, 0.9); c.happy = clamp(c.happy + 0.1);
    }
    // adult children move out
    if (c.age >= 23 && c.age < 35 && c.partner < 0 && h.members.length > 2 && (c.status === 'employed' || c.status === 'owner') && c.income > 1900 * w.cpi && rand(w) < 0.03) {
      const parents = h.members.some((id) => w.citizens[id].age > c.age + 15);
      if (parents) { const nh = newHousehold(w, [c], Math.min(2, c.tier)); h.members.splice(h.members.indexOf(c.id), 1); if (!houseHousehold(w, nh)) { nh.alive = false; c.hh = h.id; h.members.push(c.id); } else { count(w, 'social.new_households'); remember(w, c, 'moved_out', `Moved into my own place in ${w.districts[nh.district].name}`, 0.6); } }
    }
  }
  // ---- aggregates ---------------------------------------------------------------------------
  const gini = w.metrics.gini ?? 0.4;
  let crimeSum = 0, cn = 0;
  for (const d of w.districts) {
    const i = d.id;
    d.pop = dPop[i]; d.unemp = dLf[i] ? dU[i] / dLf[i] : 0; d.avgIncome = dAd[i] ? dInc[i] / dAd[i] : 0; d.happy = dAd[i] ? dHappy[i] / dAd[i] : d.happy; d.protest = dProt[i];
    if (d.kind === 'residential') { const target = clamp(0.1 + 0.9 * d.unemp + 0.3 * (gini - 0.35) + 0.25 * S.unrest - 0.14 * (pol.spendPolice - 1) + (w.metrics.homelessRate || 0) * 2 + (2 - d.wealth) * 0.04, 0.02, 1); d.crime += (target - d.crime) * 0.2; crimeSum += d.crime; cn++; }
  }
  for (const d of w.districts) if (d.kind !== 'residential') d.crime = (cn ? crimeSum / cn : 0.2) * (d.kind === 'commercial' ? 1.1 : 0.8);
  S.crime = cn ? crimeSum / cn : 0.2;
  S.protestShare = adults ? protesters / adults : 0;
  S.unrest += (clamp(S.protestShare * 7, 0, 1) - S.unrest) * 0.4;
  const trust = adults ? trustSum / adults : 0.5, happy = adults ? happySum / adults : 0.5;
  w.gov.approval = adults ? approve / adults : 0.5;
  S.stability = clamp(0.36 + 0.42 * trust + 0.3 * happy - 0.3 * S.crime - 0.55 * S.unrest - fear * 0.08);
  S.cohesion = clamp(0.3 + 0.5 * happy + 0.2 * trust - 0.3 * S.unrest);
  const civic = w.districts.find((d) => d.kind === 'government')!;
  if (S.protestShare > 0.012) {
    const lvl = S.protestShare > 0.06 ? 2 : 1, key = 'social.protestLevel';
    if ((w.mods[key] || 0) < lvl || w.tick - (w.mods['social.protestT'] || -999) >= 90) {
      w.mods[key] = lvl; w.mods['social.protestT'] = w.tick; count(w, 'social.protest_events');
      const poor = w.metrics.povertyRate || 0;
      emit(w, { cat: 'social', type: lvl === 2 ? 'unrest' : 'protest', title: lvl === 2 ? `Mass unrest: ${protesters.toLocaleString('en-US')} people in the streets` : `Protest at the Civic Center: ${protesters.toLocaleString('en-US')} participants`, detail: `${pct(S.protestShare)} of adults are protesting. Public trust ${pct(trust, 0)}, poverty ${pct(poor, 0)}.`, sev: lvl === 2 ? 0.85 : 0.5, district: civic.id, why: `grievances: trust in government ${pct(trust, 0)}, ${pct(poor, 0)} of households cannot cover essentials, happiness ${pct(happy, 0)}` });
    }
  } else w.mods['social.protestLevel'] = 0;
  // ---- migration ---------------------------------------------------------------------------
  const u = w.metrics.unemployment ?? 0.06;
  const attract = clamp(1 + (0.07 - u) * 8 + ((w.metrics.openings || 0) / Math.max(1, w.metrics.labourForce || 2500)) * 12 + (happy - 0.6) * 2 - (w.housing.avgRent - 1) * 0.8 - S.unrest * 2 - fear, 0, 4);
  const arrivals = Math.round(1.6 * pol.immigration * attract * (0.6 + rand(w) * 0.8) + (w.mods.immigrationPush || 0));
  if (arrivals > 0 && w.housing.vacancy > 0.01) immigrate(w, arrivals, { skilled: (w.mods.techBoom || 0) > 0.3 && rand(w) < 0.6 });
}

function birthday(w: World, c: Citizen, h: Household) {
  c.age++;
  if (c.age === 6) { const sc = w.orgs.find((o) => o.alive && o.type === 'school' && o.district === h.district) || w.orgs.find((o) => o.alive && o.type === 'school'); c.school = sc ? sc.id : -1; c.edu = 1; c.role = 'School pupil'; }
  else if (c.age === 18) {
    c.edu = Math.max(c.edu, 2); c.school = -1; c.status = 'unemployed'; c.role = 'School leaver'; c.seeking = true; c.goal = 'find_job'; c.skill = clamp(c.skill + 0.12, 0, 1);
    const burden = (w.tuition * w.prices.education * (1 - w.policy.tuitionSubsidy)) / Math.max(500, h.income);
    if (rand(w) < clamp(0.2 + c.traits.ambition * 0.5 + h.wclass * 0.15 - burden * 1.5 + c.skill * 0.3, 0.02, 0.97)) { c.wantsUni = true; c.goal = 'get_degree'; count(w, 'decision.apply_university'); count(w, `decision.apply_university.t${c.tier}`); }
  } else if (c.age === 65 && (c.status === 'employed' || c.status === 'unemployed' || c.status === 'inactive')) {
    if (c.employer >= 0) separate(w, w.orgs[c.employer], c, 'resign');
    c.status = 'retired'; c.role = 'Retired'; c.goal = 'enjoy_retirement'; c.seeking = false; c.wage = Math.round((c.wage * 0.3) / w.cpi); remember(w, c, 'retired', 'Retired from working life', 0.5); count(w, 'pop.retired');
  }
}

function marry(w: World, a: Citizen, b: Citizen) {
  const ha = w.households[a.hh], hb = w.households[b.hh];
  a.partner = b.id; b.partner = a.id;
  // the smaller household moves in with the other
  const [mover, from, to] = ha.members.length <= hb.members.length ? [a, ha, hb] : [b, hb, ha];
  if (to.members.length >= 6) return;
  from.members.splice(from.members.indexOf(mover.id), 1); to.members.push(mover.id); mover.hh = to.id;
  if (!from.members.some((id) => isActive(w.citizens[id]))) dissolve(w, from);
  remember(w, a, 'partner', `Moved in with ${b.name}`, 0.8); remember(w, b, 'partner', `Moved in with ${a.name}`, 0.8);
  a.happy = clamp(a.happy + 0.1); b.happy = clamp(b.happy + 0.1); count(w, 'social.couples');
}
