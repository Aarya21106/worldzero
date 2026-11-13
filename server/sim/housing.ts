// Housing and infrastructure: rents respond to vacancy, households that cannot pay are evicted,
// construction responds to scarcity (new buildings really appear on the map), utilities track load.
import type { World, Household } from './types';
import { clamp } from './types';
import { rand } from './rng';
import { isActive, emit, count, remember, newBuilding, buildingHeightFor, pct } from './world';
import { houseHousehold } from './generate';

export function evict(w: World, h: Household, why: string) {
  if (h.building >= 0) { const b = w.buildings[h.building]; b.occupied = Math.max(0, b.occupied - 1); }
  h.building = -1; h.arrears = 0;
  const old = h.wclass; h.wclass = 0;
  const ok = houseHousehold(w, h);
  h.wclass = old;
  if (!ok || h.pp < 0.75) { if (ok) { w.buildings[h.building].occupied--; h.building = -1; } h.homeless = true; count(w, 'housing.homeless'); }
  count(w, 'housing.evictions');
  for (const id of h.members) { const c = w.citizens[id]; if (isActive(c)) { c.happy = clamp(c.happy - 0.2); c.trustGov = clamp(c.trustGov - 0.08); if (c.age >= 18) remember(w, c, 'evicted', h.homeless ? `Evicted and left homeless: ${why}` : `Evicted — moved to cheaper housing in ${w.districts[h.district].name}`, -0.9); } }
}

