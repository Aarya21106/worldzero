// 3D World Renderer (v2). Everything drawn comes from simulation state:
// · building form and colour follow kind + neighbourhood wealth; height follows real occupancy / headcount
// · lit windows = real occupancy (homes) or staffing (workplaces); vacant buildings go dark
// · pedestrians are real citizens walking between their real home and workplace/school
// · cars are a sample of real employed commuters driving their home→work route on the road grid
// Streets, river, bridges and trees are derived from the generated district layout.
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { MapControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from './store';

const ST_COLOR = ['#7dd3fc', '#facc15', '#4ade80', '#22d3ee', '#fb923c', '#a1a1aa', '#94a3b8', '#ef4444', '#e879f9'];
const TIER_COLOR = ['#fb923c', '#60a5fa', '#a78bfa', '#fde047'];
const GROUND: Record<string, string> = { residential: '#5d6b55', commercial: '#6b6863', business: '#5f646d', industrial: '#5a5852', university: '#5f6d55', medical: '#666a6c', research: '#5d6a62', government: '#6d6a63', park: '#3f6b3a' };
const PAL: Record<string, string[]> = {
  res0: ['#8c5a44', '#a0694f', '#7d6a5a', '#9a7b62', '#87604c'], res1: ['#b9b2a6', '#c9c1b3', '#a9a59c', '#d2c7b4', '#bfb6a5'], res2: ['#e8e2d6', '#f0ebe0', '#d9d3c8', '#e3d9c6'],
  office: ['#5d7590', '#6f8aa6', '#4f6680', '#8aa0b6', '#64798c'], commercial: ['#c79a62', '#b8875a', '#d4a76f', '#a7835f', '#c4a07a'], industrial: ['#7c7f86', '#8a8378', '#6f747a', '#857a6c'],
  university: ['#9b5b45', '#a8664e'], school: ['#c9a25b'], hospital: ['#e9edf1', '#dfe6ec'], lab: ['#cfe6e2', '#bcd8d4'], government: ['#d6d0c2', '#cfc6b3'], utility: ['#8a8f96'],
};
const KINDS = ['residential', 'commercial', 'office', 'industrial', 'university', 'school', 'hospital', 'lab', 'government', 'utility'];
const ROOF = ['#5b3a30', '#4a4a52', '#6b4434', '#3f4650'];
const CAR = ['#d9d9d9', '#2b2b2b', '#a32f2f', '#2f5ea3', '#8a8a8a', '#e0c341', '#f2f2f2', '#3a6b4a'];
const MAXB = 6000, MAXC = 40000, MAXCAR = 2000;
const tmpM = new THREE.Matrix4(), tmpC = new THREE.Color(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const hash = (i: number) => { let x = Math.imul(i + 1, 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
const pick = (arr: string[], i: number) => arr[Math.floor(hash(i * 3 + 1) * arr.length)];
const ramp = (t: number) => tmpC.setHSL(0.36 - 0.36 * Math.min(1, Math.max(0, t)), 0.55, 0.28 + 0.1 * t);

/** Layout derived once from the static district grid. */
function useLayout() {
  const st = useStore((s) => s.cityStatic);
  return useMemo(() => {
    if (!st) return null;
    const D = st.districts, cell = st.geo?.cell ?? 320, half = cell / 2;
    const xs = [...new Set(D.map((d: any) => d.x))].sort((a: any, b: any) => a - b) as number[], zs = [...new Set(D.map((d: any) => d.z))].sort((a: any, b: any) => a - b) as number[];
    const minX = xs[0] - half, maxX = xs[xs.length - 1] + half, minZ = zs[0] - half, maxZ = zs[zs.length - 1] + half;
    const vAve: number[] = [minX - 20], hAve: number[] = [minZ - 20];
    for (let i = 1; i < xs.length; i++) { const gap = xs[i] - xs[i - 1] - cell; if (gap < 60) vAve.push((xs[i] + xs[i - 1]) / 2); }
    vAve.push(maxX + 20);
    for (let i = 1; i < zs.length; i++) hAve.push((zs[i] + zs[i - 1]) / 2);
    hAve.push(maxZ + 20);
    const river = st.geo?.riverW ? { x: st.geo.riverX, w: st.geo.riverW } : null;
    return { D, cell, half, street: st.geo?.street ?? 22, minX, maxX, minZ, maxZ, W: maxX - minX, H: maxZ - minZ, vAve, hAve, river, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
  }, [st]);
}
type Layout = NonNullable<ReturnType<typeof useLayout>>;
const nearest = (arr: number[], v: number) => { let b = arr[0]; for (const a of arr) if (Math.abs(a - v) < Math.abs(b - v)) b = a; return b; };

/** Window-pattern material: windows drawn in world space so instanced scaling never stretches them. */
function makeBuildingMaterial(uniforms: { uNight: { value: number } }) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.12 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uniforms.uNight;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLit; attribute float aSeed; varying float vLit; varying float vSeed; varying vec3 vWP; varying vec3 vON;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 wp4 = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nwp4 = instanceMatrix * wp4;\n#endif\nvWP = (modelMatrix * wp4).xyz; vON = normal; vLit = aLit; vSeed = aSeed;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vLit; varying float vSeed; varying vec3 vWP; varying vec3 vON; float wzLit = 0.0;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wall = 1.0 - step(0.5, abs(vON.y));
        vec2 g = vec2((abs(vON.x) > 0.5 ? vWP.z : vWP.x) / 3.3, vWP.y / 3.6);
        vec2 f = fract(g); vec2 wid = floor(g);
        float win = wall * step(0.2, f.x) * step(f.x, 0.8) * step(0.28, f.y) * step(f.y, 0.82) * step(2.4, vWP.y) * step(0.02, vLit + 0.03);
        float hsh = fract(sin(dot(wid + vSeed * 17.0, vec2(12.9898, 78.233))) * 43758.5453);
        wzLit = win * step(hsh, vLit);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.42, 0.52, 0.62), vec3(0.06, 0.08, 0.11), uNight), win * 0.72);
        diffuseColor.rgb *= 1.0 - 0.12 * step(0.5, vON.y);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += wzLit * mix(vec3(0.05, 0.05, 0.04), vec3(1.0, 0.78, 0.45) * 1.15, uNight);');
  };
  return m;
}

