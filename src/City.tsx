// 3D World Renderer. Everything drawn here comes from the simulation state:
// buildings (height = real occupancy/headcount, grey = vacant), 5,000+ instanced citizens
// travelling between their real home and real workplace/school, district overlays from live data.
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { MapControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from './store';

const KIND_COLOR = ['#8a93a6', '#d9a55b', '#6f9bd8', '#a0795c', '#b58be0', '#e0c46a', '#ec8f8f', '#63d6c3', '#d7dbe6', '#7c8a99'];
const ST_COLOR = ['#7dd3fc', '#facc15', '#4ade80', '#22d3ee', '#fb923c', '#a1a1aa', '#94a3b8', '#ef4444', '#e879f9'];
const TIER_COLOR = ['#fb923c', '#60a5fa', '#a78bfa', '#fde047'];
const DIST_COLOR: Record<string, string> = { residential: '#1d2a38', commercial: '#33291c', business: '#1c2740', industrial: '#2c2622', university: '#2a2140', medical: '#3a2026', research: '#17332f', government: '#2d303a', park: '#17351f' };
const MAXB = 2000, MAXC = 12000;
const tmpM = new THREE.Matrix4(), tmpC = new THREE.Color(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
const hash = (i: number) => { let x = Math.imul(i + 1, 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };
const ramp = (t: number) => tmpC.setHSL(0.36 - 0.36 * Math.min(1, Math.max(0, t)), 0.6, 0.2 + 0.12 * t);

function Districts() {
  const st = useStore((s) => s.cityStatic), city = useStore((s) => s.city), overlay = useStore((s) => s.overlay), select = useStore((s) => s.select);
  const labels = useMemo(() => (st?.districts || []).map((d: any) => { const c = document.createElement('canvas'); c.width = 512; c.height = 64; const g = c.getContext('2d')!; g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = 'rgba(230,238,255,0.92)'; g.fillText(d.name.toUpperCase(), 256, 44); const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t; }), [st]);
  if (!st) return null;
  return (<group>
    {st.districts.map((d: any, i: number) => {
      const dd = city?.districts?.[i]; let color = DIST_COLOR[d.kind];
      if (dd && overlay !== 'none') { const v = overlay === 'unemployment' ? dd.unemp / 0.25 : overlay === 'crime' ? dd.crime / 0.6 : overlay === 'rent' ? (dd.rent - 0.6) / 1.6 : overlay === 'income' ? 1 - dd.income / 7000 : overlay === 'infection' ? dd.infected / Math.max(1, dd.pop) / 0.15 : overlay === 'happiness' ? 1 - (dd.happy - 0.3) / 0.6 : dd.pop / 900; color = '#' + ramp(dd.pop > 0 || overlay === 'rent' ? v : 0).getHexString(); }
      return (<group key={d.id}>
        <mesh rotation-x={-Math.PI / 2} position={[d.x, 0.2, d.z]} onDoubleClick={(e) => { e.stopPropagation(); select(`district:${d.id}`, false); }}><planeGeometry args={[d.w, d.d]} /><meshStandardMaterial color={color} roughness={0.95} /></mesh>
        <sprite position={[d.x, 6, d.z + d.d / 2 + 12]} scale={[150, 19, 1]}><spriteMaterial map={labels[i]} transparent depthWrite={false} opacity={0.85} /></sprite>
        {d.kind === 'park' && Array.from({ length: 46 }, (_, k) => (<mesh key={k} position={[d.x + (hash(k * 7 + 1) - 0.5) * 250, 7, d.z + (hash(k * 13 + 5) - 0.5) * 250]}><coneGeometry args={[6 + hash(k) * 4, 16 + hash(k + 99) * 10, 6]} /><meshStandardMaterial color="#2f7d46" /></mesh>))}
        {dd && dd.protest > 12 && d.kind === 'residential' ? null : null}
      </group>);
    })}
  </group>);
}

function Buildings() {
  const city = useStore((s) => s.city), select = useStore((s) => s.select), selected = useStore((s) => s.selected), tick = useStore((s) => s.status?.tick ?? 0);
  const ref = useRef<THREE.InstancedMesh>(null!);
  useEffect(() => {
    const m = ref.current; if (!m || !city) return;
    const B = city.buildings; m.count = Math.min(B.length, MAXB);
    for (let i = 0; i < m.count; i++) {
      const b = B[i], h = b[8] === 2 ? Math.max(4, b[6] * 0.35) : b[6];
      tmpM.compose(tmpP.set(b[2], h / 2, b[3]), tmpQ.identity(), tmpS.set(b[4], h, b[5])); m.setMatrixAt(i, tmpM);
      if (b[8] === 1) tmpC.set('#2b2e36'); else if (b[8] === 2) tmpC.set('#c98b2b'); else { tmpC.set(KIND_COLOR[b[7]]); if (b[7] === 0) tmpC.offsetHSL(0, 0, (hash(i) - 0.5) * 0.12); if (city.tick - b[12] < 120 && b[12] > 0) tmpC.lerp(new THREE.Color('#ffffff'), 0.45); }
      m.setColorAt(i, tmpC);
    }
    m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere();
  }, [city]);
  const sel = selected?.startsWith('building:') && city ? city.buildings[Number(selected.split(':')[1])] : null;
  void tick;
  return (<>
    <instancedMesh ref={ref} args={[undefined, undefined, MAXB]} frustumCulled={false} onClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) select(`building:${e.instanceId}`, false); }}>
      <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial roughness={0.55} metalness={0.15} />
    </instancedMesh>
    {sel && <mesh position={[sel[2], sel[6] / 2, sel[3]]}><boxGeometry args={[sel[4] + 3, sel[6] + 3, sel[5] + 3]} /><meshBasicMaterial color="#56e0c2" wireframe /></mesh>}
  </>);
}

