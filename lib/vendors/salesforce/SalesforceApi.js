/* global eventData, eventName, env, variables, axios, setVariable */

// In the Prolibu server environment axios is injected as a global.
// When running in CLI/local mode, fall back to the npm package.
if (typeof axios === 'undefined') {
  global.axios = require('axios');
}

function idRequired(id) {
  if (!id) {
    throw new Error('"id" is required for this operation');
  }
}

// Salesforce-specific axios error handler following Prolibu pattern
function handleSalesforceAxiosError(err, context = 'Salesforce operation') {
  let errorMessage = 'Unknown error';
  let errorDetails = null;
  let shouldInvalidateToken = false;
  let errorType = 'unknown';
  let statusCode = null;

  if (err.response) {
    // Error de respuesta del servidor (4xx, 5xx)
    errorType = 'http';
    statusCode = err.response.status;
    errorMessage = err.response.statusText || 'HTTP error';

    // Check for token invalidation scenarios
    if (err.response.data) {
      // Check for INVALID_SESSION_ID or similar authentication errors
      if (Array.isArray(err.response.data) && err.response.data.length > 0) {
        const firstError = err.response.data[0];
        if (firstError.errorCode === 'INVALID_SESSION_ID' ||
          firstError.errorCode === 'INVALID_LOGIN' ||
          firstError.errorCode === 'SESSION_EXPIRED') {
          shouldInvalidateToken = true;
          console.log(`🔑 Detected token invalidation error: ${firstError.errorCode}`);
        }
      }
    }

    // Salesforce-specific error handling
    if (err.response.data) {
      errorDetails = err.response.data;

      // Salesforce returns different error formats
      if (Array.isArray(err.response.data) && err.response.data[0]) {
        // Format: [{ "message": "...", "errorCode": "..." }]
        const firstError = err.response.data[0];
        errorMessage = firstError.message || firstError.errorCode || errorMessage;

        // Específicamente para errores de SOQL
        if (firstError.errorCode === 'MALFORMED_QUERY') {
          errorMessage = `SOQL Query Error: ${firstError.message}`;
        }
      } else if (err.response.data.error_description) {
        // OAuth error format
        errorMessage = err.response.data.error_description;
      } else if (err.response.data.error) {
        // Generic error format
        errorMessage = err.response.data.error;
      } else if (err.response.data.message) {
        // Standard message format
        errorMessage = err.response.data.message;
      }
    }
  } else if (err.request) {
    // No hubo respuesta del servidor
    errorType = 'network';
    errorMessage = 'No response from server';
  } else {
    // Error de configuración o desconocido
    errorType = 'config';
    errorMessage = err.message || 'Unknown error';
  }

  // En lugar de crear y retornar un Error object, lanzar directamente
  // para que el sistema de logging lo capture correctamente como mensaje
  const salesforceError = new Error(`${context} failed: ${errorMessage}`);
  salesforceError.statusCode = statusCode;
  throw salesforceError;
}

class SalesforceApi {
  constructor({ instanceUrl, customerKey, customerSecret, apiVersion = '58.0' } = {}) {
    if (!instanceUrl) throw new Error('instanceUrl is required');
    if (!customerKey) throw new Error('customerKey is required');
    if (!customerSecret) throw new Error('customerSecret is required');

    // Store credentials
    this.customerKey = customerKey;
    this.customerSecret = customerSecret;
    this.apiVersion = apiVersion;
    const env = instanceUrl.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '-');
    this.tokenKey = `salesforce-token-${env}`;

    // Check if we're running in Prolibu server environment
    this.isServerEnvironment = typeof globalThis.setVariable === 'function' && typeof globalThis.variables !== 'undefined';

    // Initialize token value based on environment
    if (this.isServerEnvironment) {
      // Server environment - use variables array
      const tokenFound = globalThis.variables.find(v => v.key === this.tokenKey);
      this.tokenValue = tokenFound ? JSON.parse(tokenFound.value) : null;
    } else {
      // Local/test environment - use memory cache only
      this.tokenValue = null;
    }
    this.instanceUrl = instanceUrl;

