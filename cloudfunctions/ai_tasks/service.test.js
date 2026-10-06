const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('./service');

function database() {
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
        }
      };
    },
    async runTransaction(callback) {
      const snapshot = new Map([...tables].map(([name, table]) => [name, new Map(table)]));
      const savedId = nextId;
      try { return await callback(db); }
      catch (error) { tables.clear(); for (const [name, table] of snapshot) tables.set(name, table); nextId = savedId; throw error; }
    }
  };
  return db;
}

async function setup() {
  const db = database();
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['alice', 'bob'] } });
  for (const id of ['alice', 'bob']) await db.collection('members').doc(id).set({ data: { name: id, status: 'approved' } });
  await db.collection('tasks').doc('root').set({ data: { title: 'Prepare briefing', description: 'Context', assigneeId: 'alice', collaboratorIds: ['bob'], depth: 1, type: 'routine', priority: 'normal', confirmationRule: 'ordinary', dueDate: '2026-10-10' } });
  const service = createService(db, async () => ({ subtasks: [{ title: 'Draft', assigneeId: 'bob', dueDate: '2026-10-09', orderNote: 'First', risk: 'Delay' }] }), () => '2026-10-06T10:00:00Z', 'test-model');
  return { db, service };
}

test('only an approved member can propose and input comes from the saved task', async () => {
  const { db, service } = await setup();
  await assert.rejects(service.propose('outsider', { taskId: 'root' }), { code: 'FORBIDDEN' });
  const draft = await service.propose('alice', { taskId: 'root', description: 'Updated context', attachmentText: 'Notes' });
  const log = (await db.collection('office_state').doc(draft.id).get()).data;
  assert.equal(log.request.title, 'Prepare briefing');
  assert.equal(log.request.description, 'Updated context');
  assert.equal(log.request.attachmentText, 'Notes');
  assert.equal(log.model, 'test-model');
  assert.equal(JSON.parse(log.response).subtasks[0].title, 'Draft');
  assert.equal(log.status, 'preview');
  await assert.rejects(service.confirm('bob', draft.id, draft.suggestions), { code: 'NOT_FOUND' });
});

test('cancel creates no tasks and cannot later be confirmed', async () => {
  const { db, service } = await setup();
  const draft = await service.propose('alice', { taskId: 'root' });
  await service.cancel('alice', draft.id);
  await assert.rejects(service.confirm('alice', draft.id, draft.suggestions), { code: 'INVALID_STATE' });
  await assert.rejects(db.collection('tasks').doc('2').get(), { code: 'DOCUMENT_NOT_FOUND' });
  assert.equal((await db.collection('office_state').doc(draft.id).get()).data.adopted, false);
});

test('confirmation uses edited suggestions and cannot create twice', async () => {
  const { db, service } = await setup();
  const draft = await service.propose('alice', { taskId: 'root' });
  const edited = [{ title: 'Final version', description: 'Edited', assigneeId: 'alice', dueDate: '', orderNote: 'After review', risk: 'None' }];
  await assert.rejects(service.confirm('alice', draft.id, [{ ...edited[0], assigneeId: 'outsider' }]), { code: 'INVALID_SUGGESTIONS' });
  await assert.rejects(service.confirm('alice', draft.id, [{ ...edited[0], dueDate: '2026-10-10-invalid' }]), { code: 'INVALID_SUGGESTIONS' });
  const result = await service.confirm('alice', draft.id, edited);
  const task = (await db.collection('tasks').doc(result.ids[0]).get()).data;
  assert.equal(task.title, 'Final version');
  assert.equal(task.parentId, 'root');
  assert.equal(task.depth, 2);
  assert.equal(task.executionOrder, 1);
  assert.equal((await db.collection('office_state').doc(draft.id).get()).data.adopted, true);
  await assert.rejects(service.confirm('alice', draft.id, edited), { code: 'INVALID_STATE' });
});

test('third-level tasks cannot be decomposed', async () => {
  const { db, service } = await setup();
  await db.collection('tasks').doc('leaf').set({ data: { title: 'Leaf', depth: 3 } });
  await assert.rejects(service.propose('alice', { taskId: 'leaf' }), { code: 'DEPTH_LIMIT' });
});

test('empty model output is recorded and asks for more context', async () => {
  const { db } = await setup();
  const service = createService(db, async () => ({ subtasks: [] }), () => '2026-10-06T10:00:00Z', 'test-model');
  await assert.rejects(service.propose('alice', { taskId: 'root' }), { code: 'EMPTY_SUGGESTIONS' });
  const rows = db.collection('office_state');
  const failed = (await rows.doc('1').get()).data;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.response, '{"subtasks":[]}');
});