function Citizens() {
  const select = useStore((s) => s.select);
  const ref = useRef<THREE.InstancedMesh>(null!), marker = useRef<THREE.Mesh>(null!), clock = useRef(0), colorKey = useRef('');
  const { camera } = useThree();
  useFrame((_, dt) => {
    const s = useStore.getState(), city = s.city, st = s.cityStatic, m = ref.current; if (!city || !st || !m) return;
    const running = s.status?.running && !s.status?.busy;
    if (running) clock.current += Math.min(dt, 0.1) * Math.min(3, 0.6 + (s.status.speed || 1) * 0.2);
    const T = clock.current / 26, C = city.citizens, B = city.buildings, n = Math.min(C.st.length, MAXC);
    const civic = st.districts[city.civic], park = st.districts.find((d: any) => d.kind === 'park');
    const scale = Math.min(3.2, Math.max(1, camera.position.y / 420));
    const selId = s.selected?.startsWith('citizen:') ? Number(s.selected.split(':')[1]) : -1;
    const key = `${city.version}|${s.colorBy}|${n}`, recolor = key !== colorKey.current; colorKey.current = key;
    m.count = n; let sx = 0, sz = 0, sv = false;
    for (let i = 0; i < n; i++) {
      const code = C.st[i], hb = B[C.home[i]];
      if (code === 255) { tmpM.makeScale(0, 0, 0); m.setMatrixAt(i, tmpM); continue; }
      const r1 = hash(i), r2 = hash(i + 7777);
      let hx: number, hz: number;
      if (hb) { hx = hb[2] + (r1 - 0.5) * (hb[4] + 8); hz = hb[3] + hb[5] / 2 + 3 + r2 * 5; } else { hx = park.x + (r1 - 0.5) * 240; hz = park.z + (r2 - 0.5) * 240; }
      let wx = hx, wz = hz; const wb = B[C.work[i]];
      if (code === 8) { wx = civic.x + (r1 - 0.5) * 130; wz = civic.z + (r2 - 0.5) * 130; }
      else if (code === 7) { wx = hx; wz = hz; }
      else if (wb) { wx = wb[2] + (r2 - 0.5) * (wb[4] + 8); wz = wb[3] + wb[5] / 2 + 3 + r1 * 5; }
      else if (code !== 0 || r1 > 0.5) { const dd = st.districts[hb ? hb[1] : 0]; wx = dd.x + (r2 - 0.5) * 280; wz = dd.z + (r1 - 0.5) * 280; if (r1 < 0.25) { wx = park.x + (r2 - 0.5) * 250; wz = park.z + (r1 - 0.5) * 250; } }
      const ph = (T + r1 * 0.37 + r2 * 0.63) % 1;
      const f = code === 8 ? 1 : ph < 0.16 ? ph / 0.16 : ph < 0.5 ? 1 : ph < 0.66 ? 1 - (ph - 0.5) / 0.16 : 0;
      // L-shaped street route: along x on the home street, then along z
      const total = Math.abs(wx - hx) + Math.abs(wz - hz) || 1, d = f * total, ax = Math.abs(wx - hx);
      const x = d < ax ? hx + Math.sign(wx - hx) * d : wx, z = d < ax ? hz : hz + Math.sign(wz - hz) * (d - ax);
      const jig = f === 1 || f === 0 ? Math.sin(clock.current * 0.8 + i) * 1.2 : 0;
      tmpM.compose(tmpP.set(x + jig, 2.2 * scale, z), tmpQ.identity(), tmpS.set(scale, scale, scale)); m.setMatrixAt(i, tmpM);
      if (i === selId) { sx = x; sz = z; sv = true; }
      if (recolor) { m.setColorAt(i, tmpC.set(s.colorBy === 'wealth' ? TIER_COLOR[C.tier[i]] : ST_COLOR[code] || '#ffffff')); }
    }
    m.instanceMatrix.needsUpdate = true; if (recolor && m.instanceColor) m.instanceColor.needsUpdate = true;
    if (marker.current) { marker.current.visible = sv; if (sv) { marker.current.position.set(sx, 14 * scale + Math.sin(clock.current * 3) * 2, sz); marker.current.scale.setScalar(scale); } }
  });
  return (<>
    <instancedMesh ref={ref} args={[undefined, undefined, MAXC]} frustumCulled={false} onClick={(e) => { e.stopPropagation(); if (e.instanceId !== undefined) select(`citizen:${e.instanceId}`, false); }}>
      <sphereGeometry args={[1.5, 6, 5]} /><meshBasicMaterial toneMapped={false} />
    </instancedMesh>
    <mesh ref={marker} visible={false} rotation-x={Math.PI}><coneGeometry args={[4, 10, 4]} /><meshBasicMaterial color="#56e0c2" /></mesh>
  </>);
}

