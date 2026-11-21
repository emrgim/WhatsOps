// A fake Rentman API for tests: projects, subprojects, function groups, functions, planning, crew,
// invitations, statuses; `modified[gt]`, `accepted`, `sort=-id`, `limit` + `next_page_url` cursors,
// `expand=location`. Token: "rtok". Mutations for tests: POST /__accept?pc=, /__plan?fn=&crew=&accepted=1,
// /__unplan?pc=, /__status?sub=&status=, /__time?pc=&start=&end=, /__project (new project), GET /__calls.
// Run alone: node test/mocks/rentman.mjs [port]
import http from 'node:http'

export function rentmanData() {
  const old = new Date(Date.now() - 400 * 86400_000).toISOString()
  const day = (d, h) => `2026-12-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+01:00`
  const D = {
    workspace: { name: 'acme', company_name: 'Acme Events', country_code: 'nl', timezone: 'Europe/Amsterdam' },
    statuses: [
      { id: 1, name: 'Concept' },
      { id: 2, name: 'Option' },
      { id: 3, name: 'Confirmed' },
      { id: 4, name: 'Cancelled' },
    ],
    crew: [
      { id: 33, displayname: 'Anna Planner', phone: '+39 333 123 4567', active: true },
      { id: 41, displayname: 'Mario Fonico', phone: '06 1111 2222', active: true },
      { id: 42, displayname: 'Luca Luci', phone: '+31 6 2222 3333', active: true },
      { id: 43, displayname: 'Sara Video', phone: '', active: true },
      { id: 44, displayname: 'Piet Audio', phone: '0031 6 4444 5555', active: true },
    ],
    contacts: [{ id: 9, displayname: 'Teatro Verdi' }],
    projects: [
      { id: 100, name: 'Jazz Festival', number: '2026-041', creator: '/crew/33', location: '/contacts/9', planperiod_start: day(12, 8), planperiod_end: day(14, 23), created: old },
      { id: 101, name: 'Corporate Gala', number: '2026-042', creator: '/crew/33', location: null, planperiod_start: day(18, 9), planperiod_end: day(19, 23), created: old },
      { id: 102, name: 'Product Launch', number: '2026-043', creator: '/crew/33', location: null, planperiod_start: day(20, 9), planperiod_end: day(20, 22), created: old },
    ],
    subprojects: [
      { id: 200, project: '/projects/100', name: 'Main', status: '/statuses/3', order: 1, planperiod_start: day(12, 8), planperiod_end: day(14, 23) },
      { id: 201, project: '/projects/101', name: 'Day 1', status: '/statuses/2', order: 1, planperiod_start: day(18, 9), planperiod_end: day(18, 23) },
      { id: 202, project: '/projects/101', name: 'Day 2', status: '/statuses/2', order: 2, planperiod_start: day(19, 9), planperiod_end: day(19, 23) },
      { id: 203, project: '/projects/102', name: 'Launch', status: '/statuses/2', order: 1, planperiod_start: day(20, 9), planperiod_end: day(20, 22) },
    ],
    functiongroups: [
      { id: 300, project: '/projects/101', name: 'Audio' },
      { id: 301, project: '/projects/101', name: 'Lights' },
    ],
    functions: [
      { id: 400, project: '/projects/100', subproject: '/subprojects/200', group: null, name: 'Sound engineer', planperiod_start: day(12, 8), planperiod_end: day(14, 23) },
      { id: 401, project: '/projects/100', subproject: '/subprojects/200', group: null, name: 'Lighting operator', planperiod_start: day(12, 10), planperiod_end: day(12, 18) },
      { id: 402, project: '/projects/101', subproject: '/subprojects/201', group: '/projectfunctiongroups/300', name: 'FOH', planperiod_start: day(18, 9), planperiod_end: day(18, 23) },
      { id: 403, project: '/projects/101', subproject: '/subprojects/202', group: '/projectfunctiongroups/301', name: 'LD', planperiod_start: day(19, 9), planperiod_end: day(19, 23) },
      { id: 404, project: '/projects/102', subproject: '/subprojects/203', group: null, name: 'Stage hand', planperiod_start: day(20, 9), planperiod_end: day(20, 22) },
    ],
    projectcrew: [
      { id: 500, function: '/projectfunctions/400', crewmember: '/crew/41', planperiod_start: day(12, 8), planperiod_end: day(14, 23) },
      { id: 501, function: '/projectfunctions/401', crewmember: '/crew/42', planperiod_start: day(12, 10), planperiod_end: day(12, 18) },
      { id: 502, function: '/projectfunctions/402', crewmember: '/crew/44', planperiod_start: day(18, 9), planperiod_end: day(18, 23) },
      { id: 503, function: '/projectfunctions/403', crewmember: '/crew/43', planperiod_start: day(19, 9), planperiod_end: day(19, 23) },
      { id: 504, function: '/projectfunctions/403', crewmember: '/crew/42', planperiod_start: day(19, 9), planperiod_end: day(19, 23) },
      { id: 505, function: '/projectfunctions/404', crewmember: '/crew/41', planperiod_start: day(20, 9), planperiod_end: day(20, 22) },
    ],
    invitations: [
      { id: 600, projectcrew: '/projectcrew/500', crewmember: '/crew/41', accepted: true, type: 'final_planning' },
      { id: 601, projectcrew: '/projectcrew/501', crewmember: '/crew/42', accepted: false, type: 'final_planning' },
      { id: 602, projectcrew: '/projectcrew/502', crewmember: '/crew/44', accepted: true, type: 'final_planning' },
      { id: 604, projectcrew: '/projectcrew/504', crewmember: '/crew/42', accepted: true, type: 'final_planning' },
      { id: 605, projectcrew: '/projectcrew/505', crewmember: '/crew/41', accepted: true, type: 'final_planning' },
    ],
  }
  for (const k of ['crew', 'projects', 'subprojects', 'functiongroups', 'functions', 'projectcrew', 'invitations', 'statuses', 'contacts']) for (const x of D[k]) x.modified = old
  return D
}

