const axios = require('axios');
const { handleAxiosError } = require('./utils');

function stringify(obj, key) {
  if (obj?.[key]) {
    obj[key] = JSON.stringify(obj[key]);
  }
}

function validateId(id) {
  if (!id || typeof id !== 'string') {
    throw new Error(`Invalid id "${id}". It must be a string.`);
  }
}

class ProlibuApi {
  constructor({ domain, apiKey }) {
    if (!domain) throw new Error('domain is required');
    if (!apiKey) throw new Error('apiKey is required');
    this.prefix = '/v2';
    let baseURL = domain;
    if (!/^https?:\/\//.test(baseURL)) {
      baseURL = `https://${baseURL}`;
    }
    this.axios = axios.create({
      baseURL,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'user-agent': 'ProlibuApi',
      },
    });
  }

  async create(modelName, data) {
    try {
      const response = await this.axios.post(`${this.prefix}/${modelName}`, data);
      return response.data;
    } catch (err) {
      throw handleAxiosError(err);
    }
  }

  async findOne(modelName, id, queryParams = {}) {
    validateId(id);
    try {
      stringify(queryParams, 'populatePath');
      const queryString = new URLSearchParams(queryParams).toString();
      const response = await this.axios.get(`${this.prefix}/${modelName}/${id}?${queryString}`);
      return response.data;
    } catch (err) {
      // Return null for 404 (not found) instead of throwing error
      if (err.response && err.response.status === 404) {
        return null;
      }
      // For any other error, still throw
      throw handleAxiosError(err);
    }
  }

  async find(modelName, queryParams = {}) {
    try {
      stringify(queryParams, 'populatePath');
      stringify(queryParams, 'xquery');
      const queryString = new URLSearchParams(queryParams).toString();
      const response = await this.axios.get(`${this.prefix}/${modelName}?${queryString}`);
      return response.data;
    } catch (err) {
      throw handleAxiosError(err);
    }
  }

  async update(modelName, id, data) {
    validateId(id);
    try {
      const response = await this.axios.patch(`${this.prefix}/${modelName}/${id}`, data);
      return response.data;
    } catch (err) {
      throw handleAxiosError(err);
    }
  }

  async delete(modelName, id) {
    validateId(id);
    try {
      const response = await this.axios.delete(`${this.prefix}/${modelName}/${id}`);
      // 204 No Content = success, 200 OK = success
      return response.status === 204 || response.status === 200;
    } catch (err) {
      // If 404 (not found), return false instead of throwing
      if (err.response && err.response.status === 404) {
        return false;
      }
      // For any other error, still throw
      throw handleAxiosError(err);
    }
  }

  async search(modelName, term, queryParams = {}) {
    try {
      stringify(queryParams, 'populatePath');
      stringify(queryParams, 'xquery');
      const queryString = new URLSearchParams({ ...queryParams, term }).toString();
      const response = await this.axios.get(`${this.prefix}/${modelName}/search?${queryString}`);
      return response.data;
    } catch (err) {
      throw handleAxiosError(err);
    }
  }

  /**
   * Find one or create: looks up by external field, creates if not found, updates if exists.
   * @param {string} entity - Model name (e.g., 'Contact', 'Product')
   * @param {string} externalValue - Value to search for (e.g., Salesforce ID)
   * @param {object} options - Options object with { field: 'fieldName' }
   * @param {object} data - Data to create or update
   * @returns {Promise<{record: object, created: boolean}>}
   */
  async findOneOrCreate(entity, externalValue, options = {}, data) {
    if (!data) {
      throw new Error(`Data as fourth argument is required when using findOneOrCreate`);
    }

    const fieldName = options.field || 'externalId';

    // Search for existing record by external field using find with filter
    const filter = { [fieldName]: externalValue };
    const xquery = JSON.stringify(filter);

    const results = await this.find(entity, { xquery, limit: 1 });
    const existingRecords = results.data || results;

    if (existingRecords && existingRecords.length > 0) {
      // Record exists, update it
      const existingRecord = existingRecords[0];
      const record = await this.update(entity, existingRecord._id, data);
      return { record, created: false };
    }

    // Record doesn't exist, create it
    const record = await this.create(entity, data);
    return { record, created: true };
  }
}

module.exports = ProlibuApi;