    // Token refresh buffer - refresh token 5 minutes before expiration
    this.TOKEN_REFRESH_BUFFER = 5 * 60 * 1000; // 5 minutes in milliseconds

    // Auto-retry configuration
    this.retryOnTokenError = true;
    this.maxRetries = 1; // Only retry once to avoid infinite loops

    // tokenValue format:
    // {
    //   "access_token": "22DgL000001MrZq!AQEAQtUHbzPJ3VZWhPZsg67DZjxS1W.ybZ0A3fRkIYO0nd4P6wUM26NBOpS1d_vSzoQ1zuXEEhKKWZRlvlJTjL.R6yAmdh_9",
    //   "signature": "1TNITuAHY791/hCBo3VVRwIK8/u96ydnIhAtFK9Xk+M=",
    //   "scope": "api",
    //   "instance_url": "https://orgfarm-0000000000-dev-ed.develop.my.salesforce.com",
    //   "id": "https://login.salesforce.com/id/10DgL000001MrZqUAK/005gL000001A3TvQAK",
    //   "token_type": "Bearer",
    //   "issued_at": "1758578068457"
    // }

    // Setup URLs - use .my.salesforce.com for OAuth
    let baseURL = instanceUrl;
    if (!/^https?:\/\//.test(baseURL)) {
      baseURL = `https://${baseURL}`;
    }

    // For OAuth, ensure we use .my.salesforce.com
    this.authUrl = baseURL.replace('.lightning.force.com', '.my.salesforce.com');

