// Technology Engine: research output accumulates into breakthroughs; technologies diffuse on a
// logistic adoption curve and change sector productivity, automation, health and energy use.
import type { World, TechItem, Sector } from './types';
import { clamp, SECTORS } from './types';
import { rand, pick, shuffle } from './rng';
import { isActive, emit, count, pct } from './world';
import { TECH_NAMES } from './names';
import { foundBusiness } from './orgs';

type Tpl = { productivity: Partial<Record<Sector, number>>; automation: Partial<Record<Sector, number>>; healthBoost: number; energyEff: number };
const DOMAINS: Record<string, Tpl> = {
  ai: { productivity: { tech: 0.25, finance: 0.15, services: 0.1, media: 0.1, retail: 0.05, manufacturing: 0.08, government: 0.05, research: 0.12 }, automation: { services: 0.12, retail: 0.12, finance: 0.15, manufacturing: 0.1, media: 0.08 }, healthBoost: 0.01, energyEff: 0 },
  robotics: { productivity: { manufacturing: 0.2, construction: 0.15, food: 0.1, retail: 0.05 }, automation: { manufacturing: 0.25, construction: 0.12, food: 0.1, retail: 0.1 }, healthBoost: 0, energyEff: 0 },
  energy: { productivity: { energy: 0.3, manufacturing: 0.1 }, automation: {}, healthBoost: 0, energyEff: 0.3 },
  biotech: { productivity: { healthcare: 0.2, research: 0.1 }, automation: {}, healthBoost: 0.08, energyEff: 0 },
  materials: { productivity: { manufacturing: 0.2, construction: 0.2, energy: 0.05 }, automation: {}, healthBoost: 0, energyEff: 0.05 },
  fintech: { productivity: { finance: 0.25, retail: 0.04 }, automation: { finance: 0.15 }, healthBoost: 0, energyEff: 0 },
  agri: { productivity: { food: 0.3 }, automation: { food: 0.08 }, healthBoost: 0.01, energyEff: 0 },
};
export const TECH_DOMAINS = Object.keys(DOMAINS);

export function createBreakthrough(w: World, o: { name?: string; domain?: string; magnitude?: number; origin?: string; adoption?: number } = {}): TechItem {
  const domain = o.domain && DOMAINS[o.domain] ? o.domain : pick(w, TECH_DOMAINS);
  const mag = clamp(o.magnitude ?? 0.6 + rand(w) * 0.6, 0.1, 4);
  const tpl = DOMAINS[domain];
  const scale = (r: Partial<Record<Sector, number>>) => { const out: Partial<Record<Sector, number>> = {}; for (const k of Object.keys(r) as Sector[]) out[k] = r[k]! * mag; return out; };
  const names = TECH_NAMES[domain] || TECH_NAMES.ai;
  const name = o.name || names.find((n) => !w.tech.items.some((t) => t.name === n)) || `${pick(w, names)} Mk ${w.tech.items.length + 1}`;
  const item: TechItem = { id: w.nextIds.tech++, name, domain, emerged: w.tick, adoption: clamp(o.adoption ?? 0.04, 0.01, 1), speed: 0.1 + rand(w) * 0.08, productivity: scale(tpl.productivity), automation: scale(tpl.automation), healthBoost: tpl.healthBoost * mag, energyEff: tpl.energyEff * mag, origin: o.origin || 'research' };
  w.tech.items.push(item);
  w.mods.techBoom = Math.min(2, (w.mods.techBoom || 0) + 0.6 * mag);
  w.market.confidence = clamp(w.market.confidence + 0.05 * mag, 0.1, 1.6);
  count(w, 'tech.breakthroughs');
  const dist = w.districts.find((d) => d.kind === 'research')!;
  emit(w, { cat: 'technology', type: 'breakthrough', title: `Breakthrough: ${name}`, detail: `A ${domain} technology emerges (magnitude ${mag.toFixed(2)}). Sectors affected: ${Object.keys(item.productivity).join(', ')}.`, sev: clamp(0.45 + mag * 0.2), district: dist.id, why: o.origin === 'intervention' ? 'introduced by GOD MODE intervention' : `accumulated research output reached the discovery threshold (${w.tech.progress.toFixed(0)}/${w.tech.nextAt.toFixed(0)})` });
  // spin-outs: ambitious, educated people commercialise it
  const founders = shuffle(w, w.citizens.filter((c) => isActive(c) && c.edu >= 3 && c.age >= 24 && c.age < 55 && (c.status === 'employed' || c.status === 'unemployed') && c.traits.ambition > 0.6 && c.savings > 4000)).slice(0, Math.max(1, Math.round(1 + mag * 1.5)));
  const sector: Sector = domain === 'biotech' ? 'healthcare' : domain === 'energy' ? 'energy' : domain === 'fintech' ? 'finance' : 'tech';
  for (const f of founders) foundBusiness(w, f, { type: 'startup', sector });
  recomputeTech(w);
  return item;
}

