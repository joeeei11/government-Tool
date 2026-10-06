const cloud = require('wx-server-sdk');
const { createService, ExecutionError } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async event => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, code: 'FORBIDDEN' };
  try {
    const service = createService(cloud.database(), cloud, () => new Date().toISOString());
    const actions = {
      summary: () => service.summary(openid, event.taskId),
      addNote: () => service.addNote(openid, event.taskId, event.text),
      setStatus: () => service.setStatus(openid, event.taskId, event.status),
      confirm: () => service.confirm(openid, event.taskId),
      returnTask: () => service.returnTask(openid, event.taskId, event.reason),
      archive: () => service.archive(openid, event.taskId),
      startHandoff: () => service.startHandoff(openid, event.taskId),
      submitHandoff: () => service.submitHandoff(openid, event.taskId, event.handoff),
      acceptHandoff: () => service.acceptHandoff(openid, event.taskId),
      beginUpload: () => service.beginUpload(openid, event.taskId, event.file),
      uploadChunk: () => service.uploadChunk(openid, event.uploadId, event.index, event.data),
      finishUpload: () => service.finishUpload(openid, event.uploadId),
      attachmentUrl: () => service.attachmentUrl(openid, event.attachmentId)
    };
    if (!Object.prototype.hasOwnProperty.call(actions, event.action)) throw new ExecutionError('INVALID_ACTION');
    return { ok: true, data: await actions[event.action]() };
  } catch (error) {
    if (error instanceof ExecutionError) return { ok: false, code: error.code };
    console.error('execution function failed', error);
    return { ok: false, code: 'INTERNAL_ERROR' };
  }
};
