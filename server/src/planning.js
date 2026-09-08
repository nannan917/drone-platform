export function coordinate(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}
function bad(message) { throw Object.assign(new Error(message), { status: 400 }); }
export function geometry(input) {
  const g = input?.type === 'Feature' ? input.geometry : input;
  if (g?.type !== 'Polygon' || !Array.isArray(g.coordinates) || g.coordinates.length !== 1) bad('围栏需为单环 GeoJSON Polygon');
  const ring = g.coordinates[0];
  if (ring.length < 4 || ring.length > 1000 || !ring.every(coordinate) || JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) bad('多边形需至少三个顶点并闭合，坐标顺序为经度、纬度');
  return g;
}
export function pointsFor(route) {
  const { mode = 'waypoints', points, center, radius = 100, spacing = 50 } = route;
  if (mode === 'waypoints') {
    if (!Array.isArray(points) || points.length < 2 || points.length > 1000 || !points.every(coordinate)) bad('航点需为 2–1000 个 [经度,纬度] 坐标');
    return points;
  }
  if (mode === 'orbit') {
    if (!coordinate(center) || radius < 10 || radius > 10000 || Math.abs(center[1]) > 80) bad('环绕中心或半径无效');
    return Array.from({ length: 37 }, (_, i) => {
      const angle = i * Math.PI / 18;
      return [center[0] + Math.cos(angle) * radius / (111320 * Math.cos(center[1] * Math.PI / 180)), center[1] + Math.sin(angle) * radius / 111320];
    });
  }
  if (mode === 'grid') {
    if (!Array.isArray(points) || points.length !== 2 || !points.every(coordinate) || spacing < 10 || spacing > 1000) bad('区域扫描需矩形两个对角坐标及 10–1000 米间距');
    const [west, east] = [Math.min(points[0][0], points[1][0]), Math.max(points[0][0], points[1][0])];
    const [south, north] = [Math.min(points[0][1], points[1][1]), Math.max(points[0][1], points[1][1])];
    const rows = Math.ceil((north - south) * 111320 / spacing);
    if (!rows || west === east || rows > 400) bad('扫描区域无效或过大');
    return Array.from({ length: rows + 1 }, (_, i) => {
      const y = south + (north - south) * i / rows;
      return i % 2 ? [[east, y], [west, y]] : [[west, y], [east, y]];
    }).flat();
  }
  bad('未知航线模式');
}
function cross(a, b, c) { return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]); }
function on(a, b, p) { return Math.abs(cross(a,b,p)) < 1e-10 && p[0] >= Math.min(a[0],b[0])-1e-10 && p[0] <= Math.max(a[0],b[0])+1e-10 && p[1] >= Math.min(a[1],b[1])-1e-10 && p[1] <= Math.max(a[1],b[1])+1e-10; }
function intersects(a,b,c,d) { return on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)||((cross(a,b,c)>0)!==(cross(a,b,d)>0)&&(cross(c,d,a)>0)!==(cross(c,d,b)>0)); }
export function inside(p, ring) {
  let result = false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[j], b=ring[i];
    if (on(a,b,p)) return true;
    if ((a[1]>p[1])!==(b[1]>p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) result=!result;
  }
  return result;
}
export function checkRoute(route, fences) {
  const points = route.generatedPoints || pointsFor(route), violations = [];
  for (const fence of fences.filter((f) => !f.archived && f.enabled !== false)) {
    const ring = geometry(fence.geometry).coordinates[0];
    const touches = points.some((p)=>inside(p,ring)) || points.slice(1).some((p,i)=>ring.slice(1).some((q,j)=>intersects(points[i],p,ring[j],q)));
    if (touches && (fence.kind === '禁飞区' || route.altitude > fence.ceiling)) violations.push({ id:fence.id, name:fence.name, reason:fence.kind === '禁飞区' ? '穿越禁飞区' : '超过限飞高度' });
  }
  return { passed:violations.length===0, violations, checkedAt:new Date().toISOString(), note:'仅校验平台已录入围栏，不替代正式空域许可或飞控避障。' };
}
