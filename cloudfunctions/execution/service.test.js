const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, CHUNK_SIZE, MAX_SIZE } = require('./service');

function database() {
  const tables = new Map();
  let next = 1;
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
            async update({ data }) { rows(name).set(id, { ...rows(name).get(id), ...data }); },
            async remove() { rows(name).delete(id); }
          };
        },
        async add({ data }) {
          const id = String(next++);
          rows(name).set(id, { _id: id, ...data });
          return { _id: id };
        },
        where(filter) {
          return { skip(offset) { return { limit(size) { return { async get() {
            return { data: [...rows(name).values()].filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).slice(offset, offset + size) };
          } }; } }; } };
        }
      };
    },
    async runTransaction(callback) { return callback(db); }
  };
  return db;
}

async function setup() {
  const db = database();
  await db.collection('office_state').doc('main').set({ data: { memberIds: ['owner', 'assignee', 'helper', 'outsider'] } });
  for (const id of ['owner', 'assignee', 'helper', 'outsider']) await db.collection('members').doc(id).set({ data: { status: 'approved', role: 'member' } });
  await db.collection('tasks').doc('root').set({ data: { creatorId: 'owner', assigneeId: 'assignee', collaboratorIds: ['helper'], status: 'in_progress', parentId: '', attachmentCount: 0, updatedAt: '' } });
  const uploaded = new Map();
  const cloud = {
    async uploadFile({ cloudPath, fileContent }) { uploaded.set(cloudPath, fileContent); return { fileID: `cloud://${cloudPath}` }; },
    async deleteFile({ fileList }) { for (const id of fileList) uploaded.delete(id.replace('cloud://', '')); },
    async getTempFileURL({ fileList }) { return { fileList: [{ tempFileURL: `https://example.test/${fileList[0].fileID}` }] }; }
  };
  return { db, cloud, uploaded, service: createService(db, cloud, () => '2026-10-06T10:00:00.000Z') };
}

test('only task participants can read records and attachment URLs', async () => {
  const { service, db } = await setup();
  await service.addNote('helper', 'root', 'Reviewed the draft');
  assert.equal((await service.summary('owner', 'root')).records[0].text, 'Reviewed the draft');
  await assert.rejects(service.summary('outsider', 'root'), { code: 'FORBIDDEN' });
  await assert.rejects(service.addNote('outsider', 'root', 'Fake'), { code: 'FORBIDDEN' });
  await db.collection('office_state').doc('file').set({ data: { kind: 'task_attachment', taskId: 'root', fileId: 'cloud://test', name: 'test.pdf' } });
  await assert.rejects(service.attachmentUrl('outsider', 'file'), { code: 'FORBIDDEN' });
  assert.match((await service.attachmentUrl('owner', 'file')).url, /example.test/);
  await db.collection('members').doc('helper').update({ data: { status: 'rejected' } });
  await assert.rejects(service.summary('helper', 'root'), { code: 'FORBIDDEN' });
});

test('assignee status changes update parent progress and append history', async () => {
  const { service, db } = await setup();
  await db.collection('tasks').doc('child-a').set({ data: { creatorId: 'owner', assigneeId: 'assignee', collaboratorIds: [], parentId: 'root', status: 'in_progress', updatedAt: '' } });
  await db.collection('tasks').doc('child-b').set({ data: { creatorId: 'owner', assigneeId: 'assignee', collaboratorIds: [], parentId: 'root', status: 'in_progress', updatedAt: '' } });
  await assert.rejects(service.setStatus('helper', 'child-a', 'completed'), { code: 'FORBIDDEN' });
  await service.setStatus('assignee', 'child-a', 'completed');
  assert.equal((await service.summary('owner', 'root')).progress, 50);
  assert.equal((await service.summary('owner', 'child-a')).history[0].actorId, 'assignee');
  await service.setStatus('assignee', 'child-b', 'completed');
  assert.equal((await service.summary('owner', 'root')).progress, 100);
  await service.setStatus('assignee', 'child-a', 'in_progress');
  assert.equal((await service.summary('owner', 'root')).progress, 50);
});