function Ground({ L }: { L: Layout }) {
  const city = useStore((s) => s.city), overlay = useStore((s) => s.overlay), select = useStore((s) => s.select), night = useStore((s) => s.night);
  const labels = useMemo(() => L.D.map((d: any) => { const c = document.createElement('canvas'); c.width = 512; c.height = 64; const g = c.getContext('2d')!; g.font = '600 32px system-ui, sans-serif'; g.textAlign = 'center'; g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.strokeText(d.name.toUpperCase(), 256, 44); g.fillStyle = 'rgba(240,244,255,0.95)'; g.fillText(d.name.toUpperCase(), 256, 44); const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; }), [L]);
  const q = (L.cell - L.street) / 2;
  // lane markings
  const dashRef = useRef<THREE.InstancedMesh>(null!);
  const dashes = useMemo(() => {
    const out: [number, number, boolean][] = [];
    for (const x of L.vAve) for (let z = L.minZ - 20; z < L.maxZ + 20; z += 22) out.push([x, z, true]);
    for (const z of L.hAve) for (let x = L.minX - 20; x < L.maxX + 20; x += 22) { if (L.river && Math.abs(x - L.river.x) < L.river.w / 2) continue; out.push([x, z, false]); }
    return out;
  }, [L]);
  useEffect(() => { const m = dashRef.current; if (!m) return; dashes.forEach(([x, z, v], i) => { tmpM.compose(tmpP.set(x, 0.35, z), tmpQ.identity(), tmpS.set(v ? 1.1 : 10, 1, v ? 10 : 1.1)); m.setMatrixAt(i, tmpM); }); m.count = dashes.length; m.instanceMatrix.needsUpdate = true; }, [dashes]);
  return (<group>
    <mesh rotation-x={-Math.PI / 2} position={[L.cx, 0, L.cz]}><planeGeometry args={[L.W + 160, L.H + 160]} /><meshStandardMaterial color={night ? '#282c34' : '#3a3e45'} roughness={0.95} /></mesh>
    <instancedMesh ref={dashRef} args={[undefined, undefined, dashes.length]} frustumCulled={false}><boxGeometry args={[1, 0.1, 1]} /><meshBasicMaterial color={night ? '#8a8a70' : '#e8e2c4'} /></instancedMesh>
    {L.river && ((rv) => <>
      <mesh rotation-x={-Math.PI / 2} position={[rv.x, 0.08, L.cz]}><planeGeometry args={[rv.w, L.H + 800]} /><meshStandardMaterial color="#6f7377" roughness={1} /></mesh>
      <mesh rotation-x={-Math.PI / 2} position={[rv.x, 0.16, L.cz]}><planeGeometry args={[rv.w - 26, L.H + 800]} /><meshStandardMaterial color={night ? '#123a57' : '#2f6a8c'} roughness={0.18} metalness={0.55} /></mesh>
      {L.hAve.map((z) => (<group key={z}><mesh position={[rv.x, 1.2, z]}><boxGeometry args={[rv.w + 10, 2, 30]} /><meshStandardMaterial color={night ? '#22252b' : '#45494f'} /></mesh>
        {[-15, 15].map((dz) => <mesh key={dz} position={[rv.x, 3.2, z + dz]}><boxGeometry args={[rv.w + 10, 2, 1]} /><meshStandardMaterial color="#9aa0a8" /></mesh>)}</group>))}
    </>)(L.river)}
    {L.D.map((d: any, i: number) => {
      const dd = city?.districts?.[i]; let color = GROUND[d.kind];
      if (dd && overlay !== 'none') { const v = overlay === 'unemployment' ? dd.unemp / 0.25 : overlay === 'crime' ? dd.crime / 0.6 : overlay === 'rent' ? (dd.rent - 0.6) / 1.6 : overlay === 'income' ? 1 - dd.income / 7000 : overlay === 'infection' ? dd.infected / Math.max(1, dd.pop) / 0.15 : overlay === 'happiness' ? 1 - (dd.happy - 0.3) / 0.6 : dd.pop / 1600; color = '#' + ramp(dd.pop > 0 || overlay === 'rent' ? v : 0).getHexString(); }
      const c = new THREE.Color(color); if (night && overlay === 'none') c.multiplyScalar(0.62);
      return (<group key={d.id}>
        {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => {
          const x = d.x + sx * (q / 2 + L.street / 2), z = d.z + sz * (q / 2 + L.street / 2);
          return (<group key={`${sx}${sz}`}>
            <mesh rotation-x={-Math.PI / 2} position={[x, 0.25, z]}><planeGeometry args={[q, q]} /><meshStandardMaterial color={night ? '#3c3f44' : '#9a9ba0'} roughness={0.9} /></mesh>
            <mesh rotation-x={-Math.PI / 2} position={[x, 0.45, z]} onDoubleClick={(e) => { e.stopPropagation(); select(`district:${d.id}`, false); }}><planeGeometry args={[q - 8, q - 8]} /><meshStandardMaterial color={c} roughness={0.95} /></mesh>
          </group>);
        })}
        <sprite position={[d.x, 9, d.z + L.half + 12]} scale={[150, 19, 1]}><spriteMaterial map={labels[i]} transparent depthWrite={false} opacity={0.9} /></sprite>
      </group>);
    })}
  </group>);
}

