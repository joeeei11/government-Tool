Page({
  data: { loading: false, signedIn: false, sessionReady: false, status: 'guest', name: '', member: null, request: null, members: [], requests: [], error: '', busyId: '' },
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
      if (session.status === 'approved') await this.loadWorkspace();
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
