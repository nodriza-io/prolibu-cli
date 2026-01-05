const io = require('socket.io-client');

// Color and styling utilities
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
};

// Log type configurations
const logTypes = {
  log: {
    color: colors.cyan,
    label: 'CONSOLE LOG',
    border: '-'
  },
  error: {
    color: colors.red,
    label: 'CONSOLE ERROR',
    border: '-'
  },
  warn: {
    color: colors.yellow,
    label: 'CONSOLE WARN',
    border: '-'
  },
  info: {
    color: colors.blue,
    label: 'CONSOLE INFO',
    border: '-'
  }
};

function formatLogHeader(type, timestamp) {
  const config = logTypes[type] || logTypes.log;
  const friendly = timestamp.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });

  const header = `[${config.label}] [${friendly}]`;
  const separator = config.border.repeat(50);

  return `\n${config.color}${colors.bright}${header}${colors.reset}\n${config.color}${separator}${colors.reset}`;
}

function formatErrorStack(errorObj) {
  if (!errorObj || typeof errorObj !== 'object' || !errorObj.error || !errorObj.stack) {
    return errorObj;
  }

  // Format as natural JavaScript error output
  let output = `${colors.red}${errorObj.error}${colors.reset}\n`;

  if (typeof errorObj.stack === 'string') {
    const stackLines = errorObj.stack.split('\n');

    for (const line of stackLines) {
      const trimmedLine = line.trim();

      // Skip empty lines
      if (!trimmedLine) continue;

      // Handle "at line X:Y" format
      if (trimmedLine.startsWith('at line')) {
        output += `${colors.gray}    at ${trimmedLine.replace('at line ', 'line ')}${colors.reset}\n`;
        continue;
      }

      // Handle evalmachine references
      if (trimmedLine.startsWith('evalmachine')) {
        output += `${colors.gray}    at ${trimmedLine}${colors.reset}\n`;
        continue;
      }

      // Handle code snippets (indented lines that contain actual code)
      if (trimmedLine && !trimmedLine.startsWith('at ')) {
        // This looks like actual code, show it with slight indentation
        output += `${colors.dim}        ${trimmedLine}${colors.reset}\n`;
      }
    }
  }

  return output.trim();
}

function printLogContent(payload, logType) {
  if (payload && typeof payload === 'object') {
    // Handle message content
    if ('message' in payload) {
      if (logType === 'error') {
        console.log(`${colors.red}${payload.message}${colors.reset}`);
      } else if (logType === 'warn') {
        console.log(`${colors.yellow}${payload.message}${colors.reset}`);
      } else if (logType === 'info') {
        console.log(`${colors.blue}${payload.message}${colors.reset}`);
      } else {
        console.log(`${colors.cyan}${payload.message}${colors.reset}`);
      }
    }

    // Handle single object - check for stack formatting
    if ('object' in payload) {
      if (payload.object && payload.object.error && payload.object.stack) {
        // Format as natural error stack
        console.log(formatErrorStack(payload.object));
      } else {
        // Regular object formatting
        console.dir(payload.object, {
          depth: null,
          colors: true,
          compact: false
        });
      }
    }

    // Handle multiple objects
    if ('objects' in payload && Array.isArray(payload.objects)) {
      payload.objects.forEach((obj, i) => {
        if (payload.objects.length > 1) {
          console.log(`${colors.gray}[Object ${i + 1}]${colors.reset}`);
        }

        if (obj && obj.error && obj.stack) {
          // Format as natural error stack
          console.log(formatErrorStack(obj));
        } else {
          // Regular object formatting
          console.dir(obj, {
            depth: null,
            colors: true,
            compact: false
          });
        }
      });
    }

    // Handle unknown payload structure
    if (!('message' in payload) && !('object' in payload) && !('objects' in payload)) {
      try {
        const pretty = JSON.stringify(payload, null, 2);
        console.log(pretty);
      } catch {
        console.dir(payload, { depth: null, colors: true });
      }
    }
    return;
  }

  // Fallback for non-object payloads
  try {
    const pretty = JSON.stringify(payload, null, 2);
    console.log(pretty);
  } catch {
    console.dir(payload, { depth: null, colors: true });
  }
}

function listenScriptLog(domain, scriptName, env, apiKey, onConnect) {
  const scriptCode = `${scriptName}-${env}`;
  const channel = `scriptLog-${scriptCode}`;
  const originUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  console.log(`[SOCKET] Attempting to connect to: ${originUrl}`);
  console.log(`[SOCKET] Using domain: ${domain}`);
  console.log(`[SOCKET] Using channel: ${channel}`);

  let isFirstConnection = true;

  const socket = io(originUrl, {
    transports: ['websocket'],
    auth: {
      apiKey,
      channels: [channel],
    },
  });

  socket.on('connect', () => {
    if (isFirstConnection) {
      console.log(`[SOCKET] Connected to ${originUrl}`);
      console.log(`[SOCKET] Connected to channel: private-${domain}-${channel}`);
      isFirstConnection = false;
      if (typeof onConnect === 'function') onConnect();
    } else {
      console.log(`${colors.green}[SOCKET] Reconnected to ${originUrl}${colors.reset}`);
    }
  });

  // socket.onAny((eventName, ...args) => {
  //   console.log(`[SOCKET ON ANY] Event: ${eventName}`, args);
  // });

  // Handle specific log type events
  socket.on('log', (payload) => {
    const timestamp = new Date();
    console.log(formatLogHeader('log', timestamp));
    printLogContent(payload, 'log');
  });

  socket.on('error', (payload) => {
    const timestamp = new Date();
    console.log(formatLogHeader('error', timestamp));
    printLogContent(payload, 'error');
  });

  socket.on('warn', (payload) => {
    const timestamp = new Date();
    console.log(formatLogHeader('warn', timestamp));
    printLogContent(payload, 'warn');
  });

  socket.on('info', (payload) => {
    const timestamp = new Date();
    console.log(formatLogHeader('info', timestamp));
    printLogContent(payload, 'info');
  });

  // Capture raw console output (lifecycle events, etc)
  socket.on('console', (payload) => {
    const { type = 'log', message } = payload;
    if (message) {
      const timestamp = new Date();
      console.log(formatLogHeader(type, timestamp));
      console.log(message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`${colors.red}[SOCKET] Disconnected${colors.reset}`);
  });

  socket.on('connect_error', (err) => {
    console.error(`${colors.gray}[SOCKET] Connection error: ${err.message} ${colors.reset}`);
  });

  // Debug: Log all socket events
  socket.onAny((eventName, ...args) => {
    if (!['log', 'error', 'warn', 'info', 'console', 'connect', 'disconnect', 'msg'].includes(eventName)) {
      console.log(`${colors.gray}[SOCKET EVENT] ${eventName}:${colors.reset}`, args);
    }
  });
}

module.exports = { listenScriptLog };
