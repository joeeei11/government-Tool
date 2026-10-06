Page({
  data: { loading: false, signedIn: false, sessionReady: false, status: 'guest', name: '', member: null, request: null, members: [], requests: [], error: '', busyId: '', view: 'workbox', tasks: [], shownTasks: [], selectedTask: null, children: [], execution: { records: [], attachments: [], history: [], handoffs: [] }, handoffForm: { currentProgress: '', completedWork: '', unfinishedWork: '', nextAction: '', risks: '', successorId: '', attachmentIds: [] }, pendingHandoff: null, progressText: '', noteText: '', returnReason: '', canAccessExecution: false, canAddNote: false, form: {}, formMembers: [], formParentName: '', editing: false, formMode: 'quick', filter: { status: '', assigneeId: '', type: '', priority: '', due: '' }, filterLabels: { status: '全部状态', assigneeId: '全部负责人', type: '全部类型', priority: '全部优先级', due: '全部日期' }, workbox: {}, reminderConfig: { available: false, templateId: '' }, reminderSubscriptions: { soon: false, overdue: false }, expanded: {}, aiDraft: null, aiContext: '', aiAttachment: null },
  onLoad() { this.setData({ insight: null, insightQuestion: '', insightAnswer: null }); },
  onShow() { if (this.data.signedIn) this.loadSession(); },
  async callOffice(action, payload = {}) {
    const result = await wx.cloud.callFunction({ name: 'office', data: { action, ...payload } });
    if (!result.result || !result.result.ok) {
      const messages = { ADMIN_NOT_CONFIGURED: '管理员尚未配置，请联系项目负责人。', FORBIDDEN: '没有权限执行此操作。', NOT_FOUND: '申请已不存在，请刷新后重试。', OFFICE_FULL: '办公室已满 5 人。', INVALID_NAME: '请输入 2 至 20 个字符的姓名。' };
      throw new Error(messages[result.result && result.result.code] || '操作失败，请稍后重试。');
    }
    return result.result.data;
  },
  async signIn() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }));
      this.setData({ signedIn: true, sessionReady: false });
      await this.loadSession();
    } catch (error) { this.setData({ error: error.message || '微信登录失败，请重试。' }); }
    finally { this.setData({ loading: false }); }
  },
  async loadSession() {
    try {
      const session = await this.callOffice('session');
      this.setData({ sessionReady: true, status: session.status, member: session.member || null, request: session.request || null, name: session.request ? session.request.name : (session.member ? session.member.name : this.data.name), error: '' });
      if (session.status === 'approved') { await this.loadWorkspace(); await this.loadTasks(); await this.loadReminderConfig(); }
    } catch (error) { this.setData({ sessionReady: false, error: error.message || '读取身份失败。' }); }
  },
  onNameInput(event) { this.setData({ name: event.detail.value }); },
  async requestJoin() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try { await this.callOffice('requestJoin', { name: this.data.name.trim() }); await this.loadSession(); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async loadWorkspace() {
    try { const workspace = await this.callOffice('workspace'); this.setData({ members: workspace.members, requests: workspace.requests }); }
    catch (error) { this.setData({ error: error.message }); }
  },
  async callTasks(action, payload = {}) {
    const result = await wx.cloud.callFunction({ name: 'tasks', data: { action, ...payload } });
    if (!result.result || !result.result.ok) {
      const messages = { FORBIDDEN: '没有权限操作任务。', INVALID_TASK: '请检查任务内容。', INVALID_MEMBER: '请选择已加入的办公室成员。', INVALID_PARENT: '上级任务不存在。', DEPTH_LIMIT: '任务最多三级。', NOT_FOUND: '任务不存在，请刷新。', INVALID_STATE: '任务正在交接或已变化，请刷新。' };
      throw new Error(messages[result.result && result.result.code] || '任务操作失败，请稍后重试。');
    }
    return result.result.data;
  },
  async callReminders(action, payload = {}) {
    const result = await wx.cloud.callFunction({ name: 'reminders', data: { action, ...payload } });
    if (!result.result || !result.result.ok) {
      const messages = { FORBIDDEN: '没有权限订阅这项任务。', NOT_FOUND: '任务已变化，请刷新。', NOT_CONFIGURED: '微信提醒暂不可用。', INVALID_EVENT: '提醒时间已过。', ALREADY_SUBSCRIBED: '已订阅这次提醒。' };
      throw new Error(messages[result.result && result.result.code] || '订阅失败，请稍后重试。');
    }
    return result.result.data;
  },
  async loadReminderConfig() {
    try { this.setData({ reminderConfig: await this.callReminders('config') }); }
    catch (_) { this.setData({ reminderConfig: { available: false, templateId: '' } }); }
  },
  async loadReminderSubscriptions(taskId) {
    try {
      const status = await this.callReminders('status', { taskId });
      if (this.data.selectedTask && this.data.selectedTask._id === taskId) this.setData({ reminderSubscriptions: status });
    } catch (_) { /* The task detail remains usable if reminder status is unavailable. */ }
  },
  async subscribeReminder(event) {
    if (this.data.loading || !this.data.selectedTask || !this.data.reminderConfig.available) return;
    const kind = event.currentTarget.dataset.kind;
    if (this.data.reminderSubscriptions[kind]) return;
    const taskId = this.data.selectedTask._id;
    const templateId = this.data.reminderConfig.templateId;
    try {
      const response = await new Promise((resolve, reject) => wx.requestSubscribeMessage({ tmplIds: [templateId], success: resolve, fail: reject }));
      if (response[templateId] !== 'accept') return;
      this.setData({ loading: true, error: '' });
      await this.callReminders('subscribe', { taskId, kind });
      this.setData({ [`reminderSubscriptions.${kind}`]: true });
      wx.showToast({ title: '提醒已订阅', icon: 'success' });
    } catch (error) { this.setData({ error: error.message || '订阅失败，请稍后重试。' }); }
    finally { this.setData({ loading: false }); }
  },
  async callAi(action, payload = {}) {
    const result = await wx.cloud.callFunction({ name: 'ai_tasks', data: { action, ...payload } });
    if (!result.result || !result.result.ok) {
      const messages = { FORBIDDEN: '没有权限使用 AI 拆解。', NOT_FOUND: '任务或建议已不存在。', DEPTH_LIMIT: '第三级任务不能继续拆解。', INVALID_REQUEST: '补充说明或附件内容过长。', EMPTY_SUGGESTIONS: '任务信息不足，请补充背景后重试。', INVALID_SUGGESTIONS: '请检查建议标题、负责人和日期。', INVALID_STATE: '这份建议已处理，请重新生成。', AI_NOT_CONFIGURED: 'AI 服务尚未配置。', AI_SERVICE_ERROR: 'AI 服务暂时不可用，请稍后重试。' };
      throw new Error(messages[result.result && result.result.code] || 'AI 拆解失败，请稍后重试。');
    }
    return result.result.data;
  },
  async callInsights(action, payload = {}) {
    const result = await wx.cloud.callFunction({ name: 'ai_tasks', data: { action: `insight${action[0].toUpperCase()}${action.slice(1)}`, ...payload } });
    if (!result.result || !result.result.ok) {
      const messages = { FORBIDDEN: '没有权限查看分析。', INVALID_QUESTION: '请输入 1 至 300 字的问题。', AI_NOT_CONFIGURED: 'AI 服务尚未配置。', AI_SERVICE_ERROR: 'AI 服务暂时不可用。', NOT_FOUND: '分析记录不存在。' };
      throw new Error(messages[result.result && result.result.code] || '读取分析失败。');
    }
    return result.result.data;
  },
  async loadInsight() {
    try { this.setData({ insight: await this.callInsights('latest') }); }
    catch (error) { this.setData({ error: error.message }); }
  },
  async refreshInsight() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try { this.setData({ insight: await this.callInsights('refresh') }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  insightQuestionInput(event) { this.setData({ insightQuestion: event.detail.value }); },
  async askInsight() {
    if (this.data.loading || !this.data.insightQuestion.trim()) return;
    this.setData({ loading: true, error: '' });
    try { this.setData({ insightAnswer: await this.callInsights('ask', { question: this.data.insightQuestion.trim() }) }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async adoptInsight(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      await this.callInsights('adopt', { id });
      if (this.data.insight && this.data.insight.id === id) this.setData({ 'insight.adopted': true });
      if (this.data.insightAnswer && this.data.insightAnswer.id === id) this.setData({ 'insightAnswer.adopted': true });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async callExecution(action, payload = {}) {
    const result = await wx.cloud.callFunction({ name: 'execution', data: { action, ...payload } });
    if (!result.result || !result.result.ok) {
      const messages = { FORBIDDEN: '没有权限执行此操作。', NOT_FOUND: '记录或文件已不存在。', INVALID_TEXT: '请输入 1 至 2000 字。', INVALID_FILE: '仅支持图片、PDF 和 Word 文件，单个文件不超过 20 MB。', ATTACHMENT_LIMIT: '每个任务最多 50 个附件。', INVALID_STATE: '任务状态已变化，请刷新。', INVALID_HANDOFF: '请填写五项交接内容，每项不超过 2000 字。', INVALID_MEMBER: '请选择有效的接任人。', INVALID_ATTACHMENT: '所选附件已失效，请刷新。', MISSING_CHUNK: '上传不完整，请重试。', FILE_UNAVAILABLE: '文件暂时无法打开。' };
      throw new Error(messages[result.result && result.result.code] || '操作失败，请稍后重试。');
    }
    return result.result.data;
  },
  async loadTasks() {
    try {
      const [tasks, queues] = await Promise.all([this.callTasks('list'), this.callTasks('workbox')]);
      const names = Object.fromEntries(this.data.members.map(person => [person.id, person.name]));
      const decorate = task => ({ ...task, assigneeName: names[task.assigneeId] || '未知成员', creatorName: names[task.creatorId] || '未知成员', collaboratorNames: (task.collaboratorIds || []).map(id => names[id] || '未知成员').join('、') || '无', confirmerName: names[task.confirmerId] || '', statusName: this.statusName(task.status), typeName: this.typeName(task.type), priorityName: this.priorityName(task.priority), deadlineReason: task.deadline ? task.deadline.reason : '' });
      const decorated = tasks.map(decorate);
      this.setData({ tasks: decorated, workbox: Object.fromEntries(Object.entries(queues).map(([key, items]) => [key, items.map(decorate)])), error: '' });
      this.applyFilter();
      if (this.data.selectedTask) this.selectTask(this.data.selectedTask._id);
    } catch (error) { this.setData({ error: error.message || '读取任务失败。' }); }
  },
  statusName(value) { return ({ draft: '草稿', in_progress: '进行中', awaiting_confirmation: '待确认', awaiting_handoff: '待交接', completed: '已完成', archived: '已归档' })[value] || value; },
  typeName(value) { return ({ routine: '日常', special: '专项', urgent: '紧急' })[value] || value; },
  priorityName(value) { return ({ low: '低', normal: '普通', high: '高' })[value] || value; },
  dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; },
  displayTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return `${this.dateKey(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  },
  switchView(event) {
    const view = event.currentTarget.dataset.view;
    this.setData({ view, selectedTask: null, error: '' });
    if (view === 'new') this.startCreate();
    if (view === 'tasks' || view === 'workbox') this.loadTasks();
    if (view === 'insights') this.loadInsight();
  },
  startCreate(event) {
    const parentId = event && event.currentTarget.dataset.parent || '';
    const parent = this.data.tasks.find(task => task._id === parentId);
    this.setData({ view: 'new', editing: false, formMode: 'quick', form: { title: '', description: '', assigneeId: this.data.member.id, collaboratorIds: [], type: 'routine', priority: 'normal', dueDate: '', status: 'in_progress', parentId, confirmationRule: 'ordinary', confirmerId: '' }, formMembers: this.data.members.map(person => ({ ...person, checked: false })), formParentName: parent ? parent.title : '', selectedTask: parent || null, error: '' });
  },
  startEdit() {
    const task = this.data.selectedTask;
    if (!task) return;
    this.setData({ view: 'new', editing: true, formMode: 'detailed', form: { ...task, collaboratorIds: task.collaboratorIds || [] }, formMembers: this.data.members.map(person => ({ ...person, checked: (task.collaboratorIds || []).includes(person.id) })), formParentName: task.parentName || '', error: '' });
  },
  setFormMode(event) { this.setData({ formMode: event.currentTarget.dataset.mode }); },
  formInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  formDate(event) { this.setData({ 'form.dueDate': event.detail.value }); },
  chooseField(event) {
    const { field, value } = event.currentTarget.dataset;
    this.setData({ [`form.${field}`]: value });
    if (field === 'parentId') this.setData({ formParentName: (this.data.tasks.find(task => task._id === value) || {}).title || '' });
  },
  collaboratorsChange(event) { this.setData({ 'form.collaboratorIds': event.detail.value }); },
  async saveTask() {
    if (this.data.loading) return;
    const form = this.data.form;
    if (!form.title.trim()) { this.setData({ error: '请输入任务标题。' }); return; }
    this.setData({ loading: true, error: '' });
    try {
      const payload = { title: form.title.trim(), description: form.description, assigneeId: form.assigneeId, collaboratorIds: form.collaboratorIds, type: form.type, priority: form.priority, dueDate: form.dueDate, confirmationRule: form.confirmationRule, confirmerId: form.confirmerId };
      const result = this.data.editing ? await this.callTasks('update', { id: form._id, task: payload }) : await this.callTasks('create', { task: { ...payload, status: 'in_progress', parentId: form.parentId } });
      await this.loadTasks();
      this.selectTask(result.id);
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  selectTask(eventOrId) {
    const id = typeof eventOrId === 'string' ? eventOrId : eventOrId.currentTarget.dataset.id;
    const task = this.data.tasks.find(item => item._id === id);
    if (!task) return;
    const children = this.data.tasks.filter(item => item.parentId === id);
    const progress = children.length ? Math.round(children.filter(item => ['awaiting_confirmation', 'completed', 'archived'].includes(item.status)).length * 100 / children.length) : (['awaiting_confirmation', 'completed', 'archived'].includes(task.status) ? 100 : 0);
    const canSubscribeReminder = !!task.dueDate && ['in_progress', 'awaiting_handoff'].includes(task.status) && (task.assigneeId === this.data.member.id || (task.collaboratorIds || []).includes(this.data.member.id));
    this.setData({ view: 'detail', selectedTask: { ...task, parentName: (this.data.tasks.find(item => item._id === task.parentId) || {}).title || '无', canSubscribeReminder }, children, execution: { records: [], attachments: [], history: [], handoffs: [] }, handoffForm: { currentProgress: '', completedWork: '', unfinishedWork: '', nextAction: '', risks: '', successorId: '', attachmentIds: [] }, pendingHandoff: null, progressText: `${progress}%`, noteText: '', returnReason: '', canAccessExecution: false, canAddNote: task.assigneeId === this.data.member.id || (task.collaboratorIds || []).includes(this.data.member.id), reminderSubscriptions: { soon: false, overdue: false }, expanded: {}, aiDraft: null, aiContext: '', aiAttachment: null, error: '' });
    if (canSubscribeReminder) this.loadReminderSubscriptions(id);
    this.loadExecution(id);
  },
  async loadExecution(taskId) {
    try {
      const execution = await this.callExecution('summary', { taskId });
      const names = Object.fromEntries(this.data.members.map(member => [member.id, member.name]));
      execution.records = execution.records.map(item => ({ ...item, actorName: names[item.actorId] || '成员', displayTime: this.displayTime(item.createdAt) }));
      execution.attachments = execution.attachments.map(item => ({ ...item, displayTime: this.displayTime(item.createdAt) }));
      execution.history = execution.history.map(item => ({ ...item, actorName: names[item.actorId] || '成员', fromName: this.statusName(item.from), toName: this.statusName(item.to), displayTime: this.displayTime(item.createdAt), actionName: ({ handoff_started: '发起交接', handoff_submitted: '提交交接', handoff_accepted: '确认接收', note_added: '新增执行记录', task_confirmed: '确认任务', task_returned: `退回任务${item.reason ? '：' + item.reason : ''}`, task_archived: '归档任务', draft_deleted: '删除草稿' })[item.action] || '' }));
      execution.handoffs = execution.handoffs.map(item => ({ ...item, fromName: names[item.fromId] || '成员', successorName: names[item.acceptedBy || item.successorId] || '待接任', displayTime: this.displayTime(item.createdAt), attachmentNames: (item.attachmentIds || []).map(id => (execution.attachments.find(file => file._id === id) || {}).name).filter(Boolean).join('、') }));
      const pending = execution.handoffs.find(item => item.status !== 'accepted') || null;
      if (this.data.selectedTask && this.data.selectedTask._id === taskId) this.setData({ execution, pendingHandoff: pending, canAccessExecution: true, progressText: `${execution.progress}%` });
    } catch (error) { this.setData({ error: error.message }); }
  },
  noteInput(event) { this.setData({ noteText: event.detail.value }); },
  handoffInput(event) { this.setData({ [`handoffForm.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  handoffSuccessor(event) { this.setData({ 'handoffForm.successorId': event.currentTarget.dataset.id }); },
  handoffAttachments(event) { this.setData({ 'handoffForm.attachmentIds': event.detail.value }); },
  async startHandoff() {
    if (this.data.loading || !this.data.selectedTask) return;
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('startHandoff', { taskId }); await this.loadTasks(); this.selectTask(taskId); this.setData({ 'expanded.handoff': true }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async submitHandoff() {
    if (this.data.loading || !this.data.selectedTask) return;
    const handoff = this.data.handoffForm;
    if (['currentProgress', 'completedWork', 'unfinishedWork', 'nextAction', 'risks'].some(field => !handoff[field].trim())) { this.setData({ error: '请填写全部五项交接内容。' }); return; }
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('submitHandoff', { taskId, handoff }); await this.loadTasks(); this.selectTask(taskId); this.setData({ 'expanded.handoff': true }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async acceptHandoff() {
    if (this.data.loading || !this.data.selectedTask) return;
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('acceptHandoff', { taskId }); await this.loadTasks(); this.selectTask(taskId); this.setData({ 'expanded.handoff': true }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async addExecutionNote() {
    if (this.data.loading || !this.data.selectedTask) return;
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('addNote', { taskId, text: this.data.noteText }); this.setData({ noteText: '' }); await this.loadExecution(taskId); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async changeExecutionStatus(event) {
    if (this.data.loading || !this.data.selectedTask) return;
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('setStatus', { taskId, status: event.currentTarget.dataset.status }); await this.loadTasks(); this.selectTask(taskId); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  returnReasonInput(event) { this.setData({ returnReason: event.detail.value }); },
  async confirmTask() {
    if (this.data.loading || !this.data.selectedTask) return;
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('confirm', { taskId }); await this.loadTasks(); this.selectTask(taskId); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async returnTask() {
    if (this.data.loading || !this.data.selectedTask) return;
    if (!this.data.returnReason.trim()) { this.setData({ error: '请填写退回原因。' }); return; }
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('returnTask', { taskId, reason: this.data.returnReason }); await this.loadTasks(); this.selectTask(taskId); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async archiveTask() {
    if (this.data.loading || !this.data.selectedTask) return;
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try { await this.callExecution('archive', { taskId }); await this.loadTasks(); this.selectTask(taskId); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  chooseExecutionFile() {
    if (this.data.loading || !this.data.selectedTask) return;
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx'], success: result => this.uploadExecutionFile(result.tempFiles[0]) });
  },
  async uploadExecutionFile(file) {
    if (!file || !this.data.selectedTask) return;
    const taskId = this.data.selectedTask._id;
    this.setData({ loading: true, error: '' });
    try {
      const upload = await this.callExecution('beginUpload', { taskId, file: { name: file.name, size: file.size } });
      const fs = wx.getFileSystemManager();
      for (let index = 0; index < upload.chunks; index++) {
        const length = Math.min(upload.chunkSize, file.size - index * upload.chunkSize);
        const data = await new Promise((resolve, reject) => fs.readFile({ filePath: file.path, encoding: 'base64', position: index * upload.chunkSize, length, success: result => resolve(result.data), fail: reject }));
        await this.callExecution('uploadChunk', { uploadId: upload.uploadId, index, data });
      }
      await this.callExecution('finishUpload', { uploadId: upload.uploadId });
      await this.loadExecution(taskId);
      wx.showToast({ title: '附件已上传', icon: 'success' });
    } catch (error) { this.setData({ error: error.message || '上传失败，请重试。' }); }
    finally { this.setData({ loading: false }); }
  },
  async openExecutionFile(event) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const file = await this.callExecution('attachmentUrl', { attachmentId: event.currentTarget.dataset.id });
      if (file.mimeType.startsWith('image/')) wx.previewImage({ urls: [file.url] });
      else {
        const download = await new Promise((resolve, reject) => wx.downloadFile({ url: file.url, success: resolve, fail: reject }));
        if (download.statusCode !== 200) throw new Error('下载失败，请重试。');
        await new Promise((resolve, reject) => wx.openDocument({ filePath: download.tempFilePath, showMenu: false, success: resolve, fail: reject }));
      }
    } catch (error) { this.setData({ error: error.message || '打开附件失败。' }); }
    finally { this.setData({ loading: false }); }
  },
  aiContextInput(event) { this.setData({ aiContext: event.detail.value }); },
  chooseAiAttachment() {
    wx.chooseMessageFile({ count: 1, type: 'file', extension: ['txt', 'md', 'csv', 'json'], success: result => {
      const file = result.tempFiles[0];
      if (file.size > 9000) { this.setData({ error: '文本附件不能超过 9 KB。' }); return; }
      wx.getFileSystemManager().readFile({ filePath: file.path, encoding: 'utf8', success: content => this.setData({ aiAttachment: { name: file.name, text: content.data }, error: '' }), fail: () => this.setData({ error: '读取附件失败。' }) });
    } });
  },
  clearAiAttachment() { this.setData({ aiAttachment: null }); },
  async generateAi() {
    if (this.data.loading || !this.data.selectedTask) return;
    this.setData({ loading: true, error: '' });
    try {
      const attachment = this.data.aiAttachment;
      const result = await this.callAi('propose', { input: { taskId: this.data.selectedTask._id, description: this.data.aiContext, attachmentText: attachment ? `${attachment.name}\n${attachment.text}` : '' } });
      const names = Object.fromEntries(this.data.members.map(member => [member.id, member.name]));
      this.setData({ aiDraft: { ...result, suggestions: result.suggestions.map((item, index) => ({ ...item, clientId: index, assigneeName: names[item.assigneeId] || '选择负责人' })) } });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  aiInput(event) {
    const { index, field } = event.currentTarget.dataset;
    this.setData({ [`aiDraft.suggestions[${index}].${field}`]: event.detail.value });
  },
  aiDate(event) {
    const index = event.currentTarget.dataset.index;
    this.setData({ [`aiDraft.suggestions[${index}].dueDate`]: event.detail.value });
  },
  clearAiDate(event) {
    const index = event.currentTarget.dataset.index;
    this.setData({ [`aiDraft.suggestions[${index}].dueDate`]: '' });
  },
  aiAssignee(event) {
    const index = event.currentTarget.dataset.index;
    const member = this.data.members[Number(event.detail.value)];
    if (member) this.setData({ [`aiDraft.suggestions[${index}].assigneeId`]: member.id, [`aiDraft.suggestions[${index}].assigneeName`]: member.name });
  },
  removeAiSuggestion(event) {
    const suggestions = this.data.aiDraft.suggestions.filter((_, index) => index !== Number(event.currentTarget.dataset.index));
    this.setData({ 'aiDraft.suggestions': suggestions });
  },
  addAiSuggestion() {
    const suggestions = this.data.aiDraft.suggestions;
    if (suggestions.length >= 8) return;
    this.setData({ 'aiDraft.suggestions': [...suggestions, { clientId: Date.now(), title: '', description: '', assigneeId: this.data.member.id, assigneeName: this.data.member.name, dueDate: '', orderNote: '', risk: '' }] });
  },
  async cancelAi() {
    if (this.data.loading || !this.data.aiDraft) return;
    this.setData({ loading: true, error: '' });
    try { await this.callAi('cancel', { id: this.data.aiDraft.id }); this.setData({ aiDraft: null }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async confirmAi() {
    if (this.data.loading || !this.data.aiDraft) return;
    const { suggestions, id } = this.data.aiDraft;
    if (!suggestions.length || suggestions.some(item => !item.title.trim() || !item.assigneeId)) { this.setData({ error: '至少保留一项建议，并填写标题和负责人。' }); return; }
    this.setData({ loading: true, error: '' });
    try {
      const taskId = this.data.selectedTask._id;
      await this.callAi('confirm', { id, suggestions });
      this.setData({ aiDraft: null });
      await this.loadTasks();
      this.selectTask(taskId);
      this.setData({ 'expanded.children': true });
      wx.showToast({ title: '子任务已创建', icon: 'success' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  toggleSection(event) {
    const section = event.currentTarget.dataset.section;
    this.setData({ [`expanded.${section}`]: !this.data.expanded[section] });
  },
  setFilter(event) {
    const { field, value, label } = event.currentTarget.dataset;
    this.setData({ [`filter.${field}`]: value, [`filterLabels.${field}`]: label });
    this.applyFilter();
  },
  filterDate(event) { this.setData({ 'filter.due': event.detail.value, 'filterLabels.due': event.detail.value }); this.applyFilter(); },
  applyFilter() {
    const filter = this.data.filter;
    const today = this.dateKey(new Date());
    const shownTasks = this.data.tasks.filter(task =>
      (!filter.status || task.status === filter.status) &&
      (!filter.assigneeId || task.assigneeId === filter.assigneeId) &&
      (!filter.type || task.type === filter.type) &&
      (!filter.priority || task.priority === filter.priority) &&
      (!filter.due || (filter.due === 'overdue' ? !!task.dueDate && task.dueDate < today && !['completed', 'archived'].includes(task.status) : task.dueDate === filter.due))
    );
    this.setData({ shownTasks });
  },
  async review(event) {
    if (this.data.busyId) return;
    const { id, decision } = event.currentTarget.dataset;
    this.setData({ busyId: id, error: '' });
    try { await this.callOffice('review', { id, decision }); await this.loadWorkspace(); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busyId: '' }); }
  },
  refresh() { this.loadSession(); }
});
