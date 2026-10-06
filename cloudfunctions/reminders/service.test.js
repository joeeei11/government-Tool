const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, eventState, messageData } = require('./service');
const { workbox, deadline } = require('../tasks/service');

function fakeDatabase() {
  const tables = new Map();
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
        skip(offset) { return { limit(size) { return { async get() { return { data: [...rows(name).values()].slice(offset, offset + size) }; } }; } }; }
      };
    },
    async runTransaction(callback) { return callback(db); }
  };
  return db;
}

const time = '2026-10-06T08:00:00.000Z';
const task = (id, dueDate, type = 'routine', status = 'in_progress') => ({ _id: id, title: id, dueDate, type, status, assigneeId: 'alice', collaboratorIds: ['bob'], creatorId: 'alice', updatedAt: time, confirmationRule: 'ordinary' });

test('deadline classification matches Shanghai end of day and urgent 24-hour window', () => {
  const instant = Date.parse(time);
  assert.equal(deadline(task('ordinary', '2026-10-09'), instant).state, 'soon');
  assert.equal(deadline(task('urgent', '2026-10-08', 'urgent'), instant), null);
  assert.equal(deadline(task('urgent', '2026-10-06', 'urgent'), instant).state, 'soon');
  assert.equal(deadline(task('today', '2026-10-06'), instant).reason, '今天截止：2026-10-06');
  assert.equal(eventState(task('done', '2026-10-05'), instant), 'overdue');
  assert.equal(eventState(task('completed', '2026-10-05', 'routine', 'completed'), instant), '');
});

test('selected WeChat template receives date-only and short reminder fields', () => {
  const fields = { thing3: 'title', date6: 'due', thing24: 'state' };
  assert.deepEqual(messageData(task('Prepare briefing', '2026-10-07'), 'soon', fields), {
    thing3: { value: 'Prepare briefing' }, date6: { value: '2026-10-07' }, thing24: { value: '即将截止，请及时处理' }
  });
  assert.equal(messageData(task('Late', '2026-10-05'), 'overdue', fields).thing24.value, '已经逾期，请尽快处理');
});

test('a first subscription accepts the cloud database missing-document message', async () => {
  const db = fakeDatabase();
  const originalCollection = db.collection;
  db.collection = name => {
    const collection = originalCollection(name);
    if (name !== 'office_state') return collection;
    const originalDoc = collection.doc;
    collection.doc = id => {
      const doc = originalDoc(id);
      const get = doc.get;
      doc.get = async () => {
        try { return await get(); }
        catch (error) { throw Object.assign(new Error('document does not exist'), { code: 'DATABASE_REQUEST_FAILED' }); }
      };
      return doc;
    };
    return collection;
  };
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['alice'] } });
  await db.collection('members').doc('alice').set({ data: { status: 'approved' } });
  await db.collection('tasks').doc('due').set({ data: task('due', '2026-10-06', 'urgent') });
  const service = createService(db, async () => {}, () => time, { templateId: 'template', fields: { thing3: 'title' } });
  assert.deepEqual(await service.subscribe('alice', 'due', 'soon'), { taskId: 'due', kind: 'soon' });
});

test('five workbox queues have membership, ordering and reasons', () => {
  const tasks = [task('soon', '2026-10-09'), task('overdue', '2026-10-05'), task('today', '2026-10-06'), task('urgent-later', '2026-10-08', 'urgent'),
    { ...task('major', '', 'routine', 'awaiting_confirmation'), confirmationRule: 'major' },
    { ...task('handoff', '', 'routine', 'awaiting_handoff'), handoffReady: true },
    { ...task('other', '2026-10-06'), assigneeId: 'outsider', collaboratorIds: [], creatorId: 'outsider' }];
  const result = workbox(tasks, 'alice', Date.parse(time), new Set(['major']));
  assert.deepEqual(result.today.map(item => item._id), ['overdue', 'today']);
  assert.match(result.today[0].deadline.reason, /已于/);
  assert.deepEqual(result.soon.map(item => item._id), ['soon']);
  assert.deepEqual(result.confirmation.map(item => item._id), []);
  assert.deepEqual(result.handoff.map(item => item._id), ['handoff']);
  assert.equal(result.recent.some(item => item._id === 'other'), false);
});

test('only approved task participants can subscribe; scheduled retries do not resend', async () => {
  const db = fakeDatabase();
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['alice', 'bob', 'outsider'] } });
  for (const id of ['alice', 'bob', 'outsider']) await db.collection('members').doc(id).set({ data: { status: 'approved' } });
  await db.collection('tasks').doc('due').set({ data: task('due', '2026-10-06', 'urgent') });
  const sent = [];
  const service = createService(db, async message => sent.push(message), () => time, { templateId: 'template', fields: { thing1: 'title' } });
  await assert.rejects(service.subscribe('outsider', 'due', 'soon'), { code: 'FORBIDDEN' });
  await service.subscribe('alice', 'due', 'soon');
  assert.deepEqual(await service.subscriptionStatus('alice', 'due'), { soon: true, overdue: false });
  await assert.rejects(service.subscriptionStatus('outsider', 'due'), { code: 'FORBIDDEN' });
  await assert.rejects(service.subscribe('alice', 'due', 'soon'), { code: 'ALREADY_SUBSCRIBED' });
  assert.equal((await service.run()).sent, 1);
  assert.equal((await service.run()).sent, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openid, 'alice');
});

test('status and due-date changes cancel pending reminders', async () => {
  const db = fakeDatabase();
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['alice'] } });
  await db.collection('members').doc('alice').set({ data: { status: 'approved' } });
  await db.collection('tasks').doc('due').set({ data: task('due', '2026-10-06', 'urgent') });
  const sent = [];
  const service = createService(db, async message => sent.push(message), () => time, { templateId: 'template', fields: { thing1: 'title' } });
  await service.subscribe('alice', 'due', 'soon');
  await db.collection('tasks').doc('due').update({ data: { status: 'completed' } });
  assert.equal((await service.run()).sent, 0);
  await db.collection('tasks').doc('due').update({ data: { status: 'in_progress', dueDate: '2026-10-08' } });
  assert.equal((await service.run()).sent, 0);
  assert.equal(sent.length, 0);
});

test('scheduled checks still classify deadlines without a message template', async () => {
  const db = fakeDatabase();
  await db.collection('office_state').doc('main').set({ data: { memberIds: [] } });
  await db.collection('tasks').doc('soon').set({ data: task('soon', '2026-10-09') });
  await db.collection('tasks').doc('late').set({ data: task('late', '2026-10-05') });
  const service = createService(db, async () => assert.fail('must not send'), () => time, { templateId: '', fields: null });
  assert.deepEqual(await service.run(), { checked: 2, approaching: 1, overdue: 1, sent: 0, failed: 0, notificationsAvailable: false });
});

test('a failed send is recorded and not attempted again on the next run', async () => {
  const db = fakeDatabase();
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['alice'] } });
  await db.collection('members').doc('alice').set({ data: { status: 'approved' } });
  await db.collection('tasks').doc('due').set({ data: task('due', '2026-10-06', 'urgent') });
  let calls = 0;
  const service = createService(db, async () => { calls += 1; throw Object.assign(new Error('rejected'), { errCode: 43101 }); }, () => time, { templateId: 'template', fields: { thing1: 'title' } });
  await service.subscribe('alice', 'due', 'soon');
  assert.equal((await service.run()).failed, 1);
  await service.run();
  assert.equal(calls, 1);
});
