const { handleAxiosError } = require('./utils');

class DeviceApi {
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
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10 seconds timeout
      maxRedirects: 5, // Follow redirects like curl --location
    });
  }

  /**
   * Trigger a device command
   * @param {Object} params - Trigger parameters
   * @param {string} params.serialNumber - Device serial number (e.g., "144ACB")
   * @param {string} params.command - Command to execute (e.g., "play")
   * @param {Object} params.timing - Timing configuration
   * @param {string} params.timing.sequence - Sequence name (e.g., "Machine Gun")
   * @returns {Promise<Object>} Response data
   */
  async trigger({ serialNumber, command, timing }) {
    console.log(`🔔 1-----Triggering device ${serialNumber} with command ${command}`);
    console.log(`📍 URL: ${this.axios.defaults.baseURL}${this.prefix}/device/trigger`);
    console.log(`📦 Payload:`, { serialNumber, command, timing });
    
    const startTime = Date.now();
    
    try {
      console.log('⏳ Sending POST request...');
      
      const response = await this.axios.post(`${this.prefix}/device/trigger`, {
        serialNumber,
        command,
        timing,
      }, {
        timeout: 5000, // Override timeout to 5 seconds for this specific request
      });
      
      const elapsed = Date.now() - startTime;
      console.log(`✅ 2-----Device ${serialNumber} triggered successfully (${elapsed}ms)`);
      console.log(`📄 Response:`, response.data);
      return response.data;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.error(`❌ -----Failed to trigger device ${serialNumber} after ${elapsed}ms`);
      console.error(`📛 Error message:`, err.message);
      console.error(`📛 Error code:`, err.code);
      console.error(`📛 Error status:`, err.response?.status);
      console.error(`📛 Error data:`, err.response?.data);
      throw handleAxiosError(err);
    }
  }
}

module.exports = DeviceApi;
