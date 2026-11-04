


# Prolibu REST API Client Libraries

This folder provides robust, production-ready libraries for interacting with Prolibu's REST API from your scripts. All modules are designed for advanced usage, error handling, and extensibility.

## How the REST Library Works

`ProlibuApi` provides a unified interface for CRUD operations and advanced queries on any Prolibu model. Create it with an API key (`new ProlibuApi({ apiKey, domain })`; `domain` defaults to the script's `localDomain`). Each instance builds its own client from the sandbox's global `axios` with `Authorization: Bearer <apiKey>`, and its methods return parsed data directly. A script has no identity of its own: keep the key in the script's `variables`. Errors are thrown as standardized `Error` objects (see [Error Handling](#error-handling)).

Methods: `create`, `findOne` (returns `null` on 404), `find`, `update`, `delete` (returns `false` on 404), `search`, `findOneOrCreate`.

### Supported Query Parameters
- `page`: Page number (integer)
- `limit`: Items per page (integer)
- `sort`: Sort order (string, e.g. '-createdAt')
- `select`: Fields to include/exclude (string)
- `xquery`: Advanced filter object (will be JSON.stringified)
- `populatePath`: Deep populate related models (array, will be JSON.stringified)
- Any other query param supported by the API

## REST Library Examples

```js
// From accounts/<your-domain>/scripts/<prefix>/index.js the repo's lib/ is four levels up
const ProlibuApi = require('../../../../lib/vendors/prolibu/ProlibuApi');
const { getRequiredVars } = require('../../../../lib/utils/variables');

(async function() {
	try {
		const { apiKey } = getRequiredVars({ apiKey: 'prolibu-api-key' });
		const api = new ProlibuApi({ apiKey });

		// CREATE: Add a new contact
		const newContact = await api.create('contact', {
			firstName: 'John',
			lastName: 'Doe',
			email: 'john.doe@example.com',
			company: '<companyId>'
		});
		console.log('Created contact:', newContact);

		// UPDATE: Update a contact by ID
		const updatedContact = await api.update('contact', newContact._id, {
			lastName: 'Smith'
		});
		console.log('Updated contact:', updatedContact);

		// FINDONE: Get a contact by ID with deep populate and select
		const contact = await api.findOne('contact', newContact._id, {
			populatePath: [
				{ path: 'company', select: 'companyName' }
			],
			select: 'firstName lastName company'
		});
		console.log('Contact:', contact);

		// FIND: Get contacts with pagination, sorting, and filtering
		const contacts = await api.find('contact', {
			page: 1,
			limit: 10,
			sort: '-createdAt',
			xquery: { lastName: 'Smith' },
			select: 'firstName lastName',
			populatePath: [ { path: 'company', select: 'companyName' } ]
		});
		console.log('Contacts:', contacts);

		// DELETE: Remove a contact by ID
		const deleted = await api.delete('contact', newContact._id);
		console.log('Deleted contact:', deleted);

		// SEARCH: Search contacts by term with extra query params
		const searchResults = await api.search('contact', 'john', {
			limit: 5,
			sort: 'lastName',
			select: 'firstName lastName',
		});
		console.log('Search results:', searchResults);

	} catch (err) {
		// Standardized error handling
		console.error('API call error:', err.message);
		// Access err.type, err.statusCode, err.details for diagnostics
	}
})();
```

## User Library Example

```js
const UserApi = require('../../../../lib/vendors/prolibu/UserApi');
const { getRequiredVars } = require('../../../../lib/utils/variables');

(async function() {
	try {
		const { apiKey } = getRequiredVars({ apiKey: 'prolibu-api-key' });
		const users = new UserApi({ apiKey });
		const me = await users.me();
		console.log('Current user:', me);
	} catch (err) {
		console.error('API call error:', err.message);
	}
})();
```

## Utilities

### getVariable(key)
Get the value of a variable from the execution context. It lives in `lib/utils/variables.js`, next to `getRequiredVars({ name: 'variable-key' })`, which throws when a variable is missing.

## Error Handling
All methods throw a native `Error` with these properties:
- `type`: 'http', 'network', 'unknown'
- `statusCode`: HTTP code if applicable, otherwise `null`
- `message`: readable message, e.g. `[http 400] <server error>`
- `details`: server response body if present
- `originalError`: the underlying axios error

## Requirements
The environment must provide the global `axios` (the script sandbox does) and an API key, which you pass to the constructor. `domain` defaults to the sandbox's `localDomain`; pass it explicitly outside a script (for example in jest tests).

---
For questions, improvements, or advanced usage, review the source code of each module.
