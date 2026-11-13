// Healthcare Simulation Engine: hospital capacity, baseline health and an abstract
// agent-level S-E-I-R epidemic spreading through households, workplaces, schools and districts.
// All diseases are fictional and exist only inside the simulation.
import type { World, Disease, Citizen } from './types';
import { clamp } from './types';
import { rand, pick } from './rng';
import { isActive, emit, count, remember, pct } from './world';
import { DISEASE_NAMES } from './names';
import { killCitizen } from './social';

export function startDisease(w: World, o: { name?: string; contagion?: number; severity?: number; mortality?: number; seeds?: number } = {}): Disease {
  const sev = clamp(o.severity ?? 0.5, 0.02, 1);
  const d: Disease = { id: w.nextIds.disease++, name: o.name || pick(w, DISEASE_NAMES.filter((n) => !w.health.diseases.some((x) => x.name === n)).concat(DISEASE_NAMES).slice(0, 6)), beta: clamp(o.contagion ?? 0.5, 0.05, 1) * 0.4, incubation: 3, duration: 9, severity: 0.03 + sev * 0.22, mortality: o.mortality ?? 0.01 + sev * 0.09, started: w.tick, active: true, totalInfected: 0, deaths: 0, peak: 0 };
  w.health.diseases.push(d);
  const pool = w.citizens.filter((c) => isActive(c) && c.inf === 0);
  const seeds = Math.min(pool.length, o.seeds ?? Math.round(12 * (w.mods.scale ?? 1)));
  for (let i = 0; i < seeds; i++) { const c = pool[Math.floor(rand(w) * pool.length)]; if (c.inf === 0) { c.inf = 2; c.infDays = 0; d.totalInfected++; } }
  return d;
}

export function dailyHealth(w: World) {
  const d = w.health.diseases.find((x) => x.active);
  if (!d) { if ((w.mods.fear || 0) > 0) w.mods.fear = Math.max(0, w.mods.fear - 0.01); return; }
  const cs = w.citizens, nH = w.households.length, nO = w.orgs.length, nD = w.districts.length;
  const hhInf = new Uint16Array(nH), orgInf = new Uint16Array(nO), orgN = new Uint16Array(nO), dInf = new Uint32Array(nD), dN = new Uint32Array(nD);
  let infectious = 0, pop = 0, hosp = 0;
  for (const c of cs) {
    if (!c.alive || c.left) continue;
    pop++;
    const dist = w.households[c.hh].district;
    dN[dist]++;
    const place = c.employer >= 0 ? c.employer : c.school;
    if (place >= 0) orgN[place]++;
    if (c.inf === 2 || c.inf === 3) { hhInf[c.hh]++; if (c.inf === 2) { infectious++; dInf[dist]++; if (place >= 0 && c.infDays < 3) orgInf[place]++; } else hosp++; }
  }
  const prev = infectious / Math.max(1, pop);
  const cm = clamp(1 - 0.6 * w.policy.restrictions - 0.3 * (w.mods.fear || 0), 0.15, 1);
  const beds = Math.max(1, w.health.beds), overload = hosp > beds * 0.6;
  let newInf = 0, deaths = 0, exposed = 0;
  for (const c of cs) {
    if (!c.alive || c.left) continue;
    if (c.inf === 0) {
      const dist = w.households[c.hh].district, place = c.employer >= 0 ? c.employer : c.school;
      const lam = hhInf[c.hh] * 0.25 + (place >= 0 && orgN[place] ? (orgInf[place] / orgN[place]) * 0.9 * cm : 0) + (dInf[dist] / Math.max(1, dN[dist])) * 0.5 * cm + prev * 0.15 * cm;
      if (lam > 0 && rand(w) < 1 - Math.exp(-d.beta * 2.5 * lam)) { c.inf = 1; c.infDays = 0; newInf++; d.totalInfected++; }
    } else if (c.inf === 1) { exposed++; if (++c.infDays >= d.incubation) { c.inf = 2; c.infDays = 0; } }
    else if (c.inf === 2 || c.inf === 3) {
      c.infDays++;
      const ageF = c.age > 70 ? 3.5 : c.age > 55 ? 1.8 : c.age < 18 ? 0.25 : 1;
      if (c.inf === 2 && c.infDays === 3 && rand(w) < d.severity * ageF * (1.4 - c.health * 0.5)) { c.inf = 3; hosp++; c.health = clamp(c.health - 0.15); remember(w, c, 'illness', `Hospitalised with ${d.name}`, -0.8); }
      if (c.infDays >= d.duration) {
        if (c.inf === 3 && rand(w) < d.mortality * 1.5 * ageF * (overload ? 2.2 : 1) / Math.max(0.6, w.health.careQuality)) { deaths++; d.deaths++; killCitizen(w, c, d.name); continue; }
        c.inf = 4; c.infDays = 0; c.health = clamp(c.health - 0.03);
      }
    }
  }
  w.health.occupied = hosp + Math.round(w.metrics.chronicBeds || 0); w.health.load = w.health.occupied / beds;
  w.districts.forEach((x, i) => { x.infected = dInf[i]; });
  w.metrics.infected = infectious + hosp; w.metrics.infectedShare = (infectious + hosp) / Math.max(1, pop); w.metrics.hospitalLoad = w.health.load;
  count(w, 'health.infections', newInf); count(w, 'health.epidemic_deaths', deaths);
  const fearT = clamp(prev * 7 + (overload ? 0.25 : 0) + d.deaths / Math.max(1, pop) * 30, 0, 1);
  w.mods.fear = (w.mods.fear || 0) + (fearT - (w.mods.fear || 0)) * 0.1;
  for (const th of [0.01, 0.05, 0.15]) if (prev >= th && d.peak < th) { d.peak = th; emit(w, { cat: 'health', type: 'outbreak', title: `${d.name}: ${pct(prev)} of the city infected`, detail: `${d.totalInfected.toLocaleString('en-US')} cumulative cases, ${d.deaths} deaths, hospitals at ${pct(w.health.load, 0)} capacity.`, sev: 0.4 + th * 3, why: `transmission through households, workplaces and districts (contact level ${pct(cm, 0)})`, district: dInf.indexOf(Math.max(...dInf)) }); }
  if (overload && !(w.mods['health.overloadFlag'] > 0)) { w.mods['health.overloadFlag'] = 1; emit(w, { cat: 'health', type: 'overload', title: 'Hospitals overwhelmed', detail: `${hosp} patients for ${Math.round(beds)} beds.`, sev: 0.75, why: `${d.name} hospitalisations exceed surge capacity`, district: w.districts.find((x) => x.kind === 'medical')!.id }); }
  if (infectious + hosp + exposed === 0) {
    d.active = false; w.mods['health.overloadFlag'] = 0;
    emit(w, { cat: 'health', type: 'outbreak_end', title: `${d.name} outbreak ends`, detail: `${d.totalInfected.toLocaleString('en-US')} people were infected (${pct(d.totalInfected / Math.max(1, pop), 0)} of the city) and ${d.deaths} died over ${w.tick - d.started} days.`, sev: 0.4 });
    for (const c of cs) if (c.inf === 4) c.inf = 0;
  }
}