export function startRentmanMock(port = 0) {
  const D = rentmanData()
  const calls = []
  const touch = (x) => ((x.modified = new Date().toISOString()), x)
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (o, s = 200) => {
      res.writeHead(s, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    const q = (k) => u.searchParams.get(k)
    // ---- test controls
    if (u.pathname === '/__calls') return json(calls.splice(0))
    if (u.pathname === '/__accept') {
      const pc = Number(q('pc'))
      let inv = D.invitations.find((i) => i.projectcrew === `/projectcrew/${pc}`)
      if (!inv) D.invitations.push((inv = { id: 700 + D.invitations.length, projectcrew: `/projectcrew/${pc}`, accepted: true, type: 'final_planning' }))
      inv.accepted = q('accepted') !== '0'
      touch(inv)
      return json(inv)
    }
    if (u.pathname === '/__plan') {
      const pc = { id: 800 + D.projectcrew.length, function: `/projectfunctions/${q('fn')}`, crewmember: `/crew/${q('crew')}`, planperiod_start: null, planperiod_end: null }
      touch(pc)
      D.projectcrew.push(pc)
      if (q('accepted') === '1') D.invitations.push(touch({ id: 900 + D.invitations.length, projectcrew: `/projectcrew/${pc.id}`, accepted: true, type: 'final_planning' }))
      return json(pc)
    }
    if (u.pathname === '/__unplan') {
      const i = D.projectcrew.findIndex((x) => x.id === Number(q('pc')))
      if (i >= 0) D.projectcrew.splice(i, 1)
      return json({ ok: i >= 0 })
    }
    if (u.pathname === '/__status') {
      const s = D.subprojects.find((x) => x.id === Number(q('sub')))
      s.status = `/statuses/${q('status')}`
      touch(s)
      return json(s)
    }
    if (u.pathname === '/__time') {
      const pc = D.projectcrew.find((x) => x.id === Number(q('pc')))
      if (q('start')) pc.planperiod_start = q('start')
      if (q('end')) pc.planperiod_end = q('end')
      touch(pc)
      return json(pc)
    }
    if (u.pathname === '/__project') {
      const p = { id: 110 + D.projects.length, name: q('name') || 'New show', number: '', creator: '/crew/33', location: null, planperiod_start: null, planperiod_end: null, created: new Date().toISOString() }
      touch(p)
      D.projects.push(p)
      D.subprojects.push(touch({ id: 250 + D.subprojects.length, project: `/projects/${p.id}`, name: 'Main', status: `/statuses/${q('status') || 1}`, order: 1 }))
      return json(p)
    }
    calls.push(`${req.method} ${decodeURIComponent(u.pathname + u.search)}`)
    if (req.headers.authorization !== 'Bearer rtok') return json({ message: 'Invalid token' }, 401)
    // ---- API
    const coll = (list) => {
      let out = list
      const cursor = q('cursor')
      let offset = 0
      let limit = Number(q('limit') || 300)
      const params = new URLSearchParams(u.search)
      if (cursor) {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString())
        offset = c.offset
        limit = c.limit
        for (const [k, v] of Object.entries(c.params)) params.set(k, v)
      }
      const gt = params.get('modified[gt]')
      if (gt) out = out.filter((x) => Date.parse(x.modified) > Date.parse(gt))
      if (params.get('accepted') === 'true') out = out.filter((x) => x.accepted === true)
      if (params.get('sort') === '-id') out = [...out].sort((a, b) => b.id - a.id)
      const page = out.slice(offset, offset + limit)
      const keep = Object.fromEntries([...params].filter(([k]) => k !== 'cursor'))
      const next = offset + limit < out.length ? `https://api.rentman.net${u.pathname}?cursor=${Buffer.from(JSON.stringify({ offset: offset + limit, limit, params: keep })).toString('base64url')}` : null
      return json({ data: page, itemCount: page.length, limit, offset, next_page_url: next })
    }
    const one = (x) => (x ? json({ data: x }) : json({ message: 'Not found' }, 404))
    const P = u.pathname
    let m
    if (P === '/workspace/:getInfo') return json({ data: D.workspace })
    if (P === '/statuses') return coll(D.statuses)
    if (P === '/crew') return coll(D.crew)
    if ((m = P.match(/^\/crew\/(\d+)$/))) return one(D.crew.find((x) => x.id === Number(m[1])))
    if (P === '/projects') return coll(D.projects)
    if ((m = P.match(/^\/projects\/(\d+)$/))) {
      const p = D.projects.find((x) => x.id === Number(m[1]))
      if (!p) return one(null)
      const loc = p.location && q('expand') === 'location' ? { displayname: D.contacts.find((c) => `/contacts/${c.id}` === p.location)?.displayname } : p.location
      return one({ ...p, location: loc })
    }
    if ((m = P.match(/^\/projects\/(\d+)\/(subprojects|projectfunctiongroups|projectfunctions|projectcrew)$/))) {
      const pid = `/projects/${m[1]}`
      const fnIds = new Set(D.functions.filter((f) => f.project === pid).map((f) => `/projectfunctions/${f.id}`))
      const list = { subprojects: D.subprojects.filter((s) => s.project === pid), projectfunctiongroups: D.functiongroups.filter((g) => g.project === pid), projectfunctions: D.functions.filter((f) => f.project === pid), projectcrew: D.projectcrew.filter((c) => fnIds.has(c.function)) }[m[2]]
      return coll(list)
    }
    if (P === '/subprojects') return coll(D.subprojects)
    if ((m = P.match(/^\/subprojects\/(\d+)$/))) return one(D.subprojects.find((x) => x.id === Number(m[1])))
    if (P === '/projectfunctions') return coll(D.functions)
    if ((m = P.match(/^\/projectfunctions\/(\d+)$/))) return one(D.functions.find((x) => x.id === Number(m[1])))
    if (P === '/projectcrew') return coll(D.projectcrew)
    if ((m = P.match(/^\/projectcrew\/(\d+)$/))) return one(D.projectcrew.find((x) => x.id === Number(m[1])))
    if (P === '/invitations') return coll(D.invitations)
    json({ message: 'Not found' }, 404)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, data: D })))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startRentmanMock(Number(process.argv[2] || 8896))
  console.log(`rentman mock on ${port}`)
}