function Markers() {
  const city = useStore((s) => s.city), st = useStore((s) => s.cityStatic);
  const g = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => { if (g.current) g.current.children.forEach((c, i) => { const k = 1 + ((clock.elapsedTime * 0.6 + i * 0.3) % 1) * 0.5; c.scale.set(k, k, 1); }); });
  if (!city || !st) return null;
  const protest = city.districts.reduce((n: number, d: any) => n + d.protest, 0), civic = st.districts[city.civic];
  return (<group ref={g}>
    {protest > Math.max(60, city.districts.reduce((n: number, d: any) => n + d.pop, 0) * 0.02) && <mesh rotation-x={-Math.PI / 2} position={[civic.x, 1.2, civic.z]}><ringGeometry args={[90, 100, 48]} /><meshBasicMaterial color="#e879f9" transparent opacity={0.8} /></mesh>}
    {city.districts.filter((d: any) => d.infected > Math.max(4, d.pop * 0.02)).map((d: any) => { const s = st.districts[d.id]; return (<mesh key={d.id} rotation-x={-Math.PI / 2} position={[s.x, 1.1, s.z]}><ringGeometry args={[140, 150, 48]} /><meshBasicMaterial color="#ef4444" transparent opacity={0.75} /></mesh>); })}
  </group>);
}

function CameraRig() {
  const focus = useStore((s) => s.focus); const controls = useRef<any>(null); const goal = useRef<THREE.Vector3 | null>(null);
  const { camera } = useThree();
  useEffect(() => { if (focus) goal.current = new THREE.Vector3(focus.x, 0, focus.z); }, [focus]);
  useFrame(() => { const c = controls.current; if (!c || !goal.current) return; const d = goal.current.clone().sub(c.target); if (d.length() < 2) { goal.current = null; return; } d.multiplyScalar(0.08); c.target.add(d); camera.position.add(d); if (camera.position.y > 520) camera.position.y += (460 - camera.position.y) * 0.05; c.update(); });
  return <MapControls ref={controls} makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI / 2.15} minDistance={60} maxDistance={3200} screenSpacePanning={false} />;
}

export default function City() {
  const select = useStore((s) => s.select);
  return (
    <Canvas camera={{ position: [0, 980, 1250], fov: 42, near: 5, far: 9000 }} dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: 'high-performance' }} onPointerMissed={() => select(null)}>
      <color attach="background" args={['#070b12']} />
      <fog attach="fog" args={['#070b12', 2200, 5200]} />
      <ambientLight intensity={0.75} /><hemisphereLight args={['#9fc5ff', '#10141c', 0.6]} />
      <directionalLight position={[600, 1200, 400]} intensity={1.5} color="#ffe9c9" />
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.5, 0]}><planeGeometry args={[9000, 9000]} /><meshStandardMaterial color="#0b111a" roughness={1} /></mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, 0]}><planeGeometry args={[1860, 1500]} /><meshStandardMaterial color="#232a36" roughness={0.9} /></mesh>
      <Districts /><Buildings /><Citizens /><Markers /><CameraRig />
    </Canvas>
  );
}
