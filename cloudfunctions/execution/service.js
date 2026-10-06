class ExecutionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const COLLECTION = 'office_state';
const CHUNK_SIZE = 256 * 1024;
const MAX_SIZE = 20 * 1024 * 1024;
const EXTENSIONS = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

async function read(db, collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data; }
  catch (error) {
    if (error.code === 'DOCUMENT_NOT_FOUND' || error.errCode === -502005) return null;
    throw error;
  }
}

function createService(db, cloud, now) {
  async function officeMember(openid) {
    const state = await read(db, COLLECTION, 'main');
    if (!state || !Array.isArray(state.memberIds) || !state.memberIds.includes(openid)) throw new ExecutionError('FORBIDDEN');
    const member = await read(db, 'members', openid);
    if (!member || member.status !== 'approved') throw new ExecutionError('FORBIDDEN');
    return { member, memberIds: state.memberIds };
  }

  async function context(openid, taskId) {
    const { member } = await officeMember(openid);
    const task = await read(db, 'tasks', taskId);
    if (!task) throw new ExecutionError('NOT_FOUND');
    const handoffs = await byTask('task_handoff', taskId);
    const allowed = openid === task.creatorId || openid === task.assigneeId || (task.collaboratorIds || []).includes(openid) || member.role === 'admin' || handoffs.some(item => item.fromId === openid || item.successorId === openid || (item.status === 'submitted' && !item.successorId));
    if (!allowed) throw new ExecutionError('FORBIDDEN');
    return { task, member };
  }

  async function byTask(kind, taskId) {
    const result = [];
    for (let offset = 0; ; offset += 100) {
      const batch = (await db.collection(COLLECTION).where({ kind, taskId }).skip(offset).limit(100).get()).data;
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }

  async function summary(openid, taskId) {
    const { task } = await context(openid, taskId);
    const children = [];
    for (let offset = 0; ; offset += 100) {
      const batch = (await db.collection('tasks').where({ parentId: taskId }).skip(offset).limit(100).get()).data;
      children.push(...batch);
      if (batch.length < 100) break;
    }
    const [records, attachments, history, handoffs] = await Promise.all([
      byTask('execution_record', taskId), byTask('task_attachment', taskId), byTask('execution_event', taskId), byTask('task_handoff', taskId)
    ]);
    const doneStatuses = ['awaiting_confirmation', 'completed', 'archived'];
    const progress = children.length ? Math.round(children.filter(child => doneStatuses.includes(child.status)).length * 100 / children.length) : (doneStatuses.includes(task.status) ? 100 : 0);
    return { progress, childCount: children.length, completedChildren: children.filter(child => doneStatuses.includes(child.status)).length,
      records: records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      attachments: attachments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ fileId, ...item }) => item),
      history: history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      handoffs: handoffs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  async function addNote(openid, taskId, value) {
    const { task } = await context(openid, taskId);
    if (openid !== task.assigneeId && !(task.collaboratorIds || []).includes(openid)) throw new ExecutionError('FORBIDDEN');
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > 2000) throw new ExecutionError('INVALID_TEXT');
    const timestamp = now();
    await db.runTransaction(async transaction => {
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_record', taskId, text, actorId: openid, createdAt: timestamp } });
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'note_added', actorId: openid, createdAt: timestamp } });
      await transaction.collection('tasks').doc(taskId).update({ data: { updatedAt: timestamp } });
    });
    return { taskId };
  }

  async function setStatus(openid, taskId, status) {
    const { task } = await context(openid, taskId);
    if (openid !== task.assigneeId || !['in_progress', 'completed'].includes(status) || task.status === 'archived') throw new ExecutionError('FORBIDDEN');
    if (task.status === 'awaiting_handoff') throw new ExecutionError('INVALID_STATE');
    if (task.status === status) throw new ExecutionError('INVALID_STATE');
    if (status === 'completed' && task.status !== 'in_progress') throw new ExecutionError('INVALID_STATE');
    const timestamp = now();
    await db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', taskId);
      if (!current || current.status !== task.status) throw new ExecutionError('INVALID_STATE');
      const nextStatus = status === 'completed' ? 'awaiting_confirmation' : status;
      await transaction.collection('tasks').doc(taskId).update({ data: { status: nextStatus, updatedAt: timestamp } });
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'status_changed', from: task.status, to: status, actorId: openid, createdAt: timestamp } });
    });
    return { taskId, status: status === 'completed' ? 'awaiting_confirmation' : status };
  }

  async function confirmationContext(openid, taskId) {
    const { member, memberIds } = await officeMember(openid);
    const task = await read(db, 'tasks', taskId);
    if (!task) throw new ExecutionError('NOT_FOUND');
    if (task.status !== 'awaiting_confirmation') throw new ExecutionError('INVALID_STATE');
    const eligible = task.confirmationRule === 'ordinary' ? task.assigneeId === openid : task.confirmationRule === 'important' ? task.confirmerId === openid : memberIds.includes(openid);
    if (!eligible) throw new ExecutionError('FORBIDDEN');
    return { task, member, memberIds };
  }

  async function confirm(openid, taskId) {
    const { task, memberIds } = await confirmationContext(openid, taskId);
    const timestamp = now();
    return db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', taskId);
      if (!current || current.status !== 'awaiting_confirmation') throw new ExecutionError('INVALID_STATE');
      const existing = await byTask('task_confirmation', taskId);
      if (existing.some(item => item.memberId === openid)) throw new ExecutionError('INVALID_STATE');
      await transaction.collection(COLLECTION).add({ data: { kind: 'task_confirmation', taskId, memberId: openid, createdAt: timestamp } });
      const required = task.confirmationRule === 'major' ? 5 : 1;
      const confirmedCount = existing.length + 1;
      const complete = confirmedCount >= required;
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'task_confirmed', actorId: openid, createdAt: timestamp } });
      if (complete) await transaction.collection('tasks').doc(taskId).update({ data: { status: 'completed', updatedAt: timestamp } });
      return { taskId, confirmed: complete, confirmations: confirmedCount, required };
    });
  }

  async function returnTask(openid, taskId, reason) {
    const { task } = await confirmationContext(openid, taskId);
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > 2000) throw new ExecutionError('INVALID_TEXT');
    const timestamp = now();
    await db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', taskId);
      if (!current || current.status !== 'awaiting_confirmation') throw new ExecutionError('INVALID_STATE');
      await transaction.collection('tasks').doc(taskId).update({ data: { status: 'in_progress', updatedAt: timestamp } });
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'task_returned', reason: text, actorId: openid, createdAt: timestamp } });
    });
    return { taskId };
  }

  async function archive(openid, taskId) {
    const { task, member } = await context(openid, taskId);
    if (task.status !== 'completed' || (task.creatorId !== openid && member.role !== 'admin')) throw new ExecutionError('FORBIDDEN');
    const timestamp = now();
    await db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', taskId);
      if (!current || current.status !== 'completed') throw new ExecutionError('INVALID_STATE');
      await transaction.collection('tasks').doc(taskId).update({ data: { status: 'archived', updatedAt: timestamp } });
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'task_archived', actorId: openid, createdAt: timestamp } });
    });
    return { taskId };
  }

  async function startHandoff(openid, taskId) {
    const { task } = await context(openid, taskId);
    if (task.assigneeId !== openid) throw new ExecutionError('FORBIDDEN');
    if (task.status !== 'in_progress') throw new ExecutionError('INVALID_STATE');
    const timestamp = now();
    return db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', taskId);
      if (!current || current.status !== 'in_progress' || current.assigneeId !== openid) throw new ExecutionError('INVALID_STATE');
      const result = await transaction.collection(COLLECTION).add({ data: { kind: 'task_handoff', taskId, fromId: openid, successorId: '', status: 'draft', createdAt: timestamp } });
      await transaction.collection('tasks').doc(taskId).update({ data: { status: 'awaiting_handoff', activeHandoffId: result._id, handoffReady: false, handoffSuccessorId: '', updatedAt: timestamp } });
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'handoff_started', actorId: openid, createdAt: timestamp } });
      return { id: result._id };
    });
  }

  async function submitHandoff(openid, taskId, input) {
    const { task } = await context(openid, taskId);
    if (task.assigneeId !== openid) throw new ExecutionError('FORBIDDEN');
    if (task.status !== 'awaiting_handoff' || !task.activeHandoffId) throw new ExecutionError('INVALID_STATE');
    const fields = ['currentProgress', 'completedWork', 'unfinishedWork', 'nextAction', 'risks'];
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ExecutionError('INVALID_HANDOFF');
    const content = {};
    for (const field of fields) {
      const value = input[field];
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) throw new ExecutionError('INVALID_HANDOFF');
      content[field] = value.trim();
    }
    const { memberIds } = await officeMember(openid);
    const successorId = input.successorId || '';
    if (typeof successorId !== 'string' || successorId === openid || (successorId && !memberIds.includes(successorId))) throw new ExecutionError('INVALID_MEMBER');
    if (successorId) await officeMember(successorId);
    const attachmentIds = input.attachmentIds || [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 20 || attachmentIds.some(id => typeof id !== 'string') || new Set(attachmentIds).size !== attachmentIds.length) throw new ExecutionError('INVALID_HANDOFF');
    for (const id of attachmentIds) {
      const attachment = await read(db, COLLECTION, id);
      if (!attachment || attachment.kind !== 'task_attachment' || attachment.taskId !== taskId) throw new ExecutionError('INVALID_ATTACHMENT');
    }
    const timestamp = now();
    await db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', taskId);
      const handoff = await read(transaction, COLLECTION, task.activeHandoffId);
      if (!current || current.status !== 'awaiting_handoff' || current.activeHandoffId !== task.activeHandoffId || current.assigneeId !== openid || !handoff || handoff.status !== 'draft') throw new ExecutionError('INVALID_STATE');
      await transaction.collection(COLLECTION).doc(handoff._id).update({ data: { ...content, successorId, attachmentIds, status: 'submitted', submittedAt: timestamp } });
      await transaction.collection('tasks').doc(taskId).update({ data: { handoffReady: true, handoffSuccessorId: successorId, updatedAt: timestamp } });
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'handoff_submitted', actorId: openid, createdAt: timestamp } });
    });
    return { taskId };
  }

  async function acceptHandoff(openid, taskId) {
    await officeMember(openid);
    const task = await read(db, 'tasks', taskId);
    if (!task || task.status !== 'awaiting_handoff' || !task.activeHandoffId) throw new ExecutionError('INVALID_STATE');
    const handoff = await read(db, COLLECTION, task.activeHandoffId);
    if (!handoff || handoff.status !== 'submitted') throw new ExecutionError('INVALID_STATE');
    if (openid === handoff.fromId || (handoff.successorId && handoff.successorId !== openid)) throw new ExecutionError('FORBIDDEN');
    const timestamp = now();
    await db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', taskId);
      const pending = await read(transaction, COLLECTION, task.activeHandoffId);
      if (!current || current.status !== 'awaiting_handoff' || current.activeHandoffId !== task.activeHandoffId || current.assigneeId !== handoff.fromId || !pending || pending.status !== 'submitted') throw new ExecutionError('INVALID_STATE');
      await transaction.collection(COLLECTION).doc(pending._id).update({ data: { status: 'accepted', acceptedBy: openid, acceptedAt: timestamp } });
      await transaction.collection('tasks').doc(taskId).update({ data: { assigneeId: openid, status: 'in_progress', activeHandoffId: '', handoffReady: false, handoffSuccessorId: '', updatedAt: timestamp } });
      await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId, action: 'handoff_accepted', actorId: openid, createdAt: timestamp } });
    });
    return { taskId };
  }

  async function beginUpload(openid, taskId, file) {
    const { task } = await context(openid, taskId);
    const name = file && typeof file.name === 'string' ? file.name.trim() : '';
    const extension = name.split('.').pop().toLowerCase();
    if (!name || name.length > 150 || !Object.prototype.hasOwnProperty.call(EXTENSIONS, extension) || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_SIZE) throw new ExecutionError('INVALID_FILE');
    if ((task.attachmentCount || 0) >= 50 || (await byTask('task_attachment', taskId)).length >= 50) throw new ExecutionError('ATTACHMENT_LIMIT');
    const chunks = Math.ceil(file.size / CHUNK_SIZE);
    const result = await db.collection(COLLECTION).add({ data: { kind: 'execution_upload', taskId, actorId: openid, name, size: file.size, extension, chunks, status: 'pending', createdAt: now() } });
    return { uploadId: result._id, chunkSize: CHUNK_SIZE, chunks };
  }

  async function uploadChunk(openid, uploadId, index, data) {
    const upload = await read(db, COLLECTION, uploadId);
    if (!upload || upload.kind !== 'execution_upload' || upload.actorId !== openid) throw new ExecutionError('NOT_FOUND');
    await context(openid, upload.taskId);
    if (upload.status !== 'pending' || !Number.isInteger(index) || index < 0 || index >= upload.chunks || typeof data !== 'string' || data.length > Math.ceil(CHUNK_SIZE / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new ExecutionError('INVALID_CHUNK');
    const bytes = Buffer.from(data, 'base64');
    const expected = index === upload.chunks - 1 ? upload.size - index * CHUNK_SIZE : CHUNK_SIZE;
    if (bytes.length !== expected) throw new ExecutionError('INVALID_CHUNK');
    await db.collection(COLLECTION).doc(`${uploadId}_${index}`).set({ data: { kind: 'execution_chunk', uploadId, index, data } });
    return { index };
  }

  async function finishUpload(openid, uploadId) {
    const upload = await read(db, COLLECTION, uploadId);
    if (!upload || upload.kind !== 'execution_upload' || upload.actorId !== openid) throw new ExecutionError('NOT_FOUND');
    await context(openid, upload.taskId);
    await db.runTransaction(async transaction => {
      const current = await read(transaction, COLLECTION, uploadId);
      if (!current || current.status !== 'pending') throw new ExecutionError('INVALID_STATE');
      await transaction.collection(COLLECTION).doc(uploadId).update({ data: { status: 'finalizing' } });
    });
    let fileId;
    try {
      const chunks = [];
      for (let start = 0; start < upload.chunks; start += 8) {
        const indexes = Array.from({ length: Math.min(8, upload.chunks - start) }, (_, offset) => start + offset);
        const batch = await Promise.all(indexes.map(index => read(db, COLLECTION, `${uploadId}_${index}`)));
        batch.forEach((chunk, offset) => {
          if (!chunk || chunk.uploadId !== uploadId || chunk.index !== indexes[offset]) throw new ExecutionError('MISSING_CHUNK');
          chunks.push(Buffer.from(chunk.data, 'base64'));
        });
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== upload.size) throw new ExecutionError('INVALID_FILE');
      const cloudPath = `task-attachments/${upload.taskId}/${uploadId}.${upload.extension}`;
      fileId = (await cloud.uploadFile({ cloudPath, fileContent: bytes })).fileID;
      const timestamp = now();
      const result = await db.runTransaction(async transaction => {
        const task = await read(transaction, 'tasks', upload.taskId);
        const current = await read(transaction, COLLECTION, uploadId);
        if (!task || !current || current.status !== 'finalizing' || (task.attachmentCount || 0) >= 50) throw new ExecutionError('ATTACHMENT_LIMIT');
        const attachment = await transaction.collection(COLLECTION).add({ data: { kind: 'task_attachment', taskId: upload.taskId, actorId: openid, name: upload.name, size: upload.size, mimeType: EXTENSIONS[upload.extension], fileId, createdAt: timestamp } });
        await transaction.collection(COLLECTION).add({ data: { kind: 'execution_event', taskId: upload.taskId, action: 'attachment_added', attachmentId: attachment._id, name: upload.name, actorId: openid, createdAt: timestamp } });
        await transaction.collection('tasks').doc(upload.taskId).update({ data: { attachmentCount: (task.attachmentCount || 0) + 1, updatedAt: timestamp } });
        await transaction.collection(COLLECTION).doc(uploadId).update({ data: { status: 'finished', attachmentId: attachment._id } });
        return { attachmentId: attachment._id };
      });
      for (let start = 0; start < upload.chunks; start += 8) {
        const indexes = Array.from({ length: Math.min(8, upload.chunks - start) }, (_, offset) => start + offset);
        const cleanup = await Promise.allSettled(indexes.map(index => db.collection(COLLECTION).doc(`${uploadId}_${index}`).remove()));
        cleanup.filter(result => result.status === 'rejected').forEach(result => console.error('uploaded chunk cleanup failed', result.reason));
      }
      return result;
    } catch (error) {
      if (fileId) await cloud.deleteFile({ fileList: [fileId] });
      await db.collection(COLLECTION).doc(uploadId).update({ data: { status: 'pending' } });
      throw error;
    }
  }

  async function attachmentUrl(openid, attachmentId) {
    const attachment = await read(db, COLLECTION, attachmentId);
    if (!attachment || attachment.kind !== 'task_attachment') throw new ExecutionError('NOT_FOUND');
    await context(openid, attachment.taskId);
    const result = await cloud.getTempFileURL({ fileList: [{ fileID: attachment.fileId, maxAge: 60 }] });
    const url = result.fileList && result.fileList[0] && result.fileList[0].tempFileURL;
    if (!url) throw new ExecutionError('FILE_UNAVAILABLE');
    return { url, name: attachment.name, mimeType: attachment.mimeType };
  }

  return { summary, addNote, setStatus, confirm, returnTask, archive, startHandoff, submitHandoff, acceptHandoff, beginUpload, uploadChunk, finishUpload, attachmentUrl };
}

module.exports = { createService, ExecutionError, CHUNK_SIZE, MAX_SIZE };
