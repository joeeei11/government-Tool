const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('./service');

function fakeDatabase() {
  const tables = new Map();
  let nextId = 1;
  const rows = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (!rows(name).has(id)) throw Object.assign(new Error('missing'), { code: 'DOCUMENT_NOT_FOUND' });
              return { data: { ...rows(name).get(id) } };
            },
            async set({ data }) { rows(name).set(id, { _id: id, ...data }); },
            async update({ data }) { rows(name).set(id, { ...rows(name).get(id), ...data }); }
          };
        },
        async add({ data }) {
          const id = String(nextId++);
          rows(name).set(id, { _id: id, ...data });
          return { _id: id };
        },
        skip(offset) {
          return { limit(size) { return { async get() { return { data: [...rows(name).values()].slice(offset, offset + size) }; } }; } };
        },
        where(query) {
          return { skip(offset) { return { limit(size) { return { async get() { return { data: [...rows(name).values()].filter(row => Object.entries(query).every(([key, value]) => row[key] === value)).slice(offset, offset + size) }; } }; } }; } };
        }
      };
    },
    async runTransaction(callback) { return callback(db); }
  };
  return db;
}

async function setup() {
  const db = fakeDatabase();
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['alice', 'bob', 'admin'] } });
  for (const id of ['alice', 'bob', 'admin']) {
    await db.collection('members').doc(id).set({ data: { name: id, status: 'approved', role: id === 'admin' ? 'admin' : 'member' } });
  }
  return { db, service: createService(db, () => '2026-10-06T10:00:00.000Z') };
}

test('approved members create and read tasks; unapproved users cannot access any task', async () => {
  const { db, service } = await setup();
  const { id } = await service.create('alice', { title: 'Prepare briefing', assigneeId: 'bob' });
  assert.equal((await service.get('bob', id)).creatorId, 'alice');
  assert.equal((await service.list('bob')).length, 1);
  await db.collection('members').doc('forged').set({ data: { status: 'approved', role: 'admin' } });
  await assert.rejects(service.list('forged'), { code: 'FORBIDDEN' });
  await assert.rejects(service.create('forged', { title: 'Fake', assigneeId: 'bob' }), { code: 'FORBIDDEN' });
});

test('pending handoff cannot be bypassed by editing the assignee', async () => {
  const { db, service } = await setup();
  const { id } = await service.create('alice', { title: 'Transfer', assigneeId: 'bob' });
  await db.collection('tasks').doc(id).update({ data: { status: 'awaiting_handoff', activeHandoffId: 'handoff' } });
  await assert.rejects(service.update('alice', id, { assigneeId: 'admin' }), { code: 'INVALID_STATE' });
  assert.equal((await service.get('alice', id)).assigneeId, 'bob');
});

test('task fields and members are validated before writing', async () => {
  const { service } = await setup();
  await assert.rejects(service.create('alice', { title: '  ', assigneeId: 'bob' }), { code: 'INVALID_TASK' });
  await assert.rejects(service.create('alice', { title: 'Briefing', assigneeId: 'outsider' }), { code: 'INVALID_MEMBER' });
  await assert.rejects(service.create('alice', { title: 'Briefing', assigneeId: 'bob', dueDate: '2026-02-30' }), { code: 'INVALID_TASK' });
  const { id } = await service.create('alice', { title: 'Briefing', assigneeId: 'bob', confirmationRule: 'important', confirmerId: 'admin', collaboratorIds: ['alice'] });
  const task = await service.get('alice', id);
  assert.equal(task.confirmationRule, 'important');
  assert.deepEqual(task.collaboratorIds, ['alice']);
});

test('all approved members can edit subtasks up to three levels; root editing is restricted', async () => {
  const { service } = await setup();
  const root = (await service.create('alice', { title: 'Root', assigneeId: 'bob' })).id;
  const second = (await service.create('bob', { title: 'Second', assigneeId: 'bob', parentId: root })).id;
  const third = (await service.create('bob', { title: 'Third', assigneeId: 'bob', parentId: second })).id;
  assert.equal((await service.get('alice', third)).depth, 3);
  await assert.rejects(service.create('alice', { title: 'Fourth', assigneeId: 'bob', parentId: third }), { code: 'DEPTH_LIMIT' });
  await assert.rejects(service.update('bob', root, { title: 'Changed' }), { code: 'FORBIDDEN' });
  await service.update('alice', second, { title: 'Changed' });
  assert.equal((await service.get('bob', second)).title, 'Changed');
  await assert.rejects(service.update('alice', second, { parentId: third }), { code: 'INVALID_TASK' });
});

test('workbox endpoint excludes an already confirmed major task for that member', async () => {
  const { db, service } = await setup();
  await db.collection('tasks').doc('major').set({ data: { title: 'Major', status: 'awaiting_confirmation', assigneeId: 'bob', collaboratorIds: [], creatorId: 'alice', confirmationRule: 'major', updatedAt: '2026-10-06T09:00:00.000Z' } });
  await db.collection('office_state').doc('vote').set({ data: { kind: 'task_confirmation', taskId: 'major', memberId: 'alice' } });
  assert.equal((await service.listWorkbox('alice')).confirmation.length, 0);
  assert.equal((await service.listWorkbox('bob')).confirmation.length, 1);
});
