export function validMapCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function currentPosition(drone, now = Date.now()) {
  const p = drone?.position;
  return p && validMapCoordinates(p.lat, p.lon) && !(p.lat === 0 && p.lon === 0)
    && Number.isFinite(p.at) && now - p.at >= 0 && now - p.at <= 10000 ? p : null;
}

export function positionLabel(drone, now = Date.now()) {
  if (!drone) return '等待连接飞控';
  if (currentPosition(drone, now)) return drone.position.source === 'gps' ? 'GPS 已定位' : '飞控已提供全局位置';
  if (drone.position) return '位置数据已过期，等待更新';
  return ({ no_gps_data: '未收到 GPS / 全局位置数据', waiting_gps: 'GPS 未定位，等待搜星',
    invalid_coordinates: '等待有效经纬度', stale: '位置数据已过期，等待更新' })[drone.positionStatus]
    || '等待飞控定位';
}

export function gpsFixLabel(gps) {
  if (!gps) return '未收到 GPS 数据';
  return ({ 0: '未检测到 GPS', 1: '未定位', 2: '2D 定位', 3: '3D 定位',
    4: '差分定位', 5: 'RTK 浮点', 6: 'RTK 固定', 7: '静态定位', 8: 'PPP 定位' })[gps.fixType] || '未知';
}
