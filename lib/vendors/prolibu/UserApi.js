const { handleAxiosError } = require('./utils');

class UserApi {
  constructor({ domain, apiKey }) {
    if (!domain) domain = localDomain;
    if (!apiKey) throw new Error('apiKey is required');
    let baseURL = domain;
    if (!/^https?:\/\//.test(baseURL)) {
      baseURL = `https://${baseURL}`;
    }
    this.prefix = '/v2';
    this.axios = axios.create({
      baseURL,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  async me() {
    try {
      const response = await this.axios.get(`${this.prefix}/user/me`);
      return response.data;
    } catch (err) {
      throw handleAxiosError(err);
    }
  }

  async switchWorkspace(workspaceId) {
    try {
      const response = await this.axios.put(`${this.prefix}/workspace/switch`, {
        workspaceId
      });
      return response.data;
    } catch (err) {
      throw handleAxiosError(err);
    }
  }
}

module.exports = UserApi;