function Trees({ L }: { L: Layout }) {
  const crown = useRef<THREE.InstancedMesh>(null!), trunk = useRef<THREE.InstancedMesh>(null!);
  const pts = useMemo(() => {
    const out: [number, number, number][] = []; let k = 0;
    const ok = (x: number) => !L.river || Math.abs(x - L.river.x) > L.river.w / 2 + 2;
    for (const x of L.vAve) for (let z = L.minZ; z < L.maxZ; z += 34) for (const s of [-1, 1]) if (!L.hAve.some((h) => Math.abs(h - z) < 26) && ok(x + s * 17)) out.push([x + s * 17, z + (hash(k++) - 0.5) * 6, 0.8 + hash(k++) * 0.5]);
    for (const z of L.hAve) for (let x = L.minX; x < L.maxX; x += 34) for (const s of [-1, 1]) if (!L.vAve.some((v) => Math.abs(v - x) < 26) && ok(x)) out.push([x + (hash(k++) - 0.5) * 6, z + s * 17, 0.8 + hash(k++) * 0.5]);
    for (const d of L.D) {
      const n = d.kind === 'park' ? 150 : d.kind === 'residential' ? (d.wealth === 2 ? 70 : d.wealth === 1 ? 30 : 10) : d.kind === 'university' ? 40 : 0;
      for (let i = 0; i < n; i++) { const a = hash(d.id * 977 + i * 3), b = hash(d.id * 613 + i * 7); const x = d.x + (a - 0.5) * (L.cell - 30), z = d.z + (b - 0.5) * (L.cell - 30); if (d.kind !== 'park' && Math.abs(x - d.x) > 18 && Math.abs(z - d.z) > 18 && hash(i + d.id) > 0.25) { const lx = ((x - d.x + 160) % 36), lz = ((z - d.z + 160) % 36); if (lx > 6 && lx < 30 && lz > 6 && lz < 30) continue; } out.push([x, z, 0.7 + hash(i * 11 + d.id) * 0.8]); }
    }
    return out;
  }, [L]);
  useEffect(() => {
    pts.forEach(([x, z, s], i) => {
      tmpM.compose(tmpP.set(x, 7 * s + 4, z), tmpQ.identity(), tmpS.set(s, s, s)); crown.current.setMatrixAt(i, tmpM);
      crown.current.setColorAt(i, tmpC.setHSL(0.27 + hash(i) * 0.08, 0.45, 0.22 + hash(i + 5) * 0.1));
      tmpM.compose(tmpP.set(x, 2.5 * s, z), tmpQ.identity(), tmpS.set(s, s, s)); trunk.current.setMatrixAt(i, tmpM);
    });
    crown.current.count = trunk.current.count = pts.length;
    crown.current.instanceMatrix.needsUpdate = trunk.current.instanceMatrix.needsUpdate = true; if (crown.current.instanceColor) crown.current.instanceColor.needsUpdate = true;
  }, [pts]);
  return (<>
    <instancedMesh ref={crown} args={[undefined, undefined, pts.length]} frustumCulled={false} raycast={() => null}><icosahedronGeometry args={[6, 0]} /><meshStandardMaterial roughness={0.9} flatShading /></instancedMesh>
    <instancedMesh ref={trunk} args={[undefined, undefined, pts.length]} frustumCulled={false} raycast={() => null}><cylinderGeometry args={[0.7, 0.9, 5, 5]} /><meshStandardMaterial color="#4a3726" /></instancedMesh>
  </>);
}

