/**
 * ProlibuService.js
 * Traducción de ProlibuService.cls (Apex) a JavaScript (Node.js).
 *
 * Dependencias:
 *   - Node.js 18+ (fetch nativo) o instalar node-fetch
 *   - sfConn: conexión jsforce (jsforce.Connection) que se pasa como parámetro
 *     a cada función para ejecutar las queries SOQL equivalentes.
 *
 * Notas de traducción:
 *   - HttpRequest / Http / HttpResponse  → fetch()
 *   - JSON.serialize()                   → JSON.stringify()
 *   - JSON.deserializeUntyped()          → JSON.parse()
 *   - Map<String, Object>                → objeto literal {}
 *   - List<T>                            → array []
 *   - Set<Id>                            → new Set()
 *   - System.debug()                     → console.debug()
 *   - EncodingUtil.urlEncode(x,'UTF-8')  → encodeURIComponent(x)
 *   - Database.setSavepoint/rollback     → try/catch nativo (sin savepoints en JS)
 *   - SOQL queries                       → sfConn.query() (jsforce)
 *   - Timezone offset (UserInfo)         → La REST API de Salesforce ya devuelve
 *     fechas en UTC (ISO 8601), por lo que la conversión manual de offset no es
 *     necesaria. Se conserva la lógica comentada por fidelidad al original.
 */

'use strict';

const BEARER_TOKEN = '75f5d6d9-022b-49a5-95d6-830f4cf4da03';
const BASE_URL     = 'https://coltugs.prolibu.com/v1/integration/saleforce';

// Equivalente al campo estático Set<Id> proposalsInProgress
const proposalsInProgress = new Set();

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function buildHeaders(method = 'POST') {
  const headers = {
    'Content-Type':   'application/json',
    'Authorization':  `Bearer ${BEARER_TOKEN}`,
    'Cache-Control':  'no-cache',
    'User-Agent':     'PostmanRuntime/7.37.3',
    'Accept':         '*/*',
    'Accept-Encoding':'gzip, deflate, br',
    'Connection':     'keep-alive',
  };
  return headers;
}

/**
 * Convierte una fecha de Salesforce a UTC.
 * La REST API de SF ya devuelve las fechas en UTC (ISO 8601), así que en la
 * mayoría de los casos basta con new Date(closeDateString).
 * Se mantiene la lógica de offset por fidelidad al comportamiento original.
 *
 * @param {string|Date} closeDate  Valor de CloseDate proveniente del registro SF
 * @returns {Date}
 */
function toUtcDate(closeDate) {
  // Apex original calculaba: utcDatetime = localDatetime.addSeconds(-offsetSeconds)
  // En JS, new Date() ya parsea ISO strings como UTC, por lo que el ajuste
  // de zona horaria del usuario no aplica aquí.
  return new Date(closeDate);
}

// ---------------------------------------------------------------------------
// createProposalLogic
// Equivalente a: public static void createProposalLogic(String oppId)
// ---------------------------------------------------------------------------

/**
 * Crea una propuesta en Prolibu a partir de una Oportunidad de Salesforce.
 *
 * @param {string}           oppId    Id de la Opportunity en Salesforce
 * @param {object}           sfConn   Conexión jsforce autenticada
 */
