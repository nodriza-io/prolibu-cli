// Utility to format cookies for socket.io-client
function formatCookie(cookieObj) {
  return Object.entries(cookieObj)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

module.exports = { formatCookie };
