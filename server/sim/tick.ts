// Simulation scheduler. One tick = one simulated day. Systems run at different frequencies:
// daily (markets, staggered agent decisions, epidemics, shocks), weekly (labour market),
// monthly (budgets, firms, government, health, education, technology, housing, society).
import type { World } from './types';
import { DAYS_PER_MONTH } from './types';
import { dailyMarkets, monthlyEconomy } from './economy';
import { dailyAgents } from './agents';
import { labourMarket } from './orgs';
import { monthlyGovernment } from './government';
import { dailyHealth, monthlyHealth } from './health';
import { monthlyEducation } from './education';
import { monthlyTechnology } from './technology';
import { monthlyHousing } from './housing';
import { monthlySocial, dailyShocks } from './social';
import { computeMetrics, recordHistory, refreshDaily } from './metrics';

export function tick(w: World) {
  w.tick++;
  dailyMarkets(w);
  dailyAgents(w);
  dailyHealth(w);
  if (w.ext.shocks.length) dailyShocks(w);
  if (w.tick % 7 === 0) labourMarket(w);
  if (w.tick % DAYS_PER_MONTH === 0) {
    const flows = monthlyEconomy(w);
    monthlyGovernment(w, flows);
    monthlyHealth(w);
    monthlyEducation(w);
    monthlyTechnology(w);
    monthlyHousing(w);
    monthlySocial(w);
    computeMetrics(w);
    recordHistory(w);
  } else refreshDaily(w);
}

export function runTicks(w: World, n: number) { for (let i = 0; i < n; i++) tick(w); }

export function cloneWorld(w: World): World { return structuredClone(w); }
