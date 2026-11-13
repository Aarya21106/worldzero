// Engine smoke run: generate a world, simulate, print the headline trajectory.
import { generateWorld } from '../server/sim/generate';
import { tick } from '../server/sim/tick';

const t0 = Date.now();
const w = generateWorld();
console.log('gen ms', Date.now() - t0, 'citizens', w.citizens.length, 'hh', w.households.length, 'orgs', w.orgs.length, 'buildings', w.buildings.length);
const show = () => {
  const m = w.metrics;
  console.log(`t${String(w.tick).padStart(4)} pop ${m.population} u ${(m.unemployment * 100).toFixed(1)}% infl ${(m.inflation * 100).toFixed(1)}% cpi ${m.cpi.toFixed(3)} gdp ${(m.gdp / 1e6).toFixed(0)}M idx ${m.marketIndex.toFixed(0)} conf ${m.confidence.toFixed(2)} trust ${m.publicTrust.toFixed(2)} happy ${m.happiness.toFixed(2)} stab ${m.stability.toFixed(2)} biz ${m.businesses} su ${m.startups} pov ${(m.povertyRate * 100).toFixed(1)}% bal ${(m.govBalance / 1e6).toFixed(1)}M rate ${(m.interestRate * 100).toFixed(2)} wealth ${(m.avgHouseholdWealth / 1e3).toFixed(0)}k stu ${m.students}/${m.uniCapacity} vac ${(m.vacancy * 100).toFixed(1)} prot ${(m.protestShare * 100).toFixed(1)} open ${m.openings}`);
};
show();
console.log('sectors', Object.entries(w.sectors).map(([k, s]) => `${k}: exp ${(s.exports / 1e3).toFixed(0)}k imp ${s.importShare.toFixed(2)} firms ${s.firms}`).join(' | '));
console.log('tuition', w.tuition, 'transfer', Math.round(w.gov.transfer), 'budgets', JSON.stringify(Object.fromEntries(Object.entries(w.baseBudgets).map(([k, v]) => [k, Math.round(v)]))));
const months = Number(process.argv[2] || 36);
const t1 = Date.now();
for (let i = 0; i < months * 30; i++) { tick(w); if (w.tick % 90 === 0) show(); }
console.log('ms/tick', ((Date.now() - t1) / (months * 30)).toFixed(2));
console.log('sectors', Object.entries(w.sectors).map(([k, s]) => `${k}: util ${s.util.toFixed(2)} p ${s.price.toFixed(2)} w ${s.wageIdx.toFixed(2)} jobs ${s.jobs}`).join(' | '));
console.log('counters', JSON.stringify(Object.fromEntries(Object.entries(w.counters).filter(([k]) => !/\.t\d$/.test(k)).map(([k, v]) => [k, Math.round(v)]))));
console.log('events', w.events.slice(-12).map((e) => `[${e.t}] ${e.title}`).join('\n'));