async function createProposalLogic(oppId, sfConn) {
  // Verificar si ya se está procesando esta oportunidad
  if (proposalsInProgress.has(oppId)) {
    return;
  }

  proposalsInProgress.add(oppId);

  try {
    // SOQL equivalente: query a Salesforce via REST API
    const oppResult = await sfConn.query(`
      SELECT Id, Name, StageName, Amount, CloseDate, Account.Name,
             Lead_Prolibu__c, Proposal_Created__c, Webhook_Updated__c,
             Owner.FirstName, Owner.LastName, Owner.Email, Owner.Phone,
             (SELECT Role, ContactId, Contact.FirstName, Contact.LastName,
                     Contact.Email, Contact.Phone
              FROM OpportunityContactRoles WHERE IsPrimary = true),
             (SELECT Product2.Name, Product2.ProductCode, Quantity, UnitPrice
              FROM OpportunityLineItems)
      FROM Opportunity
      WHERE Id = '${oppId}'
      LIMIT 1
    `);

    const opp = oppResult.records[0];

    // Verificar etapa y si la propuesta ya fue creada
    if (
      (opp.StageName !== 'Cotizado' && opp.StageName !== 'Proposal/Price Quote') ||
      opp.Proposal_Created__c
    ) {
      return;
    }

    // Evitar enviar el callout si la actualización vino del webhook
    if (opp.Webhook_Updated__c) {
      return;
    }

    // Construir payload
    const payload = {};
    payload.uuid = opp.Id;

    // Lead
    const lead = {};
    if (opp.Lead_Prolibu__c != null) {
      const contactResult = await sfConn.query(`
        SELECT Id, FirstName, LastName, Email, Phone
        FROM Contact
        WHERE Id = '${opp.Lead_Prolibu__c}'
        LIMIT 1
      `);
      const relatedContact = contactResult.records[0];
      lead.firstName = relatedContact.FirstName  ?? 'N/A';
      lead.lastName  = relatedContact.LastName   ?? 'N/A';
      lead.email     = relatedContact.Email?.includes('@')
        ? relatedContact.Email
        : 'invalid-email@example.com';
    } else {
      // Lead genérico si no hay contacto en Lead_Prolibu__c
      lead.firstName = 'Generic';
      lead.lastName  = 'Lead';
      lead.email     = 'generic-lead@example.com';
    }
    lead.companyName = opp.AccountId != null ? opp.Account.Name : 'N/A';
    payload.lead = lead;

    // Agent (Owner de la oportunidad)
    payload.agent = {
      firstName: opp.Owner.FirstName ?? 'N/A',
      lastName:  opp.Owner.LastName  ?? 'N/A',
      email:     opp.Owner.Email?.includes('@')
        ? opp.Owner.Email
        : 'invalid-agent-email@example.com',
    };

    // Data
    const data = {};
    data.title = opp.Name;
    data.expectedCloseDate = toUtcDate(opp.CloseDate);

    const products = (opp.OpportunityLineItems?.records ?? []).map(item => ({
      name:     item.Product2.Name,
      sku:      item.Product2.ProductCode,
      quantity: item.Quantity,
      price:    item.UnitPrice,
    }));
    data.products = products;
    payload.data  = data;

    // POST a Prolibu
    const res = await fetch(BASE_URL, {
      method:  'POST',
      headers: buildHeaders('POST'),
      body:    JSON.stringify(payload),
    });

    const responseBody = await res.json();
    const responseUrl  = responseBody.anonymousUrl;

    // Actualizar la oportunidad en Salesforce
    // Equivale a: update new Opportunity(Id=..., Propuesta_Prolibu__c=..., ...)
    try {
      await sfConn.sobject('Opportunity').update({
        Id:                  opp.Id,
        Propuesta_Prolibu__c: responseUrl,
        Proposal_Created__c:  true,
        Webhook_Updated__c:   false,
      });
    } catch (dmlEx) {
      // Equivale a: Database.rollback(sp) — en JS no hay savepoints nativos
      console.debug('Error al actualizar la oportunidad:', dmlEx.message);
    }
  } catch (e) {
    console.debug('Excepción al enviar la propuesta al endpoint real:', e.message);
  } finally {
    proposalsInProgress.delete(oppId);
  }
}

// ---------------------------------------------------------------------------
// changeOpportunityStatusLogic
// Equivalente a: public static void changeOpportunityStatusLogic(String, String, String)
// ---------------------------------------------------------------------------

/**
 * Cambia el estado de una oportunidad en Prolibu.
 *
 * @param {string}      oppId       Id de la Opportunity
 * @param {string}      status      Nuevo estado
 * @param {string|null} lossReason  Motivo de pérdida (opcional)
 */
async function changeOpportunityStatusLogic(oppId, status, lossReason) {
  try {
    const endpoint = `${BASE_URL}/changeStatus/${oppId}/${status}`;

    const requestBody = { status };
    if (lossReason != null && lossReason !== '') {
      requestBody.lossReason = lossReason;
    }

    const res = await fetch(endpoint, {
      method:  'PUT',
      headers: buildHeaders('PUT'),
      body:    JSON.stringify(requestBody),
    });

    if (res.status === 200) {
      console.debug('Cambio de estado enviado con éxito:', status);
    } else {
      const body = await res.text();
      console.debug('Error al cambiar el estado:', body);
    }
  } catch (e) {
    console.debug('Excepción al cambiar el estado:', e.message);
  }
}

// ---------------------------------------------------------------------------
// updateProposalLogic
// Equivalente a: public static void updateProposalLogic(String oppId)
// ---------------------------------------------------------------------------