const baseMort = (age: number) => (age < 50 ? 0.0008 : age < 65 ? 0.005 : age < 80 ? 0.022 : 0.09) / 12;

export function monthlyHealth(w: World) {
  const H = w.health;
  let staff = 0, util = 0, nh = 0;
  for (const o of w.orgs) if (o.alive && o.type === 'hospital') { staff += o.employees.length; util += clamp(o.util / 0.95, 0.4, 1.2); nh++; }
  let boost = 0; for (const t of w.tech.items) boost += t.healthBoost * t.adoption;
  H.beds = Math.round(staff * 0.55 * (nh ? util / nh : 0) * (1 + boost) * (w.mods['health.capMult'] ?? 1));
  let chronic = 0;
  const affordFactor = 0.6 + 0.4 * w.policy.healthSubsidy;
  for (const c of w.citizens) {
    if (!isActive(c)) continue;
    if (c.health < 0.45) chronic += 0.25;
    const h = w.households[c.hh];
    const access = clamp(H.careQuality * (h.pp > 1.1 ? 1 : affordFactor) * (h.homeless ? 0.6 : 1), 0.3, 1.2);
    const target = clamp((0.97 - Math.max(0, c.age - 40) * 0.006) * (0.75 + 0.25 * access) + boost * 0.5 - c.stress * 0.05, 0.1, 1);
    c.health += (target - c.health) * 0.06;
    c.stress = clamp(c.stress * 0.93 + (c.status === 'unemployed' ? 0.03 : 0) + (h.pp < 1 ? 0.04 : 0));
    if (rand(w) < baseMort(c.age) * (1 + (1 - c.health) * 6)) { killCitizen(w, c, c.age > 75 ? 'old age' : 'illness'); continue; }
  }
  w.metrics.chronicBeds = chronic;
  if (!H.diseases.some((d) => d.active)) { H.occupied = Math.round(chronic); H.load = H.occupied / Math.max(1, H.beds); }
  H.careQuality = clamp(1.15 - Math.max(0, H.load - 0.7) * 0.7, 0.35, 1.15) * clamp(0.6 + 0.4 * (nh ? util / nh : 0), 0.5, 1.1);
}

export function infectionLabel(c: Citizen): string { return ['Healthy', 'Exposed', 'Infectious', 'Hospitalised', 'Recovered (immune)'][c.inf] || 'Healthy'; }
