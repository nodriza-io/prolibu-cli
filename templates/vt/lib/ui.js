/**
 * Modern CLI UI Utilities
 * 
 * Provides spinners, progress bars, tables, and styled output
 */

const cliProgress = require('cli-progress');
const Table = require('cli-table3');

// Colors using ANSI codes (works without ESM chalk issues)
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
    bgBlue: '\x1b[44m',
    bgGreen: '\x1b[42m',
    bgRed: '\x1b[41m',
    bgYellow: '\x1b[43m',
    bgMagenta: '\x1b[45m',
};

const c = {
    bold: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
    red: (text) => `${colors.red}${text}${colors.reset}`,
    green: (text) => `${colors.green}${text}${colors.reset}`,
    yellow: (text) => `${colors.yellow}${text}${colors.reset}`,
    blue: (text) => `${colors.blue}${text}${colors.reset}`,
    magenta: (text) => `${colors.magenta}${text}${colors.reset}`,
    cyan: (text) => `${colors.cyan}${text}${colors.reset}`,
    white: (text) => `${colors.white}${text}${colors.reset}`,
    success: (text) => `${colors.green}✓${colors.reset} ${text}`,
    error: (text) => `${colors.red}✗${colors.reset} ${text}`,
    warning: (text) => `${colors.yellow}⚠${colors.reset} ${text}`,
    info: (text) => `${colors.blue}ℹ${colors.reset} ${text}`,
};

/**
 * Spinner frames for custom spinner
 */
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Simple spinner class
 */
class Spinner {
    constructor(text = '') {
        this.text = text;
        this.frameIndex = 0;
        this.interval = null;
        this.stream = process.stderr;
    }

    start(text) {
        if (text) this.text = text;
        this.interval = setInterval(() => {
            const frame = spinnerFrames[this.frameIndex];
            this.stream.write(`\r${colors.cyan}${frame}${colors.reset} ${this.text}`);
            this.frameIndex = (this.frameIndex + 1) % spinnerFrames.length;
        }, 80);
        return this;
    }

    update(text) {
        this.text = text;
    }

    succeed(text) {
        this.stop();
        console.log(`${colors.green}✓${colors.reset} ${text || this.text}`);
    }

    fail(text) {
        this.stop();
        console.log(`${colors.red}✗${colors.reset} ${text || this.text}`);
    }

    warn(text) {
        this.stop();
        console.log(`${colors.yellow}⚠${colors.reset} ${text || this.text}`);
    }

    info(text) {
        this.stop();
        console.log(`${colors.blue}ℹ${colors.reset} ${text || this.text}`);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            this.stream.write('\r\x1b[K'); // Clear line
        }
    }
}

/**
 * Create a new spinner
 */
function createSpinner(text) {
    return new Spinner(text);
}

/**
 * Create a progress bar
 */
function createProgressBar(options = {}) {
    const {
        format = ' {bar} {percentage}% | {value}/{total} | {task}',
        barCompleteChar = '█',
        barIncompleteChar = '░',
        hideCursor = true,
        clearOnComplete = false,
    } = options;

    return new cliProgress.SingleBar({
        format: `${colors.cyan}${format}${colors.reset}`,
        barCompleteChar,
        barIncompleteChar,
        hideCursor,
        clearOnComplete,
        stopOnComplete: true,
    }, cliProgress.Presets.shades_classic);
}

/**
 * Create a multi-progress bar
 */
function createMultiProgressBar() {
    return new cliProgress.MultiBar({
        format: ' {bar} {percentage}% | {value}/{total} | {task}',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: true,
    }, cliProgress.Presets.shades_classic);
}

/**
 * Print a styled header box
 */
function printHeader(title, subtitle = '') {
    const width = 60;
    const line = '═'.repeat(width);

    console.log('');
    console.log(`${colors.cyan}╔${line}╗${colors.reset}`);
    console.log(`${colors.cyan}║${colors.reset}${colors.bright}${centerText(title, width)}${colors.reset}${colors.cyan}║${colors.reset}`);
    if (subtitle) {
        console.log(`${colors.cyan}║${colors.reset}${colors.dim}${centerText(subtitle, width)}${colors.reset}${colors.cyan}║${colors.reset}`);
    }
    console.log(`${colors.cyan}╚${line}╝${colors.reset}`);
    console.log('');
}

/**
 * Print a section header
 */
function printSection(title, icon = '📦') {
    console.log('');
    console.log(`${colors.bright}${colors.white}  ${icon}  ${title}${colors.reset}`);
    console.log(`${colors.dim}  ${'─'.repeat(56)}${colors.reset}`);
}

/**
 * Print tour processing header
 */
