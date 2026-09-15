// Which roads a vehicle class cannot drive onto at all, because TD's own
// PROHIBITION rows (and turn bans) close every way in — e.g. public light
// buses and Laguna City: two "PLB Proh" routes seal Sin Fat Road and the
// Laguna stubs, though no row names those roads. Derived, but only from TD's
// published bans on TD's published network — never from sign points.
//
// The graph is CENTERLINE itself. Edges carry no node ids, but their endpoints
// coincide exactly at junctions (0.5 / 1 / 3 m snapping gives the same graph;
// 11 of 3,807 dead ends lie within 2 m of another edge), so nodes are endpoints
// rounded to the metre. Search runs over directed edge STATES (edge × way of
// travel) rather than nodes, because a turn ban forbids a movement from one
// edge onto the next, which a node graph cannot express.
//
// A ban closes a road for the class when it addresses the class and carries no
// condition that lets some of it through: not timed, not size/weight-limited,
// not every-day-only, and not exempting the class itself. A PERMIT or ACCESS
// exemption ("E WP", "E FA") still closes it — nearly every rule has one, so
// counting them would close nothing. A ban's BOUND picks the way of travel it
// covers (1 = digitised direction, −1 = reverse, 0 = both; drive-on-the-left):
// read that way it seals areas as treating the ban two-sided does, while the
// flipped reading barely beats dropping one-sided bans, so it blocks the way IN.
//
// Cut off = an edge enterable from the main network once only the class's
// turn bans apply, but not once its prohibitions apply too (so an area every
// vehicle is turned away from is not blamed on the class), minus the banned
// routes themselves, which the prohibition layer already draws.

const TIMED = /\d{4}|\d{1,2}(:\d\d)?\s*[ap]\.?m\b/i
const SIZED = /\bover\b|tonne|\d(\.\d+)?\s*m\b/i
const tokens = s => (s ?? '').toUpperCase().split(/[^A-Z]+/).filter(Boolean)

// `row` is a PROHIBITION or TURN record (the two share INC/EXC/REMARKS; the
// part-time and size fields are named differently). `addresses(row)` says
// whether the row speaks to the class at all; `exempt` is the set of vehicle
// codes / remark words that let the class through.
export function closesFor(row, addresses, exempt) {
  if (!addresses(row)) return false
  const remarks = row.REMARKS ?? ''
  const exceptions = [...tokens(row.EXC_VEH_TYPE), ...tokens(remarks.split('/').slice(1).join(' '))]
  if (exceptions.some(t => exempt.has(t))) return false
  if ((row.PART_TIME_PROHIBITION ?? row.PART_TIME_REST) === 'Y' || row.EFF_ALL_DAYS === 'N') return false
  const size = row.OTHER_REST_TYPE ?? row.OTHER_REST_TYPE_GV
  if (size && size !== 'NA' && tokens(size).some(t => t !== 'NA')) return false
  return !TIMED.test(remarks) && !SIZED.test(remarks)
}

const nodeKey = (x, y) => `${Math.round(x)},${Math.round(y)}`

// Largest strongly connected component of a directed graph over 0..n-1, by
// iterative Tarjan (a recursive one overflows on a 70k-state road network).
function largestScc(n, successors) {
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const stack = []
  let next = 0
  let best = []
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    const work = [[root, successors(root), 0]]
    index[root] = low[root] = next++
    stack.push(root)
    onStack[root] = 1
    while (work.length) {
      const frame = work[work.length - 1]
      const [v, succ] = frame
      if (frame[2] < succ.length) {
        const w = succ[frame[2]++]
        if (index[w] === -1) {
          index[w] = low[w] = next++
          stack.push(w)
          onStack[w] = 1
          work.push([w, successors(w), 0])
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w])
        }
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        low[parent] = Math.min(low[parent], low[v])
      }
      if (low[v] === index[v]) {
        const comp = []
        let w
        do {
          w = stack.pop()
          onStack[w] = 0
          comp.push(w)
        } while (w !== v)
        if (comp.length > best.length) best = comp
      }
    }
  }
  return best
}

