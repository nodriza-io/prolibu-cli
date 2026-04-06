/**
 * Salesforce-specific axios error handler following Prolibu pattern.
 * Handles token invalidation detection and Salesforce-specific error formats.
 *
 * @param {Error} err - The axios error object
 * @param {string} [context='Salesforce operation'] - Description of the operation for error message
 * @throws {Error} - Throws an error with a meaningful message and statusCode
 */
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

  const salesforceError = new Error(`${context} failed: ${errorMessage}`);
  salesforceError.statusCode = statusCode;
  throw salesforceError;
}

module.exports = {
  handleSalesforceAxiosError
};