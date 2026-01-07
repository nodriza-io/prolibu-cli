/**
 * Configuration Schema Validator for DataMapper
 * Validates the new array-based object configuration format
 * 
 * @author Juan Carlos Prieto
 */

class ConfigValidator {
  /**
   * Schema definition for object configuration
   */
  static CONFIG_SCHEMA = {
    source: { type: 'string', required: true },
    target: { type: 'string', required: true },
    active: { type: 'boolean', default: true },
    map: { type: 'object', required: true },
    globalTransforms: { type: 'object', default: {} },
    globalAfterTransforms: { type: 'object', default: {} },
    globalPreMapping: { type: 'function', default: null },
    globalPostMapping: { type: 'function', default: null },
    events: {
      type: 'array',
      required: true,
      items: {
        name: { type: 'string', required: true, enum: ['beforeCreate', 'beforeUpdate', 'afterCreate', 'afterUpdate', 'afterDelete'] },
        handler: { type: 'function', required: true },
        transforms: { type: 'object', default: {} },
        afterTransforms: { type: 'object', default: {} },
        preMapping: { type: 'function', default: null },
        postMapping: { type: 'function', default: null }
      }
    }
  };

  /**
   * Validates an array of object configurations
   * @param {Array} configs - Array of object configurations
   * @returns {Array} - Validated and normalized configurations
   * @throws {Error} - If validation fails
   */
  static validateConfigs(configs) {
    if (!Array.isArray(configs)) {
      throw new Error('ConfigValidator: configs must be an array');
    }

    if (configs.length === 0) {
      throw new Error('ConfigValidator: configs array cannot be empty');
    }

    return configs.map((config, index) => {
      try {
        return this.validateConfig(config);
      } catch (error) {
        throw new Error(`ConfigValidator: Error in config[${index}] (${config.source || 'unknown'}): ${error.message}`);
      }
    });
  }

  /**
   * Validates a single object configuration
   * @param {Object} config - Object configuration
   * @returns {Object} - Validated and normalized configuration
   * @throws {Error} - If validation fails
   */
  static validateConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('Config must be a valid object');
    }

    const validated = {};

    // Validate root level properties
    for (const [key, schema] of Object.entries(this.CONFIG_SCHEMA)) {
      if (key === 'events') continue; // Handle events separately

      const value = config[key];

      if (schema.required && (value === undefined || value === null)) {
        throw new Error(`Required field '${key}' is missing`);
      }

      if (value !== undefined) {
        this.validateType(value, schema, key);
        validated[key] = value;
      } else if (schema.default !== undefined) {
        validated[key] = schema.default;
      }
    }

    // Validate events array
    if (!config.events || !Array.isArray(config.events)) {
      throw new Error('events must be an array');
    }

    if (config.events.length === 0) {
      throw new Error('events array cannot be empty');
    }

    validated.events = config.events.map((event, eventIndex) => {
      try {
        return this.validateEvent(event);
      } catch (error) {
        throw new Error(`Error in events[${eventIndex}]: ${error.message}`);
      }
    });

    // Check for duplicate event names
    const eventNames = validated.events.map(e => e.name);
    const duplicates = eventNames.filter((name, index) => eventNames.indexOf(name) !== index);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate event names found: ${duplicates.join(', ')}`);
    }

    return validated;
  }

  /**
   * Validates a single event configuration
   * @param {Object} event - Event configuration
   * @returns {Object} - Validated and normalized event
   * @throws {Error} - If validation fails
   */
  static validateEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new Error('Event must be a valid object');
    }

    const validated = {};
    const eventSchema = this.CONFIG_SCHEMA.events.items;

    for (const [key, schema] of Object.entries(eventSchema)) {
      const value = event[key];

      if (schema.required && (value === undefined || value === null)) {
        throw new Error(`Required field '${key}' is missing`);
      }

      if (value !== undefined) {
        this.validateType(value, schema, key);
        validated[key] = value;
      } else if (schema.default !== undefined) {
        validated[key] = schema.default;
      }
    }

    return validated;
  }

  /**
   * Validates value type against schema
   * @param {*} value - Value to validate
   * @param {Object} schema - Schema definition
   * @param {string} fieldName - Field name for error messages
   * @throws {Error} - If validation fails
   */
  static validateType(value, schema, fieldName) {
    switch (schema.type) {
      case 'string':
        if (typeof value !== 'string') {
          throw new Error(`Field '${fieldName}' must be a string`);
        }
        if (schema.enum && !schema.enum.includes(value)) {
          throw new Error(`Field '${fieldName}' must be one of: ${schema.enum.join(', ')}`);
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`Field '${fieldName}' must be a boolean`);
        }
        break;

      case 'object':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error(`Field '${fieldName}' must be an object`);
        }
        break;

      case 'function':
        if (typeof value !== 'function') {
          throw new Error(`Field '${fieldName}' must be a function`);
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          throw new Error(`Field '${fieldName}' must be an array`);
        }
        break;

      default:
        throw new Error(`Unknown type '${schema.type}' for field '${fieldName}'`);
    }
  }

  /**
   * Resolves transforms for a specific event by merging global and event-specific transforms
   * Priority: event transforms override global transforms
   * @param {Object} config - Object configuration
   * @param {Object} event - Event configuration
   * @returns {Object} - { transforms, afterTransforms }
   */
  static resolveTransforms(config, event) {
    const transforms = {
      // If event has transforms defined, use only those (override strategy)
      // If event.transforms is empty object, use globalTransforms
      ...((Object.keys(event.transforms || {}).length > 0) ? event.transforms : config.globalTransforms),
    };

    const afterTransforms = {
      // Same strategy for afterTransforms
      ...((Object.keys(event.afterTransforms || {}).length > 0) ? event.afterTransforms : config.globalAfterTransforms),
    };

    return { transforms, afterTransforms };
  }
}

module.exports = ConfigValidator;