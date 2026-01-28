// EventManager.js - Professional event orchestration system for sandboxed VM environments
// 
// ARCHITECTURE OVERVIEW:
// =====================
// The EventManager is designed to handle event-driven workflows in restricted JavaScript environments
// such as VM sandboxes where traditional event systems may fail due to security constraints.
//
// KEY FEATURES:
// - Async/Await Support: Properly handles asynchronous event handlers with Promise resolution
// - Sandbox Compatibility: Works within restricted VM contexts with limited global access
// - Error Resilience: Multiple error handling strategies (immediate, delayed, silent)
// - Simple API: Two-method pattern - register with on(), execute with init()
//
// WORKFLOW PATTERN:
// 1. Register event handlers using on(eventName, handler)
// 2. Call await init() to execute matching handlers based on global eventName
// 3. All async handlers are properly awaited before init() resolves
//
// USAGE EXAMPLE:
// const Event = require('./EventManager');
// Event.on('ApiRun', async () => { /* async work */ });
// await Event.init(); // Waits for all handlers to complete

class EventManager {
  constructor() {
    // Core event storage: Maps event names to arrays of handler functions
    this.handlers = {};
    
    // Error handling strategy: 'immediate' throws immediately, 'delayed' uses setTimeout, 'silent' ignores
    this.errorMode = 'immediate';
    
    // Tracks the currently executing event name for debugging and state management
    this.currentEventName = null;
    
    // Prevents multiple init() calls from executing handlers multiple times
    this.isInitialized = false;
  }

  /**
   * Registers an event handler for a specific event name
   * 
   * ARCHITECTURE: This method stores handlers in a Map-like structure where each event name
   * maps to an array of handler functions. Handlers can be synchronous or asynchronous.
   * 
   * @param {string} eventName - The name of the event to listen for
   * @param {function} handler - The function to execute when the event fires (sync or async)
   * @returns {EventManager} - Returns this for method chaining
   */
  on(eventName, handler) {
    const modelName = eventName.split('.')[0];
    // check if modelName is different to 'ApiRun'
    if (modelName !== 'ApiRun' && modelName !== 'EndpointRequest' && modelName !== 'ScheduledTask') {
      // If lifecycleHooks is defined globally, use it to filter events
      if (!lifecycleHooks.includes(modelName)) {
        console.log(`[WARN] Handler for event "${eventName}" ignored - model "${modelName}" not in lifecycleHooks: ${JSON.stringify(lifecycleHooks)}`);
        return this; // Skip registering this handler
      }
    }
    // Initialize handler array for this event if it doesn't exist
    if (!this.handlers[eventName]) {
      this.handlers[eventName] = [];
    }
    
    // Add the handler to the event's handler list
    this.handlers[eventName].push(handler);
    
    return this; // Enable method chaining: Event.on('A', fn).on('B', fn)
  }

  /**
   * Executes all handlers for a specific event with full async support
   * 
   * ARCHITECTURE: This is the core execution engine. It processes handlers sequentially,
   * properly awaiting async functions to ensure complete execution before proceeding.
   * This guarantees that all async work is finished before init() resolves.
   * 
   * @param {string} eventName - The event whose handlers should be executed
   * @param {object} payload - Optional data to pass to handlers (default: {})
   * @returns {EventManager} - Returns this for method chaining
   */
  async triggerImmediate(eventName, payload = {}) {
    // Early exit if no handlers registered for this event
    if (!this.handlers[eventName] || this.handlers[eventName].length === 0) {
      return this;
    }
    
    // Execute each handler sequentially to maintain order and proper error handling
    for (let i = 0; i < this.handlers[eventName].length; i++) {
      const handler = this.handlers[eventName][i];
      
      try {
        const result = handler(payload);
        
        // CRITICAL: Check if handler returned a Promise and await it
        // This ensures async handlers complete fully before continuing
        if (result && typeof result.then === 'function') {
          await result;
        }
      } catch (error) {
        // Delegate error handling to configurable error strategy
        this.handleError(error, eventName, i + 1);
      }
    }
    
    return this;
  }

  /**
   * Synchronous event trigger with async error handling compatibility
   * 
   * ARCHITECTURE: This method provides synchronous event execution while still handling
   * async errors through setTimeout. It's used for scenarios where await cannot be used
   * but async error propagation is still needed.
   * 
   * WARNING: Async handlers will not be awaited - they run fire-and-forget style.
   * Use triggerImmediate() instead when you need to wait for async completion.
   * 
   * @param {string} eventName - The event whose handlers should be executed
   * @param {object} payload - Optional data to pass to handlers (default: {})
   * @returns {EventManager} - Returns this for method chaining
   */
  triggerImmediateSync(eventName, payload = {}) {
    // Early exit if no handlers registered for this event
    if (!this.handlers[eventName] || this.handlers[eventName].length === 0) {
      return this;
    }
    
    // Execute handlers synchronously (async handlers run fire-and-forget)
    for (let i = 0; i < this.handlers[eventName].length; i++) {
      const handler = this.handlers[eventName][i];
      
      try {
        const result = handler(payload);
        
        // Handle async functions with fire-and-forget error handling
        if (result && typeof result.then === 'function') {
          result.catch(error => {
            // Use setTimeout to propagate async errors in sandbox environment
            setTimeout(() => { throw error; }, 0);
            
            // Also use configurable error handling strategy
            this.handleError(error, eventName, i + 1);
            
            // Immediate throw for synchronous error propagation
            throw error;
          });
        }
      } catch (error) {
        // Handle synchronous errors immediately
        this.handleError(error, eventName, i + 1);
      }
    }
    
    return this;
  }