test('handoff requires five fields and acceptance before execution resumes', async () => {
  const { service, db } = await setup();
  await assert.rejects(service.startHandoff('helper', 'root'), { code: 'FORBIDDEN' });
  await service.startHandoff('assignee', 'root');
  assert.equal((await db.collection('tasks').doc('root').get()).data.status, 'awaiting_handoff');
  await assert.rejects(service.setStatus('assignee', 'root', 'in_progress'), { code: 'INVALID_STATE' });
  await assert.rejects(service.setStatus('assignee', 'root', 'completed'), { code: 'INVALID_STATE' });
  await assert.rejects(service.acceptHandoff('helper', 'root'), { code: 'INVALID_STATE' });
  const content = { currentProgress: 'Half done', completedWork: 'Drafted', unfinishedWork: 'Review', nextAction: 'Review draft', risks: 'Deadline', successorId: 'helper', attachmentIds: [] };
  await assert.rejects(service.submitHandoff('assignee', 'root', { ...content, risks: '' }), { code: 'INVALID_HANDOFF' });
  await assert.rejects(service.submitHandoff('assignee', 'root', { ...content, attachmentIds: ['other'] }), { code: 'INVALID_ATTACHMENT' });
  await service.submitHandoff('assignee', 'root', content);
  await assert.rejects(service.acceptHandoff('outsider', 'root'), { code: 'FORBIDDEN' });
  await assert.rejects(service.acceptHandoff('assignee', 'root'), { code: 'FORBIDDEN' });
  await service.acceptHandoff('helper', 'root');
  const task = (await db.collection('tasks').doc('root').get()).data;
  assert.equal(task.assigneeId, 'helper');
  assert.equal(task.status, 'in_progress');
  assert.equal((await service.summary('assignee', 'root')).handoffs[0].status, 'accepted');
  assert.equal((await service.summary('helper', 'root')).handoffs[0].risks, 'Deadline');
  await assert.rejects(service.acceptHandoff('helper', 'root'), { code: 'INVALID_STATE' });
});

test('handoff can reference own task files and leave successor open', async () => {
  const { service, db } = await setup();
  await db.collection('office_state').doc('attachment').set({ data: { kind: 'task_attachment', taskId: 'root', name: 'evidence.pdf', fileId: 'cloud://test' } });
  await service.startHandoff('assignee', 'root');
  await service.submitHandoff('assignee', 'root', { currentProgress: '1', completedWork: '2', unfinishedWork: '3', nextAction: '4', risks: '5', attachmentIds: ['attachment'] });
  assert.deepEqual((await service.summary('outsider', 'root')).handoffs[0].attachmentIds, ['attachment']);
  await service.acceptHandoff('outsider', 'root');
  assert.equal((await db.collection('tasks').doc('root').get()).data.assigneeId, 'outsider');
});

test('file type, 20 MB limit, chunk integrity, and 50 attachment limit are enforced', async () => {
  const { service, db, uploaded } = await setup();
  await assert.rejects(service.beginUpload('assignee', 'root', { name: 'bad.exe', size: 1 }), { code: 'INVALID_FILE' });
  await assert.rejects(service.beginUpload('assignee', 'root', { name: 'large.pdf', size: MAX_SIZE + 1 }), { code: 'INVALID_FILE' });
  assert.equal((await service.beginUpload('assignee', 'root', { name: 'limit.pdf', size: MAX_SIZE })).chunks, 80);
  await assert.rejects(service.beginUpload('outsider', 'root', { name: 'good.pdf', size: 3 }), { code: 'FORBIDDEN' });
  const upload = await service.beginUpload('assignee', 'root', { name: 'note.pdf', size: 3 });
  assert.equal(upload.chunkSize, CHUNK_SIZE);
  await assert.rejects(service.uploadChunk('outsider', upload.uploadId, 0, 'YWJj'), { code: 'NOT_FOUND' });
  await assert.rejects(service.uploadChunk('assignee', upload.uploadId, 0, 'YQ=='), { code: 'INVALID_CHUNK' });
  await service.uploadChunk('assignee', upload.uploadId, 0, 'YWJj');
  const { attachmentId } = await service.finishUpload('assignee', upload.uploadId);
  assert.equal(uploaded.size, 1);
  assert.equal((await service.summary('owner', 'root')).attachments[0]._id, attachmentId);
  assert.equal((await service.summary('owner', 'root')).history[0].action, 'attachment_added');
  await assert.rejects(service.finishUpload('assignee', upload.uploadId), { code: 'INVALID_STATE' });
  const pending = await service.beginUpload('assignee', 'root', { name: 'race.pdf', size: 1 });
  await service.uploadChunk('assignee', pending.uploadId, 0, 'YQ==');
  await db.collection('tasks').doc('root').update({ data: { attachmentCount: 50 } });
  await assert.rejects(service.beginUpload('assignee', 'root', { name: 'more.pdf', size: 1 }), { code: 'ATTACHMENT_LIMIT' });
  await assert.rejects(service.finishUpload('assignee', pending.uploadId), { code: 'ATTACHMENT_LIMIT' });
  assert.equal(uploaded.size, 1);
});
