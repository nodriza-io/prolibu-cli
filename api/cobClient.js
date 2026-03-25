const axios = require('axios');

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function listCobs(domain, apiKey, query = {}) {
  const qs = new URLSearchParams({ limit: 100, ...query }).toString();
  const { data } = await axios.get(`https://${domain}/v2/cob?${qs}`, {
    headers: headers(apiKey),
  });
  return data;
}

async function getCob(domain, apiKey, id) {
  const { data } = await axios.get(`https://${domain}/v2/cob/${id}`, {
    headers: headers(apiKey),
  });
  return data;
}

async function createCob(domain, apiKey, body) {
  const { data } = await axios.post(`https://${domain}/v2/cob`, body, {
    headers: headers(apiKey),
  });
  return data;
}

async function updateCob(domain, apiKey, id, body) {
  const { data } = await axios.patch(`https://${domain}/v2/cob/${id}`, body, {
    headers: headers(apiKey),
  });
  return data;
}

async function deleteCob(domain, apiKey, id) {
  const { data } = await axios.delete(`https://${domain}/v2/cob/${id}`, {
    headers: headers(apiKey),
  });
  return data;
}

module.exports = {
  listCobs,
  getCob,
  createCob,
  updateCob,
  deleteCob,
};
