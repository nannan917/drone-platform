// Keep REST responses, WebSocket removal events and reconnect snapshots consistent.
export function forgetDrone(state, history, id) {
  state.drones.delete(id);
  state.arp.delete(id);
  history.delete(id);
  if (state.selected === id) state.selected = null;
}

export function replaceSnapshot(state, history, snapshot, upsert) {
  const ids = new Set(snapshot.drones.map((d) => d.droneId));
  for (const id of state.drones.keys()) {
    if (!ids.has(id)) forgetDrone(state, history, id);
  }
  state.arp.clear();
  for (const d of snapshot.drones) upsert(d);
  for (const entry of snapshot.arp || []) state.arp.set(entry.droneId, entry);
}

export function applyPresence(state, history, event) {
  if (event.reason === 'remove' || event.reason === 'expire') {
    forgetDrone(state, history, event.droneId);
  } else {
    if (event.entry) state.arp.set(event.droneId, event.entry);
    const entry = state.arp.get(event.droneId);
    if (entry && event.state) entry.state = event.state;
    const drone = state.drones.get(event.droneId);
    if (drone && event.reason === 'offline') drone.online = false;
  }
}
