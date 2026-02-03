const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const config = require('../config/config');

/**
 * Format axios error for user-friendly display
 */
function formatAxiosError(err, context = '') {
  if (err.response?.data) {
    const data = err.response.data;
    if (data.error) {
      let message = `❌ ${context ? context + ': ' : ''}${data.error}`;
      if (data.details?.code) {
        message += ` (${data.details.code})`;
      }
      return message;
    }
    return `❌ ${context ? context + ': ' : ''}${err.response.statusText || 'Request failed'} (${err.response.status})`;
  }
  return `❌ ${context ? context + ': ' : ''}${err.message}`;
}

/**
 * Check if plugin exists, create if not
 * @returns {Object|null} Plugin data including _id, or null if failed
 */
async function ensurePluginExists(domain, apiKey, pluginCode) {
  const checkUrl = `https://${domain}/v2/plugin/${pluginCode}`;

  try {
    const response = await axios.get(checkUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      console.log(`Plugin '${pluginCode}' not found. Creating...`);

      try {
        const createUrl = `https://${domain}/v2/plugin`;
        const createResponse = await axios.post(createUrl, {
          pluginCode,
          pluginName: pluginCode,
          active: true,
          readme: '# Plugin created via CLI',
          variables: [],
        }, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        });

        console.log(`Plugin '${pluginCode}' created successfully!`);
        return createResponse.data;
      } catch (createError) {
        console.error(`Failed to create plugin '${pluginCode}':`, createError.response?.data || createError.message);
        return null;
      }
    }

    console.error(`Error checking plugin '${pluginCode}':`, error.response?.data || error.message);
    return null;
  }
}

/**
 * PATCH field to /v2/plugin/{pluginCode}
 * If field is 'package' and value is a file path, uploads the ZIP with multipart/form-data
 */
async function patchPlugin(domain, apiKey, pluginCode, value, field) {
  const url = `https://${domain}/v2/plugin/${pluginCode}`;
  try {
    let response;
    if (field === 'package' && typeof value === 'string' && fs.existsSync(value)) {
      // Upload package ZIP using multipart/form-data
      const formData = new FormData();
      formData.append('package', fs.createReadStream(value), {
        filename: path.basename(value),
        contentType: 'application/zip'
      });

      response = await axios.patch(url, formData, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
    } else {
      // Regular JSON patch
      response = await axios.patch(url, { [field]: value }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });
    }
    return response.data;
  } catch (err) {
    console.error(formatAxiosError(err, `Failed to update ${field} for ${pluginCode}`));
  }
}

/**
 * POST initial plugin document to /v2/plugin
 */
async function createPluginDoc(domain, apiKey, pluginCode, pluginName, extra = {}) {
  const url = `https://${domain}/v2/plugin`;
  try {
    const body = {
      pluginCode,
      pluginName,
      active: true,
      ...extra
    };
    const response = await axios.post(url, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    return response.data;
  } catch (err) {
    console.error(`Failed to create plugin ${pluginCode}:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Search for existing plugin by name
 */
async function searchPlugin(domain, apiKey, searchTerm) {
  const url = `https://${domain}/v2/plugin/search`;

  try {
    const response = await axios.get(url, {
      params: { searchTerm, term: searchTerm },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    return response.data;
  } catch (err) {
    console.error(`Failed to search plugin:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Upload plugin icon separately
 */
async function uploadPluginIcon(domain, apiKey, pluginCode, iconPath) {
  const url = `https://${domain}/v2/plugin/${pluginCode}`;

  try {
    const formData = new FormData();
    formData.append('icon', fs.createReadStream(iconPath), {
      filename: path.basename(iconPath),
      contentType: iconPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    });

    await axios.patch(url, formData, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...formData.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  } catch (err) {
    console.error(formatAxiosError(err, `Failed to upload icon for ${pluginCode}`));
  }
}

module.exports = {
  ensurePluginExists,
  patchPlugin,
  createPluginDoc,
  uploadPluginIcon,
  searchPlugin,
};
