/* 開発用：水中のカメラの視線が湖底に当たる距離を CPU で調べる（湖底の抜けの切り分け） */
export default async function (h) {
  await h.open(`lab/underwater+weatherfx.html?capture=1&tier=high${process.env.QUERY || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const r = await h.eval(() => {
    const L = window.__lab, T = L.gfx.THREE;
    const D = L.dock;
    const len = Math.hypot(D.dockEnd.x - D.dockStart.x, D.dockEnd.z - D.dockStart.z);
    const x = D.dockEnd.x + D.dockDir.x * -0.45 * len + D.dockDir.z * 2.6, z = D.dockEnd.z + D.dockDir.z * -0.45 * len - D.dockDir.x * 2.6;
    const dep = L.lake.depthAt(x, z);
    const hh = 12.5, a = ((hh - 6) / 24) * Math.PI * 2;
    const d = [Math.cos(a), Math.sin(a), 0.34];
    const az = Math.atan2(d[2], d[0]) - 100 * Math.PI / 180;
    const pos = [x, -Math.min(1.6, dep * 0.5), z];
    const pr = 5 * Math.PI / 180;
    L.cam({ pos, target: [pos[0] + Math.cos(az) * Math.cos(pr) * 30, pos[1] + Math.sin(pr) * 30, pos[2] + Math.sin(az) * Math.cos(pr) * 30] });
    L.tick(3);
    const cam = L.camera;
    const out = { far: cam.far, near: cam.near, dep, pos };
    for (const [nx, ny] of [[0.6, -0.3], [0.6, -0.6], [-0.6, -0.6]]) {
      const v = new T.Vector3(nx, ny, 0.5).unproject(cam).sub(cam.position).normalize();
      let hit = null;
      for (let s = 0.5; s < 400; s += 0.25) {
        const px = cam.position.x + v.x * s, py = cam.position.y + v.y * s, pz = cam.position.z + v.z * s;
        if (py < L.lake.heightAt(px, pz)) { hit = [s, +px.toFixed(1), +pz.toFixed(1), +L.lake.heightAt(px, pz).toFixed(2)]; break; }
      }
      out[`${nx},${ny}`] = { dir: v.toArray().map((q) => +q.toFixed(3)), hit };
    }
    return out;
  });
  console.log(JSON.stringify(r));
  await h.shot('probe');
}
