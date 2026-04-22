#!/usr/bin/env node

/**
 * Validate Deal Migration: SF Opportunity → Prolibu Deal
 *
 * Fetches source data from Salesforce (Opportunity + Quote + QuoteLineItems)
 * and the resulting deal from Prolibu, then compares field by field.
 *
 * Usage:
 *   node scripts/validate-deal-migration.js [SF_OPPORTUNITY_ID]
 *
 * Defaults to 006PO000007vvVOYAY if no ID is provided.
 */

const SalesforceApi = require('../lib/vendors/salesforce/SalesforceApi');
const ProlibuApi = require('../lib/vendors/prolibu/ProlibuApi');
const creds = require('../accounts/stg.prolibu.com/migrations/salesforce/credentials.json');
const profile = require('../accounts/stg.prolibu.com/profile.json');

const OPP_ID = process.argv[2] || '006PO000007vvVOYAY';

async function main() {
    const sf = new SalesforceApi({
        instanceUrl: creds.instanceUrl,
        customerKey: creds.clientKey,
        customerSecret: creds.clientSecret,
    });

    const prolibu = new ProlibuApi({
        domain: 'stg.prolibu.com',
        apiKey: profile.apiKey,
    });

    // --- 1. Fetch SF source data ---
    console.log(`\n=== Fetching SF Opportunity ${OPP_ID} ===\n`);

    const oppResult = await sf.query(
        `SELECT Id, Name, StageName, CloseDate, Amount, Description, AccountId, ContactId
     FROM Opportunity WHERE Id = '${OPP_ID}'`
    );
    const opp = oppResult.data?.[0];
    if (!opp) {
        console.error('Opportunity not found in Salesforce');
        process.exit(1);
    }
    console.log(`Opportunity: ${opp.Name} (Stage: ${opp.StageName}, Amount: ${opp.Amount})`);

    // Fetch latest Quote
    const quoteResult = await sf.query(
        `SELECT Id, Name, QuoteNumber, Status, ExpirationDate, GrandTotal, Discount, Tax, ShippingHandling, Description
     FROM Quote WHERE OpportunityId = '${OPP_ID}' ORDER BY CreatedDate DESC LIMIT 1`
    );
    const quote = quoteResult.data?.[0];
    if (!quote) {
        console.error('No Quote found for this Opportunity');
        process.exit(1);
    }
    console.log(`Quote: ${quote.Name} (#${quote.QuoteNumber}, Status: ${quote.Status})`);

    // Fetch QuoteLineItems
    const lineItemResult = await sf.query(
        `SELECT Id, Quantity, UnitPrice, TotalPrice, Discount, Description,
            Product2Id, Product2.Name, Product2.ProductCode, PricebookEntryId, ServiceDate
     FROM QuoteLineItem WHERE QuoteId = '${quote.Id}' ORDER BY Id`
    );
    const lineItems = lineItemResult.data || [];
    console.log(`QuoteLineItems: ${lineItems.length}`);

    // --- 2. Fetch Prolibu deal by refId ---
    console.log(`\n=== Fetching Prolibu Deal (refId: ${OPP_ID}) ===\n`);

    const dealResult = await prolibu.find('deal', {
        xquery: { refId: OPP_ID },
        limit: 1,
    });
    const deals = Array.isArray(dealResult) ? dealResult : (dealResult?.data || dealResult?.docs || []);
    const deal = deals[0];
    if (!deal) {
        console.error('Deal not found in Prolibu');
        process.exit(1);
    }
    console.log(`Deal: ${deal.dealName} (_id: ${deal._id})`);

    // --- 3. Compare ---
    console.log('\n=== Comparison Results ===\n');

    const results = [];

    function compare(label, sfVal, pVal) {
        // Normalize: null/undefined → null for comparison
        const a = sfVal ?? null;
        const b = pVal ?? null;
        const match = String(a) === String(b);
        results.push({ label, sf: a, prolibu: b, match });
    }

    // --- Deal-level fields ---
    compare('dealName', opp.Name?.trim(), deal.dealName);
    compare('refId', opp.Id, deal.refId);
    compare('observations', opp.Description, deal.observations);

    // --- Quote-level fields ---
    const pq = deal.proposal?.quote || {};
    compare('quote.quoteName', quote.Name, pq.quoteName);
    compare('quote.quoteCode', quote.QuoteNumber, pq.quoteCode);
    compare('quote.discountRate', quote.Discount != null ? quote.Discount / 100 : null, pq.discountRate);
    compare('quote.shippingHandling', quote.ShippingHandling, pq.shippingHandling);
    compare('quote.quoteDescription', quote.Description, pq.quoteDescription);
    compare('quote.quoteCurrency', 'COP', pq.quoteCurrency);

    // --- LineItems ---
    const pLineItems = deal.proposal?.quote?.lineItems || [];
    compare('lineItems.count', lineItems.length, pLineItems.length);

    // Match line items by externalId (SF QuoteLineItem.Id)
    let itemMatches = 0;
    let itemMismatches = 0;
    const itemDetails = [];

    for (const sfItem of lineItems) {
        const pItem = pLineItems.find(li => li.externalId === sfItem.Id);
        if (!pItem) {
            itemDetails.push({ sfId: sfItem.Id, productName: sfItem.Product2?.Name, error: 'NOT FOUND in Prolibu' });
            itemMismatches++;
            continue;
        }

        const checks = [];
        function checkField(label, sfVal, pVal) {
            const a = sfVal ?? null;
            const b = pVal ?? null;
            const ok = String(a) === String(b);
            checks.push({ label, sf: a, prolibu: b, match: ok });
            if (!ok) itemMismatches++;
            else itemMatches++;
        }

        checkField('productName', sfItem.Product2?.Name, pItem.productName);
        checkField('productCode', sfItem.Product2?.ProductCode, pItem.productCode);
        checkField('quantity', sfItem.Quantity, pItem.quantity);
        checkField('price', sfItem.UnitPrice, pItem.price);
        checkField('discountRate', sfItem.Discount, pItem.discountRate);
        checkField('description', sfItem.Description, pItem.description);
        checkField('currency', 'COP', pItem.currency);

        const failedChecks = checks.filter(c => !c.match);
        if (failedChecks.length > 0) {
            itemDetails.push({
                sfId: sfItem.Id,
                productName: sfItem.Product2?.Name,
                mismatches: failedChecks,
            });
        }
    }

    // --- Print deal-level results ---
    console.log('--- Deal & Quote Fields ---\n');
    const maxLabel = Math.max(...results.map(r => r.label.length));
    for (const r of results) {
        const icon = r.match ? '✅' : '❌';
        const pad = r.label.padEnd(maxLabel + 2);
        if (r.match) {
            console.log(`  ${icon} ${pad} ${r.sf}`);
        } else {
            console.log(`  ${icon} ${pad} SF: ${r.sf}  |  Prolibu: ${r.prolibu}`);
        }
    }

    // --- Print line-item summary ---
    console.log(`\n--- LineItems (${lineItems.length} items) ---\n`);
    console.log(`  Matched fields:    ${itemMatches}`);
    console.log(`  Mismatched fields: ${itemMismatches}`);

    if (itemDetails.length > 0) {
        console.log('\n  Issues:');
        for (const d of itemDetails) {
            if (d.error) {
                console.log(`    ❌ ${d.productName || d.sfId}: ${d.error}`);
            } else {
                for (const m of d.mismatches) {
                    console.log(`    ❌ ${d.productName} → ${m.label}: SF=${m.sf} | Prolibu=${m.prolibu}`);
                }
            }
        }
    }

    // --- Final verdict ---
    const dealFails = results.filter(r => !r.match).length;
    const totalFails = dealFails + itemMismatches;
    console.log(`\n=== ${totalFails === 0 ? '✅ ALL PASSED' : `❌ ${totalFails} MISMATCHES`} ===\n`);

    process.exit(totalFails === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