/** Visual height: business towers rise toward the city centre (density gradient). */
export function visualHeight(b: number[], L: Layout) {
  let h = b[8] === 2 ? Math.max(4, b[6] * 0.35) : b[6];
  if (b[7] === 2) { const dist = Math.hypot(b[2] - L.cx, b[3] - L.cz); h *= 1 + 0.9 * Math.max(0, 1 - dist / (L.W * 0.42)); }
  return h;
}

function Buildings({ L }: { L: Layout }) {
  const city = useStore((s) => s.city), select = useStore((s) => s.select), selected = useStore((s) => s.selected), night = useStore((s) => s.night), st = useStore((s) => s.cityStatic);
  const body = useRef<THREE.InstancedMesh>(null!), roof = useRef<THREE.InstancedMesh>(null!), chim = useRef<THREE.InstancedMesh>(null!), owner = useRef<number[]>([]);
  const uniforms = useMemo(() => ({ uNight: { value: 1 } }), []);
  const mat = useMemo(() => makeBuildingMaterial(uniforms), [uniforms]);
  const attrs = useMemo(() => ({ lit: new THREE.InstancedBufferAttribute(new Float32Array(MAXB), 1), seed: new THREE.InstancedBufferAttribute(new Float32Array(MAXB), 1) }), []);
  const geo = useMemo(() => { const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0); g.setAttribute('aLit', attrs.lit); g.setAttribute('aSeed', attrs.seed); return g; }, [attrs]);
  useFrame((_, dt) => { uniforms.uNight.value += ((night ? 1 : 0) - uniforms.uNight.value) * Math.min(1, dt * 3); });
  useEffect(() => {
    const m = body.current; if (!m || !city || !st) return;
    const B = city.buildings, own: number[] = []; let bi = 0, ri = 0, ci = 0;
    const put = (bid: number, x: number, y: number, z: number, w: number, h: number, d: number, col: THREE.Color, lit: number) => {
      if (bi >= MAXB) return; tmpM.compose(tmpP.set(x, y, z), tmpQ.identity(), tmpS.set(w, h, d)); m.setMatrixAt(bi, tmpM); m.setColorAt(bi, col); attrs.lit.setX(bi, lit); attrs.seed.setX(bi, hash(bid * 7 + bi)); own[bi] = bid; bi++;
    };
    for (let i = 0; i < B.length; i++) {
      const b = B[i], kind = KINDS[b[7]], wealth = st.districts[b[1]]?.wealth ?? 1, h = visualHeight(b, L);
      const status = b[8], emp = b[13] ?? 0;
      let col: THREE.Color;
      if (status === 2) col = new THREE.Color('#c98b2b');
      else { col = new THREE.Color(pick(kind === 'residential' ? PAL[`res${wealth}`] : PAL[kind] || PAL.utility, i)); if (status === 1) col.lerp(new THREE.Color('#2b2e36'), 0.6); else if (city.tick - b[12] < 120 && b[12] > 0) col.lerp(new THREE.Color('#ffffff'), 0.3); }
      const lit = status !== 0 ? 0 : kind === 'residential' ? Math.min(0.95, b[10] / Math.max(1, b[9])) * 0.85 : Math.min(0.95, emp > 0 ? 0.2 + emp / Math.max(4, (h / 3.6) * 3) : 0);
      const house = kind === 'residential' && b[9] <= 4 && status !== 2;
      // podium + tower for tall offices; plain massing otherwise
      if (kind === 'office' && h > 70 && status !== 2) {
        put(i, b[2], 0, b[3], b[4], 14, b[5], col, lit);
        put(i, b[2], 14, b[3], b[4] * 0.72, h - 14, b[5] * 0.72, col, lit);
        if (h > 130) put(i, b[2], h, b[3], b[4] * 0.42, h * 0.08, b[5] * 0.42, col, lit * 0.6);
      } else put(i, b[2], 0, b[3], house ? b[4] * 0.7 : b[4], house ? Math.min(h, 9) : h, house ? b[5] * 0.7 : b[5], col, lit);
      if ((house || (kind === 'school') || (kind === 'residential' && h < 24)) && ri < MAXB) {
        const w = house ? b[4] * 0.7 : b[4], d = house ? b[5] * 0.7 : b[5], top = house ? Math.min(h, 9) : h;
        tmpQ.setFromAxisAngle(UP, Math.PI / 4); tmpM.compose(tmpP.set(b[2], top + 3.5, b[3]), tmpQ, tmpS.set(w * 0.72, 7, d * 0.72)); roof.current.setMatrixAt(ri, tmpM); roof.current.setColorAt(ri, tmpC.set(pick(ROOF, i))); ri++;
      }
      if (kind === 'industrial' && status === 0 && ci < MAXB - 2) for (let k = 0; k < 1 + (i % 2); k++) { tmpM.compose(tmpP.set(b[2] + (k ? -1 : 1) * b[4] * 0.28, h + 9, b[3] + b[5] * 0.25), tmpQ.identity(), tmpS.set(1, 1, 1)); chim.current.setMatrixAt(ci++, tmpM); }
    }
    owner.current = own; m.count = bi; roof.current.count = ri; chim.current.count = ci;
    for (const x of [m, roof.current, chim.current]) { x.instanceMatrix.needsUpdate = true; if (x.instanceColor) x.instanceColor.needsUpdate = true; }
    attrs.lit.needsUpdate = true; attrs.seed.needsUpdate = true; m.computeBoundingSphere();
  }, [city, st, L]);
  const sel = selected?.startsWith('building:') && city ? city.buildings[Number(selected.split(':')[1])] : null, sh = sel ? visualHeight(sel, L) : 0;
  return (<>
    <instancedMesh ref={body} args={[geo, mat, MAXB]} frustumCulled={false} onClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) select(`building:${owner.current[e.instanceId]}`, false); }} />
    <instancedMesh ref={roof} args={[undefined, undefined, MAXB]} frustumCulled={false} raycast={() => null}><coneGeometry args={[1, 1, 4]} /><meshStandardMaterial roughness={0.8} flatShading /></instancedMesh>
    <instancedMesh ref={chim} args={[undefined, undefined, MAXB]} frustumCulled={false} raycast={() => null}><cylinderGeometry args={[1.6, 2.2, 18, 8]} /><meshStandardMaterial color="#6a5f57" /></instancedMesh>
    {sel && <mesh position={[sel[2], sh / 2, sel[3]]}><boxGeometry args={[sel[4] + 3, sh + 3, sel[5] + 3]} /><meshBasicMaterial color="#56e0c2" wireframe /></mesh>}
  </>);
}