    // Create axios instance for salesforce API calls
    this.axios = axios.create({
      baseURL: baseURL, // This will be updated after auth
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    // Authentication state
    this.accessToken = null;
    this.authenticated = false;
  }

  // Enhanced authentication method with smart token caching
  async authenticate() {
    try {
      // Check if we have a valid cached token
      if (await this.isTokenValid()) {
        this.accessToken = this.tokenValue.access_token;
        this.authenticated = true;
        this.updateAxiosHeaders();
        return this.accessToken;
      }

      // Token is expired or doesn't exist, get a new one
      return await this.refreshToken();

    } catch (err) {
      // If refresh fails, clear cache and throw error
      await this.clearTokenCache();
      const errorObj = handleSalesforceAxiosError(err, 'Authentication');
      throw errorObj;
    }
  }

  // Check if current token is valid and not near expiration
  async isTokenValid() {
    if (!this.tokenValue || !this.tokenValue.access_token || !this.tokenValue.issued_at) {
      return false;
    }

    const now = Date.now();
    const issuedAt = parseInt(this.tokenValue.issued_at);

    // Salesforce tokens typically expire after 2 hours (7200 seconds)
    // But we'll be conservative and refresh after 1.5 hours (5400 seconds)
    const tokenLifetime = 5400 * 1000; // 1.5 hours in milliseconds
    const expirationTime = issuedAt + tokenLifetime;
    const refreshTime = expirationTime - this.TOKEN_REFRESH_BUFFER;

    const isValid = now < refreshTime;

    return isValid;
  }

  // Get new token and cache it
  async refreshToken() {
    try {
      // Make the OAuth request
      const response = await axios.post(`${this.authUrl}/services/oauth2/token`,
        `grant_type=client_credentials&client_id=${encodeURIComponent(this.customerKey)}&client_secret=${encodeURIComponent(this.customerSecret)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
        }
      );

      // Cache the token response
      const tokenResponse = {
        ...response.data,
        cached_at: Date.now() // Add our own timestamp for better tracking
      };

      // Save to variables cache (only in server environment)
      if (this.isServerEnvironment) {
        await globalThis.setVariable(this.tokenKey, JSON.stringify(tokenResponse));
      }

      // Update instance state
      this.tokenValue = tokenResponse;
      this.accessToken = tokenResponse.access_token;
      this.authenticated = true;

      // Update axios configuration
      this.updateAxiosConfiguration(response.data);
      return this.accessToken;

    } catch (err) {
      const errorObj = handleSalesforceAxiosError(err, 'Salesforce token refresh');
      console.log('❌ Token refresh failed:', errorObj.toString());
      throw errorObj;
    }
  }

  // Update axios instance configuration
  updateAxiosConfiguration(tokenData) {
    // Update base URL if provided
    if (tokenData.instance_url) {
      this.axios.defaults.baseURL = tokenData.instance_url;
    }

    // Update authorization header
    this.updateAxiosHeaders();
  }

  // Update axios headers with current token
  updateAxiosHeaders() {
    if (this.accessToken) {
      this.axios.defaults.headers.Authorization = `Bearer ${this.accessToken}`;
    }
  }

  // Clear token cache
  async clearTokenCache() {
    try {
      // Clear server environment cache
      if (this.isServerEnvironment) {
        await globalThis.setVariable(this.tokenKey, '');
      } else {
        console.log('🔧 Token cache cleared from memory (local environment)');
      }

      this.tokenValue = null;
      this.accessToken = null;
      this.authenticated = false;

      // Remove authorization header
      delete this.axios.defaults.headers.Authorization;

    } catch (err) {
      const errorObj = handleSalesforceAxiosError(err, 'Clear token cache');
      console.log('Warning: Failed to clear token cache:', errorObj.toString());
    }
  }

  // Handle token invalidation from error responses
  async handleTokenInvalidation(errorObj) {
    if (errorObj.shouldInvalidateToken) {
      console.log('🔑 Token invalidated by Salesforce, clearing cache...');
      await this.clearTokenCache();
      return true; // Indicates token was invalidated
    }
    return false;
  }

  // Execute method with automatic token retry
  async executeWithRetry(operation, context = 'Operation') {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      try {
        return await operation();
      } catch (err) {
        const salesforceError = handleSalesforceAxiosError(err, context);

        // Check if we should retry due to token invalidation
        if (this.retryOnTokenError && attempt < this.maxRetries) {
          const tokenInvalidated = await this.handleTokenInvalidation(salesforceError);

          if (tokenInvalidated) {
            attempt++;
            continue; // Retry the operation
          }
        }

        // If no retry or max retries reached, throw the error
        throw salesforceError;
      }
    }
  }

  // Method to force token refresh (useful for testing or manual refresh)
  async forceRefresh() {
    await this.clearTokenCache();
    return await this.authenticate();
  }

  // Method to get token info for debugging
  getTokenInfo() {
    if (!this.tokenValue) {
      return { status: 'No token cached' };
    }

    const now = Date.now();
    const issuedAt = parseInt(this.tokenValue.issued_at);
    const tokenLifetime = 5400 * 1000; // 1.5 hours
    const expirationTime = issuedAt + tokenLifetime;
    const timeUntilExpiration = expirationTime - now;

    return {
      status: 'Token cached',
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expirationTime).toISOString(),
      timeUntilExpiration: `${Math.round(timeUntilExpiration / 1000 / 60)} minutes`,
      isValid: timeUntilExpiration > this.TOKEN_REFRESH_BUFFER
    };
  }

  getRefUrl(objectName, docId) {
    return `https://${this.instanceUrl}/lightning/r/${objectName}/${docId}/view`;
  }

  getRefData(objectName, docId) {
    if (!objectName) {
      throw new Error('"objectName" is required to get refData');
    }
    if (!docId) {
      throw new Error('"docId" is required to get refData');
    }
    return {
      refId: docId,
      refUrl: this.getRefUrl(objectName, docId)
    };
  }

  /**
   * Creates a new Salesforce record and returns the complete created object
   * 
   * @param {string} sobjectType - Salesforce object type (e.g., 'Contact', 'Account', 'Opportunity')
   * @param {Object} data - Record data to create (field-value pairs)
   * 
   * @returns {Promise<Object>} Complete created record with all fields (standardized with ProlibuApi)
   * 
   * @throws {Error} For validation errors, permission issues, or network problems
   * 
   * @example
   * // Create a new contact
   * const newContact = await sfApi.create('Contact', {
   *   FirstName: 'Jane',
   *   LastName: 'Smith',
   *   Email: 'jane.smith@example.com',
   *   Phone: '+1-555-0123',
   *   AccountId: '001XXXXXXXXXXXX'
   * });
   * console.log('Created contact:', newContact);
   * // Returns: { Id: '003XXX', FirstName: 'Jane', LastName: 'Smith', Email: '...', CreatedDate: '...', ... }
   * 
   * @example
   * // Create an opportunity with required fields
   * const opportunity = await sfApi.create('Opportunity', {
   *   Name: 'Q4 Software License Deal',
   *   AccountId: '001XXXXXXXXXXXX',
   *   StageName: 'Prospecting',
   *   CloseDate: '2024-12-31',
   *   Amount: 50000,
   *   Probability: 25
   * });
   * console.log('Created opportunity:', opportunity);
   * 
   * @example
   * // Handle creation with error checking
   * try {
   *   const result = await sfApi.create('Account', {
   *     Name: 'Acme Corporation',
   *     Industry: 'Technology',
   *     Type: 'Prospect'
   *   });
   *   
   *   console.log('Account created successfully:', result);
   * } catch (error) {
   *   console.error('Failed to create account:', error.message);
   * }
   */
  async create(sobjectType, data) {
    const createResult = await this.executeWithRetry(async () => {
      // Ensure authenticated
      if (!this.authenticated) {
        await this.authenticate();
      }

      // Create the record using POST
      const response = await this.axios.post(`/services/data/v${this.apiVersion}/sobjects/${sobjectType}`, data, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }
      });

      return response.data; // { id: '003XXX', success: true, errors: [] }
    }, 'Create record');

    // Fetch the complete created object (all fields) to match ProlibuApi behavior
    if (createResult.success) {
      const response = await this.axios.get(
        `/services/data/v${this.apiVersion}/sobjects/${sobjectType}/${createResult.id}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json',
          }
        }
      );
      return response.data; // Complete object with all fields
    }

    throw new Error('Create failed');
  }

  /**
   * Queries Salesforce records using SOQL or object-based options
   * 
   * @param {string} sobjectType - Salesforce object type (e.g., 'Contact', 'Account', 'Opportunity')
   * @param {string|Object} options - SOQL query string OR query options object
   * 
   * When options is a string:
   * - Used directly as SOQL query
   * 
   * When options is an object:
   * - Reserved fields (select, limit, sort, page) are used for query structure
   * - All other fields go to WHERE clause as equality conditions
   * 
   * @param {string} [options.select='Id'] - Comma-separated field names to select
   * @param {number} [options.limit=100] - Maximum number of records to return
   * @param {string} [options.sort] - ORDER BY clause (e.g., 'CreatedDate DESC')
   * @param {number} [options.page=1] - Page number for pagination
   * @param {*} [options.*] - Any other field becomes a WHERE condition (e.g., Email: 'test@example.com')
   * 
   * @returns {Promise<Object>} Standardized response with pagination and data
   * @returns {Object} returns.pagination - Pagination metadata
   * @returns {number} returns.pagination.count - Total records matching query
   * @returns {number} returns.pagination.page - Current page number
   * @returns {number} returns.pagination.limit - Records per page
   * @returns {number} returns.pagination.lastPage - Total number of pages
   * @returns {number} returns.pagination.startIndex - Zero-based offset
   * @returns {Array} returns.data - Array of matching records
   * 
   * @example
   * // String query (direct SOQL)
   * const result = await sfApi.find('Contact', 
   *   "SELECT Id, Name FROM Contact WHERE Email != null LIMIT 10"
   * );
   * 
   * @example
   * // Object with WHERE conditions
   * const result = await sfApi.find('Contact', {
   *   select: 'Id, Name, Email',
   *   FirstName: 'John',        // → WHERE FirstName = 'John' AND
   *   LastName: 'Doe',          // → LastName = 'Doe' AND  
   *   Email: { $exists: true }, // → Email != null
   *   limit: 10,
   *   sort: 'CreatedDate DESC',
   *   page: 1
   * });
   * 
   * @example
   * // Response format:
   * // {
   * //   "pagination": {
   * //     "count": 351,
   * //     "page": 1,
   * //     "limit": 40,
   * //     "lastPage": 9,
   * //     "startIndex": 0
   * //   },
   * //   "data": [
   * //     { "Id": "003XXX", "Name": "John Doe", "Email": "john@example.com" }
   * //   ]
   * // }
   */
  async find(sobjectType, options = {}) {
    return await this.executeWithRetry(async () => {
      if (!this.authenticated) {
        await this.authenticate();
      }

      let soql;
      let page = 1;
      let limit = 100; // default

      // CASE 1: options is a string - use directly as SOQL
      if (typeof options === 'string') {
        soql = options;

        // Try to extract LIMIT from SOQL string for pagination calculation
        const limitMatch = soql.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) {
          limit = parseInt(limitMatch[1]);
        }
      }
      // CASE 2: options is an object - build SOQL from it
      else if (typeof options === 'object') {
        // Extract reserved fields (select, limit, sort, page)
        const {
          select,
          limit: queryLimit,
          sort,
          page: queryPage,
          ...whereFields // Everything else goes to WHERE
        } = options;

        // Set pagination params
        limit = queryLimit || 100;
        page = queryPage || 1;
        const offset = (page - 1) * limit;

        // Build SELECT clause
        let selectClause = select || 'Id';
        if (typeof selectClause === 'string') {
          selectClause = selectClause.replace(/\s+/g, ',').replace(/,+/g, ',');
        }
        soql = `SELECT ${selectClause} FROM ${sobjectType}`;

        // Build WHERE clause from remaining fields
        if (Object.keys(whereFields).length > 0) {
          const conditions = Object.entries(whereFields).map(([field, value]) => {
            return this.buildWhereCondition(field, value);
          });

          if (conditions.length > 0) {
            soql += ` WHERE ${conditions.join(' AND ')}`;
          }
        }

        // Add ORDER BY
        if (sort) {
          soql += ` ORDER BY ${sort}`;
        }

        // Add LIMIT and OFFSET for pagination
        soql += ` LIMIT ${limit}`;
        if (offset > 0) {
          soql += ` OFFSET ${offset}`;
        }
      }

      // Execute query
      const response = await this.axios.get(
        `/services/data/v${this.apiVersion}/query?q=${encodeURIComponent(soql)}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json',
          }
        }
      );

      // Transform to standardized format (like ProlibuApi)
      const totalSize = response.data.totalSize || 0;
      const lastPage = Math.ceil(totalSize / limit);

      return {
        pagination: {
          count: totalSize,
          page: page,
          limit: limit,
          lastPage: lastPage || 1,
          startIndex: (page - 1) * limit,
        },
        data: response.data.records || []
      };
    }, 'Query');
  }

  /**
   * Helper to build WHERE conditions with operators
   * Supports Prolibu-style operators like $exists, $ne, etc.
   */
  buildWhereCondition(field, value) {
    // Handle Prolibu-style operators
    if (typeof value === 'object' && value !== null) {
      // $exists operator
      if (value.$exists !== undefined) {
        return value.$exists ? `${field} != null` : `${field} = null`;
      }

      // $ne (not equal) operator
      if (value.$ne !== undefined) {
        if (value.$ne === null) {
          return `${field} != null`;
        }
        const val = typeof value.$ne === 'string'
          ? `'${value.$ne.replace(/'/g, "\\'")}'`
          : value.$ne;
        return `${field} != ${val}`;
      }

      // $gt (greater than) operator
      if (value.$gt !== undefined) {
        const val = typeof value.$gt === 'string'
          ? `'${value.$gt.replace(/'/g, "\\'")}'`
          : value.$gt;
        return `${field} > ${val}`;
      }

      // $lt (less than) operator
      if (value.$lt !== undefined) {
        const val = typeof value.$lt === 'string'
          ? `'${value.$lt.replace(/'/g, "\\'")}'`
          : value.$lt;
        return `${field} < ${val}`;
      }

      // $in operator (IN clause)
      if (value.$in !== undefined && Array.isArray(value.$in)) {
        const values = value.$in.map(v => {
          if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
          return v;
        }).join(', ');
        return `${field} IN (${values})`;
      }
    }

    // Simple equality conditions
    if (value === null) {
      return `${field} = null`;
    }

    if (typeof value === 'string') {
      return `${field} = '${value.replace(/'/g, "\\'")}'`;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return `${field} = ${value}`;
    }

    // Default: convert to string
    return `${field} = '${String(value).replace(/'/g, "\\'")}'`;
  }

  /**
   * Retrieves a single Salesforce record by its unique ID
   * 
   * @param {string} sobjectType - Salesforce object type (e.g., 'Contact', 'Account', 'Opportunity') 
   * @param {string} id - Salesforce record ID (15 or 18 character format)
   * @param {Object} options - Field selection options
   * @param {string} [options.select='Id'] - Comma-separated field names to retrieve
   * 
   * @returns {Promise<Object|null>} Record data if found, null if record doesn't exist (404)
   * 
   * @throws {Error} For invalid parameters, authentication failures, or other API errors (excluding 404)
   * 
   * @example
   * // Get basic contact information
   * const contact = await sfApi.findOne('Contact', '003XXXXXXXXXXXX');
   * 
   * @example
   * // Get specific fields from an opportunity
   * const opportunity = await sfApi.findOne('Opportunity', '006XXXXXXXXXXXX', {
   *   select: 'Id, Name, StageName, Amount, CloseDate, AccountId'
   * });
   * 
   * @example
   * // Handle case when record doesn't exist
   * const contact = await sfApi.findOne('Contact', 'invalid_id');
   * if (contact === null) {
   *   console.log('Contact not found');
   * } else {
   *   console.log('Found contact:', contact.FirstName, contact.LastName);
   * }
   * 
   * @example
   * // Example response when record exists:
   * // {
   * //   "Id": "003XXXXXXXXXXXX",
   * //   "FirstName": "John", 
   * //   "LastName": "Doe",
   * //   "Email": "john.doe@example.com"
   * // }
   */
  async findOne(sobjectType, id, options = {}) {
    try {
      return await this.executeWithRetry(async () => {
        // Ensure authenticated
        if (!this.authenticated) {
          await this.authenticate();
        }

        idRequired(id);

        // Build field list
        let select = options.select || 'Id';
        if (typeof select === 'string') {
          // replace spaces with commas and remove duplicate commas
          select = select.replace(/\s+/g, ',').replace(/,+/g, ',');
        }

        // Use the retrieve API endpoint for single record by ID
        const response = await this.axios.get(`/services/data/v${this.apiVersion}/sobjects/${sobjectType}/${id}?fields=${encodeURIComponent(select)}`, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json',
          }
        });

        return response.data;
      }, 'Find single record');
    } catch (err) {
      // Return null for 404 (not found) instead of throwing error
      if (err.statusCode === 404) {
        return null;
      }
      // For any other error, still throw
      throw err;
    }
  }

  /**
   * Updates an existing Salesforce record and returns the complete updated object
   * 
   * @param {string} sobjectType - Salesforce object type (e.g., 'Contact', 'Account', 'Opportunity')
   * @param {string} id - Salesforce record ID to update (15 or 18 character)
   * @param {Object} data - Updated field values (only changed fields need to be included)
   * @param {Object} [options] - Additional options
   * @param {string} [options.select] - Comma-separated field names to return (default: returns all fields)
   * 
   * @returns {Promise<Object>} Complete updated record object (standardized with ProlibuApi)
   * 
   * @throws {Error} For validation errors, record not found, permission issues, or network problems
   * 
   * @example
   * // Update contact information and get complete updated record
   * const updatedContact = await sfApi.update('Contact', '003XXXXXXXXXXXX', {
   *   Phone: '+1-555-9876',
   *   Email: 'john.doe.updated@example.com',
   *   MailingCity: 'San Francisco'
   * });
   * console.log('Updated contact:', updatedContact);
   * // Returns: { Id: '003XXX', FirstName: 'John', LastName: 'Doe', Phone: '+1-555-9876', Email: '...', ... }
   * 
   * @example
   * // Update opportunity stage and amount
   * const updatedOpp = await sfApi.update('Opportunity', '006XXXXXXXXXXXX', {
   *   StageName: 'Negotiation/Review',
   *   Amount: 75000,
   *   Probability: 80,
   *   CloseDate: '2024-03-15'
   * });
   * 
   * @example
   * // Update with specific fields to return
   * const updatedAccount = await sfApi.update('Account', '001XXXXXXXXXXXX', 
   *   {
   *     Industry: 'Healthcare',
   *     NumberOfEmployees: 500,
   *     AnnualRevenue: 10000000
   *   },
   *   { select: 'Id, Name, Industry, NumberOfEmployees, AnnualRevenue' }
   * );
   * 
   * @example
   * // Conditional update with error handling
   * try {
   *   const accountId = '001XXXXXXXXXXXX';
   *   const updates = {
   *     Industry: 'Healthcare',
   *     NumberOfEmployees: 500,
   *     AnnualRevenue: 10000000
   *   };
   *   
   *   const updated = await sfApi.update('Account', accountId, updates);
   *   console.log('Account updated successfully:', updated);
   * } catch (error) {
   *   if (error.message.includes('404')) {
   *     console.error('Account not found');
   *   } else {
   *     console.error('Update failed:', error.message);
   *   }
   * }
   */
  async update(sobjectType, id, data, options = {}) {
    await this.executeWithRetry(async () => {
      // Ensure authenticated
      if (!this.authenticated) {
        await this.authenticate();
      }

      idRequired(id);

      // Update the record using PATCH
      await this.axios.patch(`/services/data/v${this.apiVersion}/sobjects/${sobjectType}/${id}`, data, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }
      });

      // Salesforce returns 204 No Content for successful updates
    }, 'Update record');

    // Fetch and return the updated object to match ProlibuApi behavior
    if (options.select) {
      // If specific fields requested, use findOne with select
      return await this.findOne(sobjectType, id, { select: options.select });
    } else {
      // Get all fields using direct GET endpoint (no field parameter = all fields)
      const response = await this.axios.get(
        `/services/data/v${this.apiVersion}/sobjects/${sobjectType}/${id}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json',
          }
        }
      );
      return response.data; // Complete object with all fields
    }
  }

  /**
   * Permanently deletes a Salesforce record by its unique ID
   * 
   * @param {string} sobjectType - Salesforce object type (e.g., 'Contact', 'Account', 'Opportunity')
   * @param {string} id - Salesforce record ID to delete (15 or 18 character format)
   * 
   * @returns {Promise<boolean>} true if deleted successfully, false if record not found (404)
   * 
   * @throws {Error} For invalid ID, permission issues, or network problems (but NOT for 404)
   * 
   * @example
   * // Delete a contact record
   * const deleted = await sfApi.delete('Contact', '003XXXXXXXXXXXX');
   * if (deleted) {
   *   console.log('Record deleted successfully');
   * } else {
   *   console.log('Record not found');
   * }
   * 
   * @example
   * // Delete an opportunity
   * const success = await sfApi.delete('Opportunity', '006XXXXXXXXXXXX');
   * 
   * @warning This operation is permanent and cannot be undone unless your Salesforce org has the Recycle Bin feature enabled
   * 
   * @see {@link https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_delete.htm|Salesforce REST API Delete Documentation}
   */
  async delete(sobjectType, id) {
    try {
      await this.executeWithRetry(async () => {
        // Ensure authenticated
        if (!this.authenticated) {
          await this.authenticate();
        }

        idRequired(id);

        // Delete the record using DELETE
        await this.axios.delete(`/services/data/v${this.apiVersion}/sobjects/${sobjectType}/${id}`, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json',
          }
        });

        // Salesforce returns 204 No Content for successful deletions
      }, 'Delete record');

      return true; // Delete succeeded
    } catch (err) {
      // If 404 (not found), return false instead of throwing
      if (err.statusCode === 404 || (err.message && err.message.includes('404'))) {
        return false;
      }
      // For any other error, still throw
      throw err;
    }
  }
}

module.exports = SalesforceApi;
