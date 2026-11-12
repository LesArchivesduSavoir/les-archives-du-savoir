/**
 * Graphe de révisions immuables d'un même carnet.
 * Ce module ne fait aucun appel réseau : l'appelant ne doit publier ni supprimer
 * de révision sur la seule base d'une liste distante potentiellement incomplète.
 */
export function inspectRevisions(revisions) {
  if (!Array.isArray(revisions)) throw new TypeError('Liste de révisions invalide.');
  const byId = new Map();
  for (const revision of revisions) {
    if (!revision || typeof revision.id !== 'string' || !revision.id.trim() || !Array.isArray(revision.parents)) {
      throw new TypeError('Révision invalide.');
    }
    if (byId.has(revision.id)) throw new Error('Identifiant de révision dupliqué.');
    if (revision.parents.some(parent => typeof parent !== 'string' || !parent.trim())) throw new TypeError('Référence parent invalide.');
    if (new Set(revision.parents).size !== revision.parents.length) throw new Error('Parent dupliqué.');
    byId.set(revision.id, revision);
  }
  const missing = new Set();
  const hasChildren = new Set();
  for (const revision of revisions) {
    for (const parent of revision.parents) {
      if (!byId.has(parent)) missing.add(parent);
      else hasChildren.add(parent);
    }
  }
  // Kahn : détecte également une boucle fermée sans aucune tête.
  const indegree = new Map(revisions.map(r => [r.id, 0]));
  const children = new Map(revisions.map(r => [r.id, []]));
  for (const r of revisions) for (const parent of r.parents) if (byId.has(parent)) {
    indegree.set(r.id, indegree.get(r.id) + 1); children.get(parent).push(r.id);
  }
  const queue = revisions.filter(r => indegree.get(r.id) === 0).map(r => r.id);
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    visited++;
    for (const child of children.get(queue[i])) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  if (visited !== revisions.length) throw new Error('Cycle dans les révisions.');
  const heads = revisions.filter(r => !hasChildren.has(r.id)).map(r => r.id).sort();
  return {heads, missingParents: [...missing].sort(), incomplete: missing.size > 0, conflict: missing.size === 0 && heads.length > 1};
}