function Citizens({ L }: { L: Layout }) {
  const select = useStore((s) => s.select);
  const ref = useRef<THREE.InstancedMesh>(null!), marker = useRef<THREE.Mesh>(null!), clock = useRef(0), colorKey = useRef('');
  const { camera } = useThree();
  useFrame((_, dt) => {
    const s = useStore.getState(), city = s.city, st = s.cityStatic, m = ref.current; if (!city || !st || !m) return;
    if (s.status?.running && !s.status?.busy) clock.current += Math.min(dt, 0.1) * Math.min(3, 0.6 + (s.status.speed || 1) * 0.2);
    const T = clock.current / 26, C = city.citizens, B = city.buildings, n = Math.min(C.st.length, MAXC);
    const civic = st.districts[city.civic], parks = st.districts.filter((d: any) => d.kind === 'park');
    const scale = Math.min(3.5, Math.max(1, camera.position.y / 450));
    const selId = s.selected?.startsWith('citizen:') ? Number(s.selected.split(':')[1]) : -1;
    const key = `${city.version}|${s.colorBy}|${n}`, recolor = key !== colorKey.current; colorKey.current = key;
    m.count = n; let sx = 0, sz = 0, sv = false;
    for (let i = 0; i < n; i++) {
      const code = C.st[i], hb = B[C.home[i]];
      if (code === 255) { tmpM.makeScale(0, 0, 0); m.setMatrixAt(i, tmpM); continue; }
      const r1 = hash(i), r2 = hash(i + 7777), park = parks[i % parks.length];
      let hx: number, hz: number;
      if (hb) { hx = hb[2] + (r1 - 0.5) * (hb[4] + 6); hz = hb[3] + hb[5] / 2 + 2 + r2 * 3; } else { hx = park.x + (r1 - 0.5) * 240; hz = park.z + (r2 - 0.5) * 240; }
      let wx = hx, wz = hz; const wb = B[C.work[i]];
      if (code === 8) { wx = civic.x + (r1 - 0.5) * 130; wz = civic.z + (r2 - 0.5) * 130; }
      else if (code === 7) { wx = hx; wz = hz; }
      else if (wb) { wx = wb[2] + (r2 - 0.5) * (wb[4] + 6); wz = wb[3] + wb[5] / 2 + 2 + r1 * 3; }
      else if (code !== 0 || r1 > 0.5) { const dd = st.districts[hb ? hb[1] : 0]; wx = dd.x + (r2 - 0.5) * 280; wz = dd.z + (r1 - 0.5) * 280; if (r1 < 0.25) { wx = park.x + (r2 - 0.5) * 250; wz = park.z + (r1 - 0.5) * 250; } }
      const ph = (T + r1 * 0.37 + r2 * 0.63) % 1;
      const f = code === 8 ? 1 : ph < 0.16 ? ph / 0.16 : ph < 0.5 ? 1 : ph < 0.66 ? 1 - (ph - 0.5) / 0.16 : 0;
      const total = Math.abs(wx - hx) + Math.abs(wz - hz) || 1, d = f * total, ax = Math.abs(wx - hx);
      const x = d < ax ? hx + Math.sign(wx - hx) * d : wx, z = d < ax ? hz : hz + Math.sign(wz - hz) * (d - ax);
      const jig = f === 1 || f === 0 ? Math.sin(clock.current * 0.8 + i) * 1.2 : 0;
      tmpM.compose(tmpP.set(x + jig, 1.8 * scale, z), tmpQ.identity(), tmpS.set(scale, scale, scale)); m.setMatrixAt(i, tmpM);
      if (i === selId) { sx = x; sz = z; sv = true; }
      if (recolor) m.setColorAt(i, tmpC.set(s.colorBy === 'wealth' ? TIER_COLOR[C.tier[i]] : ST_COLOR[code] || '#ffffff'));
    }
    m.instanceMatrix.needsUpdate = true; if (recolor && m.instanceColor) m.instanceColor.needsUpdate = true;
    if (marker.current) { marker.current.visible = sv; if (sv) { marker.current.position.set(sx, 14 * scale + Math.sin(clock.current * 3) * 2, sz); marker.current.scale.setScalar(scale); } }
  });
  return (<>
    <instancedMesh ref={ref} args={[undefined, undefined, MAXC]} frustumCulled={false} onClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) select(`citizen:${e.instanceId}`, false); }}>
      <octahedronGeometry args={[1.5, 0]} /><meshBasicMaterial toneMapped={false} />
    </instancedMesh>
    <mesh ref={marker} visible={false} rotation-x={Math.PI}><coneGeometry args={[4, 10, 4]} /><meshBasicMaterial color="#56e0c2" /></mesh>
  </>);
}