export function monthlyHousing(w: World) {
  const H = w.housing, pol = w.policy;
  // completions
  for (const b of w.buildings) if (b.status === 'construction' && w.tick >= b.readyAt) { b.status = 'active'; if (b.kind === 'residential') { count(w, 'housing.completed'); emit(w, { cat: 'housing', type: 'completed', title: `New housing opens in ${w.districts[b.district].name}`, detail: `${b.units} homes completed.`, sev: 0.2, district: b.district, entity: `building:${b.id}` }); } }
  // evictions and rehousing
  for (const h of w.households) {
    if (!h.alive) continue;
    if (h.homeless) { if (h.pp > 1.05 && houseHousehold(w, h)) count(w, 'housing.rehoused'); continue; }
    if (!h.owns && h.arrears >= 3) evict(w, h, 'three months of unpaid rent');
    else if (h.owns && h.hardship >= 6 && h.mortgage > 0) { h.owns = false; h.mortgage = 0; count(w, 'housing.foreclosures'); evict(w, h, 'mortgage foreclosure'); }
  }
  // district rents
  let cap = 0, occ = 0, rentSum = 0, n = 0, homeless = 0, hhN = 0;
  const dCap = w.districts.map(() => 0), dOcc = w.districts.map(() => 0);
  for (const b of w.buildings) if (b.kind === 'residential' && b.status === 'active') { const u = Math.floor(b.units * H.supplyMult); dCap[b.district] += u; dOcc[b.district] += Math.min(b.occupied, u + 50); }
  for (const d of w.districts) {
    if (!dCap[d.id]) continue;
    cap += dCap[d.id]; occ += dOcc[d.id];
    const vac = 1 - dOcc[d.id] / dCap[d.id];
    let ch = clamp(0.4 * (0.11 - vac), -0.006, 0.03) + 0.0015;
    if (pol.rentControl > 0 && ch > 0) ch *= 1 - clamp(pol.rentControl, 0, 1);
    d.rentIdx = clamp(d.rentIdx * (1 + ch), 0.3, 8);
    rentSum += d.rentIdx; n++;
  }
  for (const h of w.households) if (h.alive) { hhN++; if (h.homeless) homeless++; }
  H.vacancy = cap ? 1 - occ / cap : 0; H.avgRent = n ? (rentSum / n) * w.prices.housing : 1; H.homeless = homeless;
  w.metrics.homelessRate = homeless / Math.max(1, hhN);
  H.propertyIdx += (clamp(H.avgRent * Math.pow(0.035 / Math.max(0.005, pol.interestRate), 0.35), 0.2, 10) - H.propertyIdx) * 0.15;
  // overcrowding from a supply shock: households above capacity lose their homes
  if (H.supplyMult < 1) for (const b of w.buildings) { if (b.kind !== 'residential') continue; const u = Math.floor(b.units * H.supplyMult); if (b.occupied > u) { const victims = w.households.filter((h) => h.alive && h.building === b.id).slice(0, b.occupied - u); for (const h of victims) evict(w, h, 'building units withdrawn from the market'); } }
  // construction response
  H.pipeline *= 0.5;
  const builders = w.orgs.some((o) => o.alive && o.sector === 'construction');
  if (builders && (H.vacancy < 0.07 || (homeless > hhN * 0.006 && H.vacancy < 0.1)) && w.market.credit > 0.4 && w.buildings.filter((b) => b.status === 'construction' && b.kind === 'residential').length < Math.ceil(4 * (w.mods.scale ?? 1))) {
    const ds = w.districts.filter((d) => d.kind === 'residential' && d.lots.some((l) => !l.used)).sort((a, b) => (1 - dOcc[a.id] / Math.max(1, dCap[a.id])) - (1 - dOcc[b.id] / Math.max(1, dCap[b.id])));
    const d = homeless > 5 * (w.mods.scale ?? 1) ? ds.find((x) => x.wealth === 0) || ds[0] : ds[0];
    if (d) {
      const units = [14, 10, 4][d.wealth] + Math.floor(rand(w) * 4);
      const b = newBuilding(w, 'residential', ['residential'], { district: d.id, units, construction: true, name: `${d.name} New Development ${w.buildings.length}` });
      if (b) { b.readyAt = w.tick + 90; b.h = buildingHeightFor(w, b); H.pipeline += units * 9000 * w.cpi; count(w, 'housing.started'); emit(w, { cat: 'housing', type: 'construction', title: `Construction starts in ${d.name}`, detail: `${units} new homes planned.`, sev: 0.15, district: d.id, entity: `building:${b.id}`, why: `city-wide vacancy ${pct(H.vacancy)}, ${homeless} homeless households` }); }
    }
  }
  // heights follow real occupancy / headcount
  for (const b of w.buildings) { if (b.kind !== 'residential') b.h = buildingHeightFor(w, b); if (b.kind !== 'residential' && b.status !== 'construction') b.status = b.orgs.some((id) => w.orgs[id].alive) ? 'active' : 'vacant'; }
  // utilities
  const pop = w.metrics.population || 1, base = w.mods['base.pop'] || (w.mods['base.pop'] = pop);
  const outB = w.mods['base.output'] || (w.mods['base.output'] = w.mods['flow.output'] || 1);
  const outNow = (w.mods['flow.output'] || outB) / w.cpi;
  let eff = 0; for (const t of w.tech.items) eff += t.energyEff * t.adoption;
  const I = w.infra;
  I.energyUse = (0.85 * (0.5 * pop / base + 0.5 * outNow / outB) * (1 - clamp(eff, 0, 0.7))) / Math.max(0.05, I.energyCap);
  I.waterUse = (0.8 * pop / base) / Math.max(0.05, I.waterCap);
  if (I.energyUse > 1) { const up = clamp((I.energyUse - 1) * 0.25, 0, 0.08); w.sectors.energy.price *= 1 + up; w.prices.energy = w.sectors.energy.price; if (!(w.mods['infra.energyFlag'] > 0)) { w.mods['infra.energyFlag'] = 1; emit(w, { cat: 'economy', type: 'energy_shortage', title: 'Energy shortage', detail: `Demand is ${pct(I.energyUse, 0)} of generating capacity; prices are rising and output is rationed.`, sev: 0.6, why: `energy capacity ${I.energyCap.toFixed(2)}× baseline`, district: w.districts.find((d) => d.kind === 'industrial')!.id }); } } else w.mods['infra.energyFlag'] = 0;
  if (I.waterUse > 1 && !(w.mods['infra.waterFlag'] > 0)) { w.mods['infra.waterFlag'] = 1; emit(w, { cat: 'social', type: 'water_shortage', title: 'Water shortage', detail: `Water demand is ${pct(I.waterUse, 0)} of supply.`, sev: 0.55 }); } else if (I.waterUse <= 1) w.mods['infra.waterFlag'] = 0;
}