export function recomputeTech(w: World) {
  let level = 1;
  for (const s of SECTORS) { let p = w.mods[`prod.${s}`] ?? 1, a = w.mods[`autom.${s}`] ?? 0; for (const t of w.tech.items) { p *= 1 + (t.productivity[s] || 0) * t.adoption; a += (t.automation[s] || 0) * t.adoption; } w.sectors[s].prod = p; w.sectors[s].autom = clamp(a, -0.5, 3); }
  for (const t of w.tech.items) level += t.adoption * 0.25;
  w.tech.level = level * (w.mods['tech.levelMult'] ?? 1);
}

export function monthlyTechnology(w: World) {
  const T = w.tech;
  let out = 0;
  for (const o of w.orgs) {
    if (!o.alive) continue;
    const wgt = o.type === 'research_lab' ? 1 : o.type === 'university' ? 0.3 : o.sector === 'tech' || o.type === 'startup' ? 0.15 : 0;
    if (!wgt) continue;
    const fund = clamp(o.util / 0.95, 0.2, 2);
    for (const id of o.employees) { const c = w.citizens[id]; if (c.edu >= 3) out += wgt * (0.5 + c.skill) * fund; }
  }
  out *= clamp(0.8 + 0.2 * w.infra.quality, 0.5, 1.3);
  if (!w.mods['tech.baseOutput']) { w.mods['tech.baseOutput'] = out; T.nextAt = out * (30 + rand(w) * 16); }
  T.output = out; T.progress += out;
  if (T.progress >= T.nextAt) { createBreakthrough(w); T.progress = 0; T.nextAt = (w.mods['tech.baseOutput'] || out) * (30 + rand(w) * 20); }
  let avgEdu = w.metrics.avgEducation ?? 2.2;
  for (const t of T.items) {
    if (t.adoption >= 0.995) continue;
    const before = t.adoption;
    t.adoption = clamp(t.adoption + t.speed * t.adoption * (1 - t.adoption) * clamp(w.infra.quality, 0.4, 1.4) * clamp(avgEdu / 2.2, 0.6, 1.5), 0, 1);
    for (const th of [0.25, 0.6, 0.9]) if (before < th && t.adoption >= th) {
      const autom = Object.entries(t.automation).map(([s, v]) => `${s} −${pct((v as number) * t.adoption / (1 + (v as number) * t.adoption), 0)} labour per unit`).slice(0, 3).join(', ');
      emit(w, { cat: 'technology', type: 'adoption', title: `${t.name} reaches ${pct(th, 0)} adoption`, detail: autom ? `Automation effect so far: ${autom}.` : `Productivity gains spreading through ${Object.keys(t.productivity).join(', ')}.`, sev: 0.3, why: `diffusion speed ${t.speed.toFixed(2)} × infrastructure ${w.infra.quality.toFixed(2)} × education ${avgEdu.toFixed(2)}` });
    }
  }
  w.mods.techBoom = (w.mods.techBoom || 0) * 0.93;
  recomputeTech(w);
}
