const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, risk } = require('./insight_service');

function database() {
  const tables = new Map();
  let next = 1;
  const rows = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  return {
    collection(name) {
      return {
        doc(id) { return {
          async get() { if (!rows(name).has(id)) throw Object.assign(new Error('missing'), { code: 'DOCUMENT_NOT_FOUND' }); return { data: rows(name).get(id) }; },
          async set({ data }) { rows(name).set(id, { _id: id, ...data }); },
          async update({ data }) { rows(name).set(id, { ...rows(name).get(id), ...data }); }
        }; },
        async add({ data }) { const id = String(next++); rows(name).set(id, { _id: id, ...data }); return { _id: id }; },
        where(query) { return { skip(offset) { return { limit(count) { return { async get() { return { data: [...rows(name).values()].filter(item => Object.entries(query).every(([key, value]) => item[key] === value)).slice(offset, offset + count) }; } }; } }; } }; },
        skip(offset) { return { limit(count) { return { async get() { return { data: [...rows(name).values()].slice(offset, offset + count) }; } }; } }; }
      };
    }
  };
}

async function setup() {
  const db = database();
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['alice-id', 'bob-id'] } });
  await db.collection('members').doc('alice-id').set({ data: { name: '张三', status: 'approved', role: 'member' } });
  await db.collection('members').doc('bob-id').set({ data: { name: '李四', status: 'approved', role: 'member' } });
  await db.collection('tasks').doc('a').set({ data: { title: '张三的报告', description: '联系 13812345678', creatorId: 'alice-id', assigneeId: 'alice-id', collaboratorIds: [], status: 'in_progress', dueDate: '2026-10-05', createdAt: '2026-10-01T00:00:00Z' } });
  await db.collection('tasks').doc('b').set({ data: { title: '私人保密任务', description: 'token=secret-value', creatorId: 'bob-id', assigneeId: 'bob-id', collaboratorIds: [], status: 'in_progress', dueDate: '2026-10-09', createdAt: '2026-10-01T00:00:00Z' } });
  await db.collection('office_state').doc('note-a').set({ data: { kind: 'execution_record', taskId: 'a', text: '张三已完成初稿', createdAt: '2026-10-02T00:00:00Z' } });
  await db.collection('office_state').doc('note-b').set({ data: { kind: 'execution_record', taskId: 'b', text: '私人保密记录', createdAt: '2026-10-02T00:00:00Z' } });
  const requests = [];
  const service = createService(db, async request => { requests.push(request); return '张三的分析'; }, () => '2026-10-06T02:00:00Z', 'test-model');
  return { db, requests, service };
}

test('query retrieves only permitted tasks and removes identities before the model call', async () => {
  const { db, requests, service } = await setup();
  await assert.rejects(service.ask('outsider', '任务进度'), { code: 'FORBIDDEN' });
  const result = await service.ask('alice-id', '张三的任务进度，电话 13812345678');
  const sent = JSON.stringify(requests[0]);
  assert.equal(requests[0].tasks.length, 1);
  assert.equal(requests[0].tasks[0].assignedToRequester, true);
  for (const hidden of ['私人保密', 'alice-id', 'bob-id', '张三', '李四', '13812345678']) assert.equal(sent.includes(hidden), false);
  assert.equal(result.summary, '[成员]的分析');
  assert.equal(result.risks[0].level, 'high');
  const log = (await db.collection('office_state').doc(result.id).get()).data;
  assert.equal(log.userId, 'alice-id');
  assert.equal(log.model, 'test-model');
  assert.equal(log.adopted, false);
  await service.adopt('alice-id', result.id);
  assert.equal((await db.collection('office_state').doc(result.id).get()).data.adopted, true);
  await assert.rejects(service.adopt('bob-id', result.id), { code: 'NOT_FOUND' });
});

test('daily generation is per member and does not repeat on the same day', async () => {
  const { requests, service } = await setup();
  assert.deepEqual(await service.daily(), { generated: 2, failed: 0 });
  assert.deepEqual(await service.daily(), { generated: 0, failed: 0 });
  assert.equal(requests.length, 2);
  const latest = await service.latest('alice-id');
  assert.equal(latest.risks[0].taskId, 'a');
});

test('old analysis is hidden when task access is revoked', async () => {
  const { db, service } = await setup();
  const result = await service.refresh('alice-id');
  await db.collection('tasks').doc('a').update({ data: { creatorId: 'bob-id', assigneeId: 'bob-id' } });
  assert.equal(await service.latest('alice-id'), null);
  await assert.rejects(service.adopt('alice-id', result.id), { code: 'NOT_FOUND' });
});

test('a just-expired deadline is overdue', () => {
  const item = risk({ _id: 'a', title: 'A', status: 'in_progress', dueDate: '2026-10-05', createdAt: '2026-10-05T00:00:00Z' }, [], [], [], '2026-10-05T16:00:00Z');
  assert.equal(item.level, 'high');
  assert.match(item.reason, /已逾期/);
});