/** Traffic: a sample of real employed commuters drive home→work along avenues (and across bridges). */
function Traffic({ L }: { L: Layout }) {
  const city = useStore((s) => s.city), night = useStore((s) => s.night);
  const ref = useRef<THREE.InstancedMesh>(null!), clock = useRef(0);
  const routes = useMemo(() => {
    if (!city) return [];
    const C = city.citizens, B = city.buildings, out: { p: number[]; len: number; seed: number }[] = [];
    let employed = 0; for (let i = 0; i < C.st.length; i++) if (C.st[i] === 2 || C.st[i] === 3) employed++;
    const want = Math.min(MAXCAR, Math.round(employed / 9)), stride = Math.max(1, Math.floor(employed / Math.max(1, want)));
    let k = 0;
    for (let i = 0; i < C.st.length && out.length < want; i++) {
      if (!(C.st[i] === 2 || C.st[i] === 3)) continue; if (k++ % stride) continue;
      const hb = B[C.home[i]], wb = B[C.work[i]]; if (!hb || !wb || hb === wb) continue;
      const ax = nearest(L.vAve, hb[2]), az = nearest(L.hAve, wb[3]);
      const p = [ax, hb[3], ax, az, wb[2], az];
      const len = Math.abs(az - hb[3]) + Math.abs(wb[2] - ax); if (len < 60) continue;
      out.push({ p, len, seed: hash(i) });
    }
    return out;
  }, [city?.version, L]);
  useEffect(() => { const m = ref.current; if (!m) return; routes.forEach((_, i) => m.setColorAt(i, tmpC.set(pick(CAR, i)))); m.count = routes.length; if (m.instanceColor) m.instanceColor.needsUpdate = true; }, [routes]);
  useFrame((_, dt) => {
    const s = useStore.getState(), m = ref.current; if (!m || !routes.length) return;
    if (s.status?.running && !s.status?.busy) clock.current += Math.min(dt, 0.1) * Math.min(2.5, 0.5 + (s.status.speed || 1) * 0.15);
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i], p = r.p; let t = (clock.current * 0.04 + r.seed) % 2; const back = t > 1; if (back) t = 2 - t;
      let d = t * r.len; const l1 = Math.abs(p[3] - p[1]);
      let x: number, z: number, dx: number, dz: number;
      if (d < l1) { const sg = Math.sign(p[3] - p[1]) || 1; x = p[0]; z = p[1] + sg * d; dx = 0; dz = sg; } else { d -= l1; const sg = Math.sign(p[4] - p[2]) || 1; x = p[2] + sg * d; z = p[3]; dx = sg; dz = 0; }
      if (back) { dx = -dx; dz = -dz; }
      x += dz * -5; z += dx * 5; // keep right
      tmpQ.setFromAxisAngle(UP, Math.atan2(dx, dz));
      tmpM.compose(tmpP.set(x, 2.2, z), tmpQ, tmpS.set(1, 1, 1)); m.setMatrixAt(i, tmpM);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  return (<instancedMesh ref={ref} args={[undefined, undefined, MAXCAR]} frustumCulled={false} raycast={() => null}>
    <boxGeometry args={[3.4, 2.6, 7.5]} /><meshStandardMaterial roughness={0.4} metalness={0.5} emissive="#ffe8b0" emissiveIntensity={night ? 0.35 : 0} />
  </instancedMesh>);
}

function Markers() {
  const city = useStore((s) => s.city), st = useStore((s) => s.cityStatic);
  const g = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => { if (g.current) g.current.children.forEach((c, i) => { const k = 1 + ((clock.elapsedTime * 0.6 + i * 0.3) % 1) * 0.5; c.scale.set(k, k, 1); }); });
  if (!city || !st) return null;
  const pop = city.districts.reduce((n: number, d: any) => n + d.pop, 0), protest = city.districts.reduce((n: number, d: any) => n + d.protest, 0), civic = st.districts[city.civic];
  return (<group ref={g}>
    {protest > Math.max(60, pop * 0.02) && <mesh rotation-x={-Math.PI / 2} position={[civic.x, 1.2, civic.z]}><ringGeometry args={[90, 100, 48]} /><meshBasicMaterial color="#e879f9" transparent opacity={0.8} /></mesh>}
    {city.districts.filter((d: any) => d.infected > Math.max(4, d.pop * 0.02)).map((d: any) => { const s = st.districts[d.id]; return (<mesh key={d.id} rotation-x={-Math.PI / 2} position={[s.x, 1.1, s.z]}><ringGeometry args={[140, 150, 48]} /><meshBasicMaterial color="#ef4444" transparent opacity={0.75} /></mesh>); })}
  </group>);
}