// edges:        [{ fid, routeId, dir, sx, sy, ex, ey, len }] (HK1980 metres;
//               dir = TRAVEL_DIRECTION, 3 one-way digitised, 1 both)
// prohibitions: PROHIBITION rows (ROAD_ROUTE_ID, BOUND + the closesFor fields)
// turns:        TURN rows (EDGE1END, EDGE1FID, EDGE2FID, EDGE3FID + closesFor fields)
// closes:       row → does this ban close the road for the class
// → { groups: [{ edges: [edge], lenM, entryRouteIds }], stats }
export function computeCutoff({ edges, prohibitions, turns, closes }) {
  const n = edges.length
  const byFid = new Map(edges.map((e, i) => [e.fid, i]))
  const byRoute = new Map(edges.map((e, i) => [e.routeId, i]))
  const a = edges.map(e => nodeKey(e.sx, e.sy))
  const b = edges.map(e => nodeKey(e.ex, e.ey))

  // State s = 2·edge + (0 digitised | 1 reverse). Tail/head are the nodes it
  // leaves from and arrives at.
  const edgeOf = s => s >> 1
  const tail = s => (s & 1 ? b : a)[edgeOf(s)]
  const head = s => (s & 1 ? a : b)[edgeOf(s)]
  const leaving = new Map()
  for (let i = 0; i < n; i++) {
    const add = (node, s) => leaving.has(node) ? leaving.get(node).push(s) : leaving.set(node, [s])
    add(a[i], 2 * i)
    if (edges[i].dir === 1) add(b[i], 2 * i + 1)
  }

  const bannedTurns = new Set()
  let turnsSkipped = 0
  for (const t of turns) {
    if (!closes(t)) continue
    const e1 = byFid.get(t.EDGE1FID)
    const e2 = byFid.get(t.EDGE2FID)
    // Multi-edge turns (48 territory-wide) are skipped, as are turns whose
    // junction lies inside a multi-part edge (EDGE1POS, ~300): an unapplied
    // ban can only miss a closure, never invent one.
    if (e1 == null || e2 == null || (t.EDGE3FID && t.EDGE3FID !== 0)) {
      turnsSkipped++
      continue
    }
    const from = 2 * e1 + (t.EDGE1END === 'Y' ? 0 : 1)
    const junction = head(from)
    const onto = [2 * e2, 2 * e2 + 1].filter(s => tail(s) === junction)
    if (!onto.length) {
      turnsSkipped++
      continue
    }
    for (const s of onto) bannedTurns.add(from * 2 * n + s)
  }

  const closedRoutes = new Set()
  const closedStates = new Set()
  for (const p of prohibitions) {
    const i = byRoute.get(p.ROAD_ROUTE_ID)
    if (i == null || !closes(p)) continue
    closedRoutes.add(p.ROAD_ROUTE_ID)
    const bound = p.BOUND ?? 0
    if (bound !== -1) closedStates.add(2 * i)
    if (bound !== 1) closedStates.add(2 * i + 1)
  }

  const successorsWith = blocked => (s) => {
    const out = []
    for (const t of leaving.get(head(s)) ?? []) {
      if (!blocked.has(t) && !bannedTurns.has(s * 2 * n + t)) out.push(t)
    }
    return out
  }
  const enterable = (blocked) => {
    const succ = successorsWith(blocked)
    // States that can't exist (the reverse of a one-way edge) or are closed
    // are isolated here, so they never form the largest component.
    const seeds = largestScc(2 * n, s => (s & 1 && edges[edgeOf(s)].dir !== 1) || blocked.has(s) ? [] : succ(s))
    const seen = new Uint8Array(2 * n)
    const reached = new Uint8Array(n)
    const queue = [...seeds]
    for (const s of seeds) seen[s] = 1
    while (queue.length) {
      const s = queue.pop()
      reached[edgeOf(s)] = 1
      for (const t of succ(s)) {
        if (!seen[t]) {
          seen[t] = 1
          queue.push(t)
        }
      }
    }
    return reached
  }

  const base = enterable(new Set())
  const banned = enterable(closedStates)
  const cut = []
  for (let i = 0; i < n; i++) {
    if (base[i] && !banned[i] && !closedRoutes.has(edges[i].routeId)) cut.push(i)
  }

  // Areas: cut edges joined through shared nodes, each with the closed routes
  // that touch it — the bans a popup names as sealing it.
  const cutAt = new Map()
  for (const i of cut) {
    for (const node of [a[i], b[i]]) cutAt.has(node) ? cutAt.get(node).push(i) : cutAt.set(node, [i])
  }
  const closedAt = new Map()
  for (const id of closedRoutes) {
    const i = byRoute.get(id)
    for (const node of [a[i], b[i]]) closedAt.has(node) ? closedAt.get(node).add(id) : closedAt.set(node, new Set([id]))
  }
  const done = new Set()
  const groups = []
  for (const start of cut) {
    if (done.has(start)) continue
    const members = []
    const entry = new Set()
    const queue = [start]
    done.add(start)
    while (queue.length) {
      const i = queue.pop()
      members.push(edges[i])
      for (const node of [a[i], b[i]]) {
        for (const id of closedAt.get(node) ?? []) entry.add(id)
        for (const j of cutAt.get(node)) {
          if (!done.has(j)) {
            done.add(j)
            queue.push(j)
          }
        }
      }
    }
    groups.push({ edges: members, lenM: Math.round(members.reduce((s, e) => s + e.len, 0)), entryRouteIds: [...entry] })
  }
  groups.sort((x, y) => y.lenM - x.lenM)

  return {
    groups,
    stats: { closedRoutes: closedRoutes.size, bannedTurns: bannedTurns.size, turnsSkipped, cutEdges: cut.length }
  }
}
