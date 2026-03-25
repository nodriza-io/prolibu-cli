const axios = require('axios');

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function listCustomFields(domain, apiKey, query = {}) {
  const qs = new URLSearchParams({ limit: 100, ...query }).toString();
  const { data } = await axios.get(`https://${domain}/v2/customfield?${qs}`, {
    headers: headers(apiKey),
  });
  return data;
}

async function getCustomField(domain, apiKey, id) {
  const { data } = await axios.get(`https://${domain}/v2/customfield/${id}`, {
    headers: headers(apiKey),
  });
  return data;
}

async function createCustomField(domain, apiKey, body) {
  const { data } = await axios.post(`https://${domain}/v2/customfield`, body, {
    headers: headers(apiKey),
  });
  return data;
}

async function updateCustomField(domain, apiKey, id, body) {
  const { data } = await axios.patch(`https://${domain}/v2/customfield/${id}`, body, {
    headers: headers(apiKey),
  });
  return data;
}

async function deleteCustomField(domain, apiKey, id) {
  const { data } = await axios.delete(`https://${domain}/v2/customfield/${id}`, {
    headers: headers(apiKey),
  });
  return data;
}

module.exports = {
  listCustomFields,
  getCustomField,
  createCustomField,
  updateCustomField,
  deleteCustomField,
};
