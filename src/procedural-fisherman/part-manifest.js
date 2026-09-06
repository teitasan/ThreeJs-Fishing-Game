/**
 * Build a stable part manifest from the blockout factory runtime payload.
 * @param {import('three').Group} model
 */
export function buildPartManifest(model) {
  const runtime = model.userData?.sculptRuntime ?? {};
  const meshes = runtime.meshes ?? {};
  const nodes = runtime.nodes ?? {};
  const sockets = runtime.sockets ?? {};

  const parts = Object.entries(meshes).map(([id, mesh]) => ({
    id,
    name: mesh.name || id,
    uuid: mesh.uuid,
    materialId: mesh.userData?.sculptComponent?.material ?? null,
    componentId: mesh.userData?.sculptComponent?.id ?? id,
    parentId: mesh.userData?.sculptComponent?.parent ?? null,
    role: mesh.userData?.sculptComponent?.role ?? null,
    primitive: mesh.userData?.sculptComponent?.primitive ?? null,
    vertexCount: mesh.geometry?.attributes?.position?.count ?? 0,
  }));

  parts.sort((a, b) => a.id.localeCompare(b.id));

  const nodeList = Object.entries(nodes).map(([id, node]) => ({
    id,
    name: node.name || id,
    uuid: node.uuid,
  })).sort((a, b) => a.id.localeCompare(b.id));

  const socketList = Object.entries(sockets).map(([id, socket]) => ({
    id,
    name: socket.name || id,
    uuid: socket.uuid,
  })).sort((a, b) => a.id.localeCompare(b.id));

  return {
    modelName: model.name,
    passId: 'blockout',
    meshCount: parts.length,
    parts,
    nodes: nodeList,
    sockets: socketList,
    rigBound: Boolean(model.userData?.rig?.bound),
  };
}

/**
 * @param {import('three').Object3D} root
 * @returns {string[]}
 */
export function collectMeshNameIssues(root) {
  const issues = [];
  root.traverse((obj) => {
    if (obj.isMesh && (!obj.name || obj.name.endsWith('__pivot'))) {
      issues.push(`mesh missing stable name: uuid=${obj.uuid}`);
    }
  });
  return issues;
}