/**
 * Actualiza una propuesta existente en Prolibu.
 *
 * @param {string} oppId   Id de la Opportunity
 * @param {object} sfConn  Conexión jsforce autenticada
 */
async function updateProposalLogic(oppId, sfConn) {
  try {
    const oppResult = await sfConn.query(`
      SELECT Id, Name, Amount, CloseDate, Account.Name, Lead_Prolibu__c,
             Webhook_Updated__c,
             Owner.FirstName, Owner.LastName, Owner.Email, Owner.Phone,
             (SELECT Role, ContactId, Contact.FirstName, Contact.LastName,
                     Contact.Email, Contact.Phone
              FROM OpportunityContactRoles WHERE IsPrimary = true),
             (SELECT Product2.Name, Product2.ProductCode, Quantity, UnitPrice
              FROM OpportunityLineItems)
      FROM Opportunity
      WHERE Id = '${oppId}'
      LIMIT 1
    `);

    const opp = oppResult.records[0];

    // Verificar si la oportunidad fue actualizada por el webhook
    if (opp.Webhook_Updated__c) {
      return;
    }

    const endpoint = `${BASE_URL}/${oppId}`;

    const payload = {};
    payload.uuid = opp.Id;

    // Lead
    if (opp.Lead_Prolibu__c != null) {
      const contactResult = await sfConn.query(`
        SELECT Id, FirstName, LastName, Email, Phone
        FROM Contact
        WHERE Id = '${opp.Lead_Prolibu__c}'
        LIMIT 1
      `);
      const relatedLead = contactResult.records[0];
      payload.lead = {
        firstName: relatedLead.FirstName ?? 'N/A',
        lastName:  relatedLead.LastName  ?? 'N/A',
        email:     relatedLead.Email?.includes('@')
          ? relatedLead.Email
          : 'invalid-email@example.com',
      };
    }

    // Agent
    payload.agent = {
      firstName: opp.Owner.FirstName ?? 'N/A',
      lastName:  opp.Owner.LastName  ?? 'N/A',
      email:     opp.Owner.Email?.includes('@')
        ? opp.Owner.Email
        : 'invalid-agent-email@example.com',
    };

    // Data
    const products = [];
    const lineItems = opp.OpportunityLineItems?.records ?? [];
    if (lineItems.length > 0) {
      for (const item of lineItems) {
        products.push({
          name:     item.Product2.Name,
          sku:      item.Product2.ProductCode,
          quantity: item.Quantity,
          price:    item.UnitPrice,
        });
      }
    }

    payload.data = {
      title:             opp.Name,
      expectedCloseDate: toUtcDate(opp.CloseDate),
      products,
    };

    const res = await fetch(endpoint, {
      method:  'PUT',
      headers: buildHeaders('PUT'),
      body:    JSON.stringify(payload),
    });

    if (res.status === 200) {
      console.debug('Propuesta actualizada con éxito en el endpoint real.');
    } else {
      const body = await res.text();
      console.debug('Error al actualizar la propuesta en el endpoint real:', body);
    }
  } catch (e) {
    console.debug('Excepción al actualizar la propuesta:', e.message);
  }
}

// ---------------------------------------------------------------------------
// sendDenialReasonLogic
// Equivalente a: public static void sendDenialReasonLogic(String, String)
// ---------------------------------------------------------------------------

/**
 * Envía el motivo de denegación de una oportunidad a Prolibu.
 *
 * @param {string} oppId        Id de la Opportunity
 * @param {string} denialReason Motivo de denegación
 */
async function sendDenialReasonLogic(oppId, denialReason) {
  try {
    // EncodingUtil.urlEncode(denialReason, 'UTF-8') → encodeURIComponent()
    const endpoint = `${BASE_URL}/denialReason/${oppId}/${encodeURIComponent(denialReason)}`;

    const res = await fetch(endpoint, {
      method:  'PUT',
      headers: buildHeaders('PUT'),
    });

    if (res.status === 200) {
      console.debug('Motivo de denegación enviado con éxito para la oportunidad:', oppId);
    } else {
      const body = await res.text();
      console.debug('Error al enviar el motivo de denegación:', body);
    }
  } catch (e) {
    console.debug('Excepción al enviar el motivo de denegación:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createProposalLogic,
  changeOpportunityStatusLogic,
  updateProposalLogic,
  sendDenialReasonLogic,
};