function printTourHeader(tourName, index, total) {
    console.log('');
    console.log(`${colors.bgBlue}${colors.white}${colors.bright}                                                            ${colors.reset}`);
    console.log(`${colors.bgBlue}${colors.white}${colors.bright}  Tour ${index}/${total}: ${tourName.padEnd(43)}${colors.reset}`);
    console.log(`${colors.bgBlue}${colors.white}${colors.bright}                                                            ${colors.reset}`);
}

/**
 * Create a results table
 */
function createResultsTable(results) {
    const table = new Table({
        head: [
            `${colors.cyan}${colors.bright}Tour${colors.reset}`,
            `${colors.cyan}${colors.bright}Status${colors.reset}`,
            `${colors.cyan}${colors.bright}Scenes${colors.reset}`,
            `${colors.cyan}${colors.bright}Colors${colors.reset}`,
            `${colors.cyan}${colors.bright}Details${colors.reset}`
        ],
        colWidths: [25, 10, 10, 10, 30],
        style: {
            head: [],
            border: ['dim']
        },
        chars: {
            'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
            'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
            'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
            'right': '│', 'right-mid': '┤', 'middle': '│'
        }
    });

    for (const r of results) {
        const status = r.success
            ? `${colors.green}✓ OK${colors.reset}`
            : `${colors.red}✗ FAIL${colors.reset}`;

        const scenes = r.success ? String(r.scenesCount || 0) : '-';
        const colorCount = r.success ? String(r.colorsCount || 0) : '-';
        const details = r.success
            ? `${colors.dim}ID: ${(r.virtualTourId || '')}${colors.reset}`
            : `${colors.red}${truncate(r.error || 'Unknown error', 28)}${colors.reset}`;

        table.push([
            truncate(r.tour, 23),
            status,
            scenes,
            colorCount,
            details
        ]);
    }

    return table.toString();
}

/**
 * Print summary box
 */
function printSummary(successful, failed, totalTime) {
    const width = 58;

    console.log('');
    console.log(`${colors.dim}┌${'─'.repeat(width)}┐${colors.reset}`);
    console.log(`${colors.dim}│${colors.reset}${colors.bright}${centerText('📊 SUMMARY', width)}${colors.reset}${colors.dim}│${colors.reset}`);
    console.log(`${colors.dim}├${'─'.repeat(width)}┤${colors.reset}`);

    const successLine = `  ${colors.green}✓${colors.reset} Successful: ${successful}`;
    const failLine = `  ${colors.red}✗${colors.reset} Failed: ${failed}`;
    const timeLine = `  ⏱  Time: ${formatTime(totalTime)}`;

    console.log(`${colors.dim}│${colors.reset}${successLine.padEnd(width + 14)}${colors.dim}│${colors.reset}`);
    console.log(`${colors.dim}│${colors.reset}${failLine.padEnd(width + 14)}${colors.dim}│${colors.reset}`);
    console.log(`${colors.dim}│${colors.reset}${timeLine.padEnd(width + 5)}${colors.dim}│${colors.reset}`);
    console.log(`${colors.dim}└${'─'.repeat(width)}┘${colors.reset}`);
}

/**
 * Print a key-value info line
 */
function printInfo(key, value, icon = '•') {
    console.log(`  ${colors.dim}${icon}${colors.reset} ${colors.dim}${key}:${colors.reset} ${value}`);
}

/**
 * Print success message
 */
function printSuccess(message) {
    console.log(`  ${colors.green}✓${colors.reset} ${message}`);
}

/**
 * Print error message
 */
function printError(message) {
    console.log(`  ${colors.red}✗${colors.reset} ${message}`);
}

/**
 * Print warning message
 */
function printWarning(message) {
    console.log(`  ${colors.yellow}⚠${colors.reset} ${colors.dim}${message}${colors.reset}`);
}

/**
 * Helper: Center text in a given width
 */
function centerText(text, width) {
    const padding = Math.max(0, width - text.length);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
}

/**
 * Helper: Truncate text
 */
function truncate(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
}

/**
 * Helper: Format time in seconds
 */
function formatTime(ms) {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Clear the current line
 */
function clearLine() {
    process.stdout.write('\r\x1b[K');
}

/**
 * Move cursor up
 */
function moveCursorUp(lines = 1) {
    process.stdout.write(`\x1b[${lines}A`);
}

module.exports = {
    colors,
    c,
    Spinner,
    createSpinner,
    createProgressBar,
    createMultiProgressBar,
    printHeader,
    printSection,
    printTourHeader,
    createResultsTable,
    printSummary,
    printInfo,
    printSuccess,
    printError,
    printWarning,
    centerText,
    truncate,
    formatTime,
    clearLine,
    moveCursorUp,
};