  /**
   * Configurable error handling system for sandbox environments
   * 
   * ARCHITECTURE: Provides multiple error handling strategies to work around sandbox
   * limitations. Some sandboxes don't propagate async errors properly, so we provide
   * immediate, delayed, and silent modes.
   * 
   * @param {Error} error - The error that occurred during handler execution
   * @param {string} eventName - The event name where the error occurred
   * @param {number} handlerIndex - The index of the handler that failed (for debugging)
   */
  handleError(error, eventName, handlerIndex) {
    // Store error information globally for debugging and monitoring
    if (typeof global !== 'undefined') {
      global.__lastEventError = {
        event: eventName,
        handler: handlerIndex,
        error: error.message,
        stack: error.stack,
        timestamp: Date.now()
      };
    }

    // Apply the configured error handling strategy
    switch (this.errorMode) {
      case 'immediate':
        // Throw immediately - best for development and testing
        throw error;
        
      case 'delayed':
        // Use setTimeout to bypass sandbox async error limitations
        setTimeout(() => { throw error; }, 0);
        break;
        
      case 'silent':
        // Ignore errors - useful for production where you want graceful degradation
        break;
        
      default:
        // Default to immediate throwing for safety
        throw error;
    }
  }



  /**
   * Configures the error handling strategy
   * 
   * @param {string} mode - 'immediate', 'delayed', or 'silent'
   * @returns {EventManager} - Returns this for method chaining
   */
  setErrorMode(mode) {
    this.errorMode = mode;
    return this;
  }

  /**
   * Removes a specific handler from an event
   * 
   * @param {string} eventName - The event to remove the handler from
   * @param {function} handler - The specific handler function to remove
   * @returns {EventManager} - Returns this for method chaining
   */
  off(eventName, handler) {
    if (this.handlers[eventName]) {
      this.handlers[eventName] = this.handlers[eventName].filter(h => h !== handler);
    }
    return this;
  }

  /**
   * Removes all event handlers from all events
   * 
   * @returns {EventManager} - Returns this for method chaining
   */
  clear() {
    this.handlers = {};
    return this;
  }

  /**
   * Returns comprehensive statistics about registered events and handlers
   * 
   * @returns {object} - Object containing events count, total handlers, and detailed event list
   */
  getStats() {
    const events = Object.keys(this.handlers);
    const totalHandlers = events.reduce((sum, event) => sum + this.handlers[event].length, 0);
    
    return {
      events: events.length,
      totalHandlers,
      eventList: events.map(event => ({
        event,
        handlerCount: this.handlers[event].length
      }))
    };
  }

  /**
   * Returns a list of all registered events with their handler counts
   * 
   * @returns {Array} - Array of objects with event names and handler counts
   */
  getEvents() {
    return Object.keys(this.handlers).map(event => ({
      event,
      handlerCount: this.handlers[event].length
    }));
  }

  /**
   * Initializes and executes event handlers - THE CORE ORCHESTRATION METHOD
   * 
   * ARCHITECTURE: This is the heart of the EventManager. It reads the global 'eventName'
   * variable from the sandbox context and executes all registered handlers for that event.
   * The method uses async/await to ensure ALL handlers complete before resolving.
   * 
   * WORKFLOW:
   * 1. Prevents double initialization (idempotent)
   * 2. Reads eventName from sandbox global context
   * 3. Executes all matching handlers sequentially with full async support
   * 4. Returns only when all async work is complete
   * 
   * @returns {Promise<void>} - Resolves when all event handlers have completed
   */
  async init() {
    // Prevent multiple calls from executing handlers multiple times
    if (this.isInitialized) {
      return;
    }
    
    this.isInitialized = true;
    
    // Access eventName from sandbox global context (available in VM sandbox)
    this.currentEventName = eventName;
    
    // Execute all handlers for the current event and wait for completion
    if (this.handlers[eventName] && this.handlers[eventName].length > 0) {
      await this.triggerImmediate(eventName);
    }
  }

  /**
   * Returns the currently executing event name (useful for debugging)
   * 
   * @returns {string|null} - The current event name or null if not initialized
   */
  getCurrentEventName() {
    return this.currentEventName;
  }

  /**
   * Checks if any handlers are registered for a specific event
   * 
   * @param {string} eventName - The event name to check
   * @returns {boolean} - True if handlers exist, false otherwise
   */
  hasHandlers(eventName) {
    return this.handlers[eventName] && this.handlers[eventName].length > 0;
  }



}

/**
 * SINGLETON INSTANCE EXPORT
 * =========================
 * 
 * ARCHITECTURE DECISION: We export a singleton instance rather than the class itself.
 * This ensures that all requires of this module share the same event state, which is
 * critical for cross-module event communication in sandboxed environments.
 * 
 * USAGE PATTERN:
 * const Event = require('./EventManager');
 * Event.on('ApiRun', async () => { ... });
 * await Event.init();
 */

// Create singleton instance of EventManager
const eventManager = new EventManager();

// Export the singleton instance for immediate use
module.exports = eventManager;