function CameraRig({ L }: { L: Layout }) {
  const focus = useStore((s) => s.focus); const controls = useRef<any>(null); const goal = useRef<THREE.Vector3 | null>(null);
  const { camera } = useThree();
  useEffect(() => { camera.position.set(L.cx, L.W * 0.62, L.cz + L.W * 0.82); if (controls.current) { controls.current.target.set(L.cx, 0, L.cz); controls.current.update(); } }, [L]);
  useEffect(() => { if (focus) goal.current = new THREE.Vector3(focus.x, 0, focus.z); }, [focus]);
  useFrame(() => { const c = controls.current; if (!c || !goal.current) return; const d = goal.current.clone().sub(c.target); if (d.length() < 2) { goal.current = null; return; } d.multiplyScalar(0.08); c.target.add(d); camera.position.add(d); if (camera.position.y > 620) camera.position.y += (520 - camera.position.y) * 0.05; c.update(); });
  return <MapControls ref={controls} makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI / 2.15} minDistance={50} maxDistance={L.W * 2.4} screenSpacePanning={false} />;
}

function Scene() {
  const L = useLayout(), night = useStore((s) => s.night);
  const bg = night ? '#070b14' : '#9db8d3';
  if (!L) return null;
  return (<>
    <color attach="background" args={[bg]} />
    <fog attach="fog" args={[bg, L.W * 1.1, L.W * 3.6]} />
    <ambientLight intensity={night ? 0.5 : 0.7} color={night ? '#8ea6ff' : '#ffffff'} />
    <hemisphereLight args={[night ? '#3a4a7a' : '#cfe3ff', night ? '#0a0c12' : '#5b5546', night ? 0.35 : 0.65]} />
    <directionalLight position={[L.W * 0.4, L.W * 0.8, L.W * 0.25]} intensity={night ? 0.25 : 1.7} color={night ? '#a9bbff' : '#fff1d8'} />
    <mesh rotation-x={-Math.PI / 2} position={[L.cx, -1, L.cz]}><planeGeometry args={[L.W * 8, L.W * 8]} /><meshStandardMaterial color={night ? '#0b0f14' : '#55634c'} roughness={1} /></mesh>
    <Ground L={L} /><Trees L={L} /><Buildings L={L} /><Traffic L={L} /><Citizens L={L} /><Markers /><CameraRig L={L} />
  </>);
}

export default function City() {
  const select = useStore((s) => s.select);
  return (
    <Canvas camera={{ position: [0, 1400, 1850], fov: 42, near: 5, far: 20000 }} dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: 'high-performance' }} onPointerMissed={() => select(null)}>
      <Scene />
    </Canvas>
  );
}
