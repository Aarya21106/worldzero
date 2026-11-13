import { generateWorld } from '../server/sim/generate';
import { tick } from '../server/sim/tick';
const t0 = Date.now(); const w = generateWorld();
const lots = w.districts.reduce((n, d) => n + d.lots.filter((l) => !l.used).length, 0);
const alive = () => w.orgs.filter((o) => o.alive);
const sz = (t: string) => { const a = alive().filter((o) => o.type === t); return `${a.length}x${(a.reduce((s, o) => s + o.employees.length, 0) / Math.max(1, a.length)).toFixed(0)}`; };
console.log(`gen ${Date.now() - t0}ms citizens ${w.citizens.length} hh ${w.households.length} orgs ${w.orgs.length} buildings ${w.buildings.length} freeLots ${lots} badDistrict ${w.orgs.filter((o) => o.district < 0).length} numbered ${w.orgs.filter((o) => /\d$/.test(o.name)).length}`);
console.log('sizes', ['corporation','startup','small_business','bank','university','school','hospital','research_lab','gov_department'].map((t) => `${t} ${sz(t)}`).join(' | '));
const show = () => { const m = w.metrics; console.log(`y${(w.tick/360).toFixed(1)} pop ${m.population} u ${(m.unemployment*100).toFixed(1)}% infl ${(m.inflation*100).toFixed(1)}% gdp ${(m.gdp/1e6).toFixed(0)}M stab ${m.stability.toFixed(2)} trust ${m.publicTrust.toFixed(2)} biz ${m.businesses} su ${m.startups} pov ${(m.povertyRate*100).toFixed(1)}% vac ${(m.vacancy*100).toFixed(1)} rent ${m.avgRent.toFixed(2)} home ${(m.homelessRate*100).toFixed(2)}% stu ${m.students}/${m.uniCapacity} rate ${(m.interestRate*100).toFixed(1)} ipo ${w.counters['org.ipo']||0} bld ${w.buildings.length}`); };
show(); const t1 = Date.now();
for (let i = 0; i < 3600; i++) { tick(w); if (w.tick % 360 === 0) show(); }
console.log('ms/tick', ((Date.now() - t1) / 3600).toFixed(2), 'json MB', (JSON.stringify(w).length / 1e6).toFixed(1));